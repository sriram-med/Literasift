import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, SCREENER, QC, makeEnv, withFetch } from "./helpers.mjs";

const PROFILES = [{ email: MANAGER, name: "Boss", role: "manager", active: true }, { email: SCREENER, name: "Asha", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }];
const J = o => new Response(JSON.stringify(o), { status: 200 });
function world() {
  const seen = [];
  const handler = async url => {
    const u = new URL(String(url)); seen.push(u.host + u.pathname + "?" + u.searchParams.toString());
    if (u.host === "api.openalex.org") return J({ results: [{ id: "W1", doi: "https://doi.org/10.1000/aaa", display_name: "Aciclovir neurotoxicity in renal failure: a Japanese case series", publication_year: 2025, authorships: [{ author: { display_name: "K Tanaka" }, countries: ["JP"] }, { author: { display_name: "M Sato" }, countries: ["JP"] }], primary_location: { source: { display_name: "Japanese Journal of Nephrology" }, landing_page_url: "https://example.jp/a" }, abstract_inverted_index: { A: [0], 68: [1], "year-old": [2], man: [3], developed: [4], confusion: [5] }, ids: { pmid: "https://pubmed.ncbi.nlm.nih.gov/12345/" }, language: "ja" }] });
    if (u.host === "clinicaltrials.gov") return J({ studies: [{ protocolSection: { identificationModule: { nctId: "NCT01", briefTitle: "Aciclovir dosing in renal impairment" }, statusModule: { overallStatus: "COMPLETED", startDateStruct: { date: "2023-04" } }, descriptionModule: { briefSummary: "Dose adjustment." } } }] });
    if (u.host === "www.gov.uk") return J({ results: [{ title: "Aciclovir: neurological reactions", description: "Drug Safety Update", link: "/drug-safety-update/aciclovir", public_timestamp: "2025-03-10T09:00:00Z", format: "drug_safety_update" }] });
    if (u.host === "api.fda.gov" && u.pathname.includes("enforcement")) return J({ results: [{ product_description: "Aciclovir tablets 400 mg", classification: "Class II", recalling_firm: "Acme Generics", reason_for_recall: "Failed dissolution", report_date: "20250215", status: "Ongoing" }] });
    if (u.host === "eutils.ncbi.nlm.nih.gov") return J({ esearchresult: { idlist: [] } });
    return new Response("{}", { status: 404 });
  };
  return { handler, seen };
}

test("worldwide search: regional literature, trials and regulator notices come back in one list with their region, language and source, and the filters reach the right APIs", async () => {
  const t = await makeEnv({ profiles: PROFILES, watches: [{ portfolio: "Antivirals", molecule: "aciclovir", query: "q" }], settings: {} }), w = world();
  const r = await withFetch(w.handler, () => t.call(SCREENER, "/api/discover", { q: '("aciclovir" OR "Zovirax")', terms: ["aciclovir", "Zovirax"], sources: ["openalex", "clinicaltrials", "mhra", "fdarecall"], from: "2025-01-01", to: "2025-12-31", countries: ["JP", "KR"], language: "ja", limit: 10 }));
  assert.equal(r.status, 200, JSON.stringify(r.body)); const by = Object.fromEntries(r.body.sources.map(s => [s.source, s])); for (const k of ["openalex", "clinicaltrials", "mhra", "fdarecall"]) assert.ok(by[k].ok && by[k].count === 1, k + " " + JSON.stringify(by[k]));
  const oa = r.body.results.find(x => x.sources.includes("openalex")); assert.equal(oa.pmid, "12345"); assert.deepEqual(oa.countries, ["JP"]); assert.equal(oa.language, "ja"); assert.match(oa.abstract, /developed confusion/); assert.equal(oa.doi, "10.1000/aaa");
  assert.ok(r.body.results.some(x => x.sources.includes("mhra") && x.countries.includes("GB") && /gov\.uk/.test(x.url))); assert.ok(r.body.results.some(x => x.sources.includes("fdarecall") && /^Recall:/.test(x.title)));
  const oaCall = w.seen.find(x => x.startsWith("api.openalex.org")); assert.match(decodeURIComponent(oaCall), /authorships\.countries:JP\|KR/); assert.match(decodeURIComponent(oaCall), /language:ja/); assert.match(decodeURIComponent(oaCall), /from_publication_date:2025-01-01/);
  assert.match(decodeURIComponent(w.seen.find(x => x.startsWith("www.gov.uk"))), /q=aciclovir/, "regulators are searched by the INN, not the boolean text");
  assert.match(w.seen.find(x => x.startsWith("api.fda.gov")), /report_date/);
});

test("a source that fails or needs a key does not sink the search", async () => {
  const t = await makeEnv({ profiles: PROFILES, watches: [{ portfolio: "Antivirals", molecule: "aciclovir", query: "q" }] }), w = world();
  const r = await withFetch(w.handler, () => t.call(SCREENER, "/api/discover", { q: "aciclovir", sources: ["openalex", "core", "doaj"], limit: 5 })); assert.equal(r.status, 200);
  const by = Object.fromEntries(r.body.sources.map(s => [s.source, s])); assert.ok(by.openalex.ok); assert.equal(by.core.ok, false); assert.match(by.core.error, /CORE API key/); assert.equal(by.doaj.ok, false);
  assert.ok(r.body.results.length >= 1);
});

test("results from any source are added to the queue: own portfolio only, one article per record, nothing duplicated, regulator notices are labelled", async () => {
  const t = await makeEnv({ profiles: PROFILES, watches: [{ portfolio: "Antivirals", molecule: "aciclovir", query: "q" }, { portfolio: "Oncology", molecule: "imatinib", query: "q2" }] });
  const recs = [{ title: "Aciclovir neurotoxicity in renal failure: a Japanese case series", doi: "10.1000/aaa", pmid: "", authors: ["K Tanaka"], journal: "Jpn J Nephrol", year: "2025", abstract: "A 68-year-old man developed confusion.", sources: ["openalex"], countries: ["JP"], language: "ja", url: "https://example.jp/a" }, { title: "Aciclovir: neurological reactions", authors: ["MHRA"], journal: "UK MHRA", year: "2025", abstract: "Drug Safety Update", sources: ["mhra"], countries: ["GB"], date: "2025-03-10", url: "https://www.gov.uk/x" }];
  assert.equal((await t.call(SCREENER, "/api/sources-add", { records: recs, portfolio: "Oncology", molecule: "aciclovir" })).status, 403, "not their portfolio");
  const a = await t.call(SCREENER, "/api/sources-add", { records: recs, portfolio: "Antivirals", molecule: "aciclovir" }); assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(a.body.added, 2);
  const s = await t.state(); assert.equal(s.assignments.length, 2); assert.ok(s.assignments.every(x => x.reviewer === SCREENER && x.ird && x.dueAt && x.portfolio === "Antivirals"));
  const arts = Object.values(s.articles); assert.ok(arts.some(x => x.source === "OpenAlex" && x.doi === "10.1000/aaa" && x.country === "JP")); assert.ok(arts.some(x => x.source === "MHRA" && x.date === "2025-03-10"));
  const again = await t.call(SCREENER, "/api/sources-add", { records: recs, portfolio: "Antivirals", molecule: "aciclovir" }); assert.equal(again.body.added, 0); assert.equal(again.body.skipped.length, 2); assert.equal((await t.state()).assignments.length, 2);
  const mgr = await t.call(MANAGER, "/api/sources-add", { records: [recs[0]], portfolio: "Oncology", molecule: "aciclovir" }); assert.equal(mgr.status, 200); assert.equal(Object.keys((await t.state()).articles).length, 2, "the same article is reused in a second portfolio");
  assert.equal((await t.call(SCREENER, "/api/sources-add", { records: [], portfolio: "Antivirals" })).status, 400);
});
