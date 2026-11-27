// Integrations ported from open-source projects: Lixplore search + Unpaywall, pv-case-triage-agents, drug-adverse-event-explorer, drug-causality-bert-v2. Fake services stand in for the internet.
import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, SCREENER, SCREENER2, makeEnv, withFetch } from "./helpers.mjs";
import worker from "../worker/index.js";

const J = o => new Response(JSON.stringify(o), { status: 200 }), hosts = new Set();
function fakeWeb({ doajDown = false } = {}) {
  const calls = [];
  const handler = async (url, init = {}) => { const u = new URL(String(url)); hosts.add(u.host); calls.push({ url: String(url), init }); const q = u.searchParams;
    if (u.host === "eutils.ncbi.nlm.nih.gov") { if (u.pathname.endsWith("esearch.fcgi")) return J({ esearchresult: { count: "1", idlist: ["555"] } }); if (u.pathname.endsWith("esummary.fcgi")) return J({ result: { uids: ["555"], 555: { title: "Aripiprazole and akathisia: a case report.", fulljournalname: "Case Rep Psychiatry", pubdate: "2024 Mar", authors: [{ name: "Nair R" }, { name: "Iyer S" }], articleids: [{ idtype: "doi", value: "10.1000/akath.1" }, { idtype: "pmc", value: "PMC999" }] } } }); }
    if (u.host === "www.ebi.ac.uk") return J({ resultList: { result: [{ title: "Aripiprazole and akathisia: a case report", authorString: "Nair R, Iyer S", journalTitle: "Case Rep Psychiatry", pubYear: "2024", doi: "10.1000/AKATH.1", pmid: "555", pmcid: "PMC999", abstractText: "<p>A woman developed akathisia.</p>" }, { title: "Long-acting aripiprazole review", authorString: "Mehta V", journalTitle: "J Psychopharmacol", pubYear: "2022", doi: "10.1000/lai.2" }] } });
    if (u.host === "api.crossref.org") return J({ message: { items: [{ DOI: "10.1000/akath.1", title: ["Aripiprazole and akathisia: a case report"], author: [{ given: "R", family: "Nair" }], "container-title": ["Case Rep Psychiatry"], published: { "date-parts": [[2024]] }, URL: "https://doi.org/10.1000/akath.1" }, { DOI: "10.1000/other.3", title: ["Something else entirely"], author: [], published: { "date-parts": [[2020]] } }] } });
    if (u.host === "doaj.org") return doajDown ? new Response("down", { status: 503 }) : J({ results: [{ bibjson: { title: "Open access akathisia study", author: [{ name: "Khan Z" }], journal: { title: "OA Journal" }, year: "2021", identifier: [{ type: "doi", id: "10.1000/oa.4" }], link: [{ type: "fulltext", url: "https://oa.example.org/4" }] } }] });
    if (u.host === "api.unpaywall.org") { const doi = decodeURIComponent(u.pathname.split("/v2/")[1]); if (doi === "10.1000/akath.1") return J({ is_oa: true, oa_status: "gold", journal_is_oa: true, best_oa_location: { license: "cc-by", version: "publishedVersion", host_type: "publisher", url_for_pdf: "https://oa.example.org/akath.pdf", url_for_landing_page: "https://oa.example.org/akath" }, oa_locations: [{}, {}] }); return new Response("", { status: 404 }); }
    return new Response("", { status: 404 }); };
  return { handler, calls };
}
const f = x => ({ value: x });
const mkCase = (id, number, pmid, o = {}) => ({ id, number, pmid, portfolio: "CNS", molecule: "aripiprazole", status: "Draft", assignee: SCREENER, createdBy: SCREENER, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01", history: [], versions: [], stage: "medical_review",
  data: { patient: { identifier: f("P1"), age: f("31"), sex: f("Female"), medical_history: [] }, reporter: { qualification: f("Physician"), country: f("India") }, dates: { awareness: f("2026-11-20") }, treatment_given: [], confounders: [], products: [{ name: f("aripiprazole"), role: "suspect", start_day: 1, indication: f("schizophrenia"), action_taken: f("Drug withdrawn"), dechallenge: f(o.dc ?? "Positive: the event resolved"), rechallenge: f(o.rc ?? "") }], events: [{ verbatim: { value: "akathisia", evidence: [{ excerpt: "The patient (contact Dr. Alan Smith, MRN: 0048291) developed akathisia." }] }, onset_day: o.onset ?? 3, seriousness: o.ser || {}, listedness: f(o.listed ?? "Listed"), expectedness: f(o.listed ?? "Listed"), alternative_causes: f(o.alt ?? ""), objective_evidence: f(o.obj ?? "") }] } });
async function setup(extraEnv = {}) {
  const t = await makeEnv({ profiles: [{ email: MANAGER, name: "Boss", role: "manager", active: true }, { email: SCREENER, name: "Asha", role: "reviewer", portfolio: "CNS", active: true, capacity: 50 }, { email: SCREENER2, name: "Ravi", role: "reviewer", portfolio: "Other", active: true, capacity: 50 }],
    settings: { unpaywallEmail: "team@example.org" }, watches: [{ portfolio: "CNS", molecule: "aripiprazole", query: "q" }], articles: { 555: { id: "555", title: "Aripiprazole and akathisia: a case report", doi: "10.1000/akath.1", authors: ["Nair R"], journal: "Case Rep Psychiatry", date: "2024" } },
    assignments: [{ id: "a1", pmid: "555", portfolio: "CNS", molecules: ["aripiprazole"], reviewer: SCREENER, status: "Pending" }] }, extraEnv);
  const s = await t.state(); s.cases = [mkCase("c1", "LS-1", "555", { ser: { serious: true, hospitalization: true }, listed: "Unlisted" }), mkCase("c2", "LS-2", "555"), mkCase("c3", "LS-3", "555", { dc: "" })]; s.cases[2].data.events[0].verbatim.evidence = []; await t.BUCKET.put("bench.json", JSON.stringify(s)); return t;
}

test("Discover searches four sources, de-duplicates by DOI, keeps going when one source is down, adds Unpaywall open access and links results to the library", async () => {
  const t = await setup(), web = fakeWeb({ doajDown: true });
  const r = await withFetch(web.handler, () => t.call(MANAGER, "/api/discover", { q: "aripiprazole akathisia", limit: 10 })); assert.equal(r.status, 200, JSON.stringify(r.body));
  const b = r.body; assert.deepEqual(b.sources.map(s => [s.source, s.ok]), [["pubmed", true], ["europepmc", true], ["crossref", true], ["doaj", false]]); assert.match(b.sources[3].error, /503/);
  const hit = b.results.find(x => x.doi === "10.1000/akath.1"); assert.deepEqual(hit.sources.sort(), ["crossref", "europepmc", "pubmed"], "one record, three sources"); assert.equal(hit.pmid, "555"); assert.equal(b.results.filter(x => /akathisia: a case report/i.test(x.title)).length, 1);
  assert.equal(hit.abstract, "A woman developed akathisia."); assert.equal(b.results[0].doi, "10.1000/akath.1", "the record found by most sources comes first");
  assert.deepEqual([hit.unpaywall.state, hit.unpaywall.isOa, hit.unpaywall.status, hit.unpaywall.license, hit.unpaywall.pdfUrl], ["ok", true, "gold", "cc-by", "https://oa.example.org/akath.pdf"]);
  assert.equal(b.results.find(x => x.doi === "10.1000/other.3").unpaywall.state, "notfound");
  assert.equal(hit.library.pmid, "555"); assert.deepEqual(hit.library.cases.map(c => c.number).sort(), ["LS-1", "LS-2", "LS-3"]); assert.equal(hit.links.unpaywall, "https://unpaywall.org/10.1000/akath.1"); assert.match(hit.links.europepmc, /PMC999/);
  const other = (await withFetch(web.handler, () => t.call(SCREENER2, "/api/discover", { q: "aripiprazole", sources: ["pubmed"] }))).body; assert.equal(other.results[0].library, null, "a reviewer without access to the article is not told it is in the library");
  assert.ok([...hosts].every(h => ["eutils.ncbi.nlm.nih.gov", "www.ebi.ac.uk", "api.crossref.org", "doaj.org", "api.unpaywall.org"].includes(h)), "only the listed open sources were contacted: " + [...hosts].join(" "));
  const log = (await (await t.BUCKET.get("audit2/" + new Date().toISOString().slice(0, 7) + ".ndjson")).text()).split("\n").filter(Boolean).map(JSON.parse); assert.ok(log.some(e => e.action === "discover.search" && /akathisia/.test(e.entity_id)));
});

test("Discover results export as BibTeX, RIS and CSV; Unpaywall is reported as unconfigured without a contact email", async () => {
  const t = await setup(), items = [{ title: "Aripiprazole and akathisia", authors: ["Nair R", "Iyer S"], journal: "Case Rep Psychiatry", year: "2024", doi: "10.1000/akath.1", pmid: "555", sources: ["pubmed"], url: "https://doi.org/10.1000/akath.1" }];
  const bib = await (await t.raw(MANAGER, "/api/discover-export", { format: "bibtex", items })).text(); assert.match(bib, /@article\{Nair2024a,[\s\S]*author = \{Nair R and Iyer S\}[\s\S]*doi = \{10\.1000\/akath\.1\}/);
  const ris = await (await t.raw(MANAGER, "/api/discover-export", { format: "ris", items })).text(); assert.match(ris, /^TY  - JOUR\r\nTI  - Aripiprazole and akathisia\r\nAU  - Nair R\r\nAU  - Iyer S/); assert.match(ris, /DO  - 10\.1000\/akath\.1\r\n/);
  const csv = await (await t.raw(MANAGER, "/api/discover-export", { format: "csv", items })).text(); assert.match(csv, /^"Title","Authors","Journal","Year","DOI","PMID"/); assert.match(csv, /Nair R; Iyer S/);
  assert.equal((await t.raw(MANAGER, "/api/discover-export", { format: "csv", items: [] })).status, 400);
  const t2 = await makeEnv({ watches: [] }); const r = await withFetch(fakeWeb().handler, () => t2.call(MANAGER, "/api/discover", { q: "aripiprazole", sources: ["crossref"] })); assert.equal(r.body.unpaywallConfigured, false); assert.equal(r.body.results[0].unpaywall.state, "unconfigured");
});

test("PHI redaction finds identifiers before any model sees the text, and the leak check catches values that reappear", () => {
  const r = worker.redactPhi("Patient name: Jane Doe\nDOB: 04/12/1970, MRN: 00482913, phone 555-123-4567, email jane@example.org, 12 Oak Street. Seen by Dr. Alan Smith. Age 54, female.");
  for (const t of ["NAME", "DOB", "MRN", "PHONE", "EMAIL", "ADDRESS"]) assert.ok(r.counts[t] >= 1, t); assert.ok(!/Jane Doe|00482913|555-123-4567|jane@example.org|Alan Smith/.test(r.text), r.text); assert.match(r.text, /Age 54, female/, "age and sex are kept");
  assert.deepEqual(worker.phiLeaks("The summary mentions 00482913 again", r.removed), ["00482913"]); assert.deepEqual(worker.phiLeaks("Nothing identifying here", r.removed), []);
});

test("the PHI scan of a case lists identifying data without changing the case", async () => {
  const t = await setup(); const s = await t.state(); s.cases[0].data.general_comments = "Patient name: Jane Doe, MRN: 00482913"; await t.BUCKET.put("bench.json", JSON.stringify(s));
  const r = (await t.call(SCREENER, "/api/phi-scan", { caseId: "c1" })).body; assert.equal(r.clean, false); assert.ok(r.findings.some(x => x.field === "general comments" && x.types.MRN === 1 && x.types.NAME === 1));
  assert.equal((await t.call(SCREENER, "/api/phi-scan", { caseId: "c2" })).body.clean, true); assert.equal((await t.state()).cases[0].data.general_comments, "Patient name: Jane Doe, MRN: 00482913");
});

test("seriousness evidence is negation-aware, an emergency department visit is not hospitalisation, and important medical events count", () => {
  const ev = (sentence, term = "event") => ({ mentions: [{ sentence }], term, ime: false });
  assert.equal(worker.eventSeriousness(ev("He was seen in the emergency department and was not admitted."), "rash").flags.hospitalization, undefined);
  assert.ok(worker.eventSeriousness(ev("He was seen in the emergency department and was not admitted."), "rash").basis.some(b => /not hospitalisation/.test(b)));
  assert.equal(worker.eventSeriousness(ev("The patient denies chest pain and was never hospitalised."), "x").flags.serious, false);
  assert.equal(worker.eventSeriousness(ev("She was admitted for observation."), "x").flags.hospitalization, true);
  assert.equal(worker.eventSeriousness(ev("A mild episode.", "Hepatic failure")).flags.other_medically_important, true);
});

test("triage priority orders cases for reviewers and stays apart from the reporting clock", async () => {
  const t = await setup(), meta = (await t.get(MANAGER, "/api/state").then(r => r.json())).caseMeta;
  assert.deepEqual([meta.c1.triage.priority, meta.c2.triage.priority], ["expedited", "routine"]); assert.match(meta.c1.triage.reason, /Serious and unlisted/);
  assert.equal(meta.c1.timeline.days, 15, "the regulatory clock is separate");
  const s = await t.state(); s.cases[1].data.reporter = {}; await t.BUCKET.put("bench.json", JSON.stringify(s)); assert.equal((await t.get(MANAGER, "/api/state").then(r => r.json())).caseMeta.c2.triage.priority, "follow_up_required");
});

function fakeFda(counts) {
  const calls = []; return { calls, handler: async url => { const u = new URL(String(url)); calls.push(String(url)); if (u.host !== "api.fda.gov") return new Response("", { status: 404 }); const search = u.searchParams.get("search") || "";
    if (u.searchParams.get("count")) return J({ results: [{ term: "AKATHISIA", count: 100 }, { term: "NAUSEA", count: 30 }] });
    const total = !search ? counts.N : /reactionmeddrapt:"AKATHISIA"/i.test(search) && /generic_name/.test(search) ? 100 : /reactionmeddrapt:"NAUSEA"/i.test(search) && /generic_name/.test(search) ? 30 : /reactionmeddrapt:"AKATHISIA"/i.test(search) ? 5000 : /reactionmeddrapt:"NAUSEA"/i.test(search) ? 90000 : /aripiprazole|Abilify/i.test(search) ? 2000 : 0;
    return total ? J({ meta: { results: { total } } }) : new Response("", { status: 404 }); } };
}
test("FAERS context computes PRR, its interval and the signal rule from openFDA counts, caches the answer, and says what it does not prove", async () => {
  const t = await setup({ FAERS_GAP_MS: 0 }), fda = fakeFda({ N: 1000000 });
  const r = (await withFetch(fda.handler, () => t.call(SCREENER, "/api/faers-context", { drug: "aripiprazole", event: "akathisia" }))).body; assert.equal(r.found, true);
  const row = r.rows[0], a = 100, b = 2000 - 100, c = 5000 - 100, d = 1000000 - 2000 - c, prr = (a / (a + b)) / (c / (c + d)); assert.deepEqual([row.a, row.b, row.c, row.d], [a, b, c, d]); assert.ok(Math.abs(row.prr - prr) < 1e-9); assert.ok(row.lcl < row.prr && row.prr < row.ucl); assert.equal(row.signal, true); assert.match(r.caveat, /not evidence that the drug causes/);
  const n = fda.calls.length; const again = (await withFetch(fda.handler, () => t.call(SCREENER, "/api/faers-context", { drug: "aripiprazole", event: "akathisia" }))).body; assert.equal(again.cached, true); assert.equal(fda.calls.length, n);
  const top = (await withFetch(fda.handler, () => t.call(SCREENER, "/api/faers-context", { drug: "aripiprazole" }))).body; assert.deepEqual(top.rows.map(x => x.reaction).sort(), ["AKATHISIA", "NAUSEA"]); assert.equal(top.rows.find(x => x.reaction === "NAUSEA").signal, false, "a common event is not a signal");
  assert.equal((await withFetch(fda.handler, () => t.call(SCREENER, "/api/faers-context", { drug: "unknowndrug" }))).body.found, false);
  assert.deepEqual(worker.prrStats(2, 98, 10, 990), { ...worker.prrStats(2, 98, 10, 990), signal: false }, "fewer than 3 reports is never a signal");
});

test("Naranjo and WHO-UMC are calculated from reviewer answers with evidence-based prefill; the case only changes when the reviewer applies a result", async () => {
  const t = await setup(); const sc = a => worker.naranjoScore(a);
  assert.deepEqual([sc({ q2: "yes", q3: "yes", q5: "no", q10: "yes" }).score, sc({ q2: "yes", q3: "yes", q5: "no", q10: "yes" }).category], [6, "Probable"]); assert.equal(sc({ q1: "yes", q2: "yes", q3: "yes", q4: "yes", q5: "no", q6: "no", q7: "yes", q8: "yes", q9: "yes", q10: "yes" }).category, "Definite"); assert.equal(sc({ q2: "no", q5: "yes" }).category, "Doubtful"); assert.equal(sc({}).answered, 0);
  assert.equal(worker.whoUmcCategory({ temporal: true, dechallengePositive: true, rechallengePositive: true, alternativeUnlikely: true, plausible: true }), "Certain"); assert.equal(worker.whoUmcCategory({ temporal: true, dechallengePositive: true, alternativeUnlikely: true }), "Probable/Likely"); assert.equal(worker.whoUmcCategory({ temporal: false }), "Unlikely"); assert.equal(worker.whoUmcCategory({}), "Unassessable/Unclassifiable");
  const sug = (await t.call(SCREENER, "/api/causality-assess", { caseId: "c1", eventIndex: 0 })).body; assert.equal(sug.prefill.answers.q2, "yes"); assert.equal(sug.prefill.answers.q3, "yes"); assert.match(sug.prefill.basis.q3, /Positive/); assert.equal(sug.questions.length, 10);
  assert.equal((await t.call(SCREENER, "/api/causality-assess", { caseId: "c1", eventIndex: 0, mode: "save", answers: { q2: "maybe" } })).status, 400);
  assert.equal((await t.state()).cases[0].data.events[0].causality_reviewer, undefined);
  const saved = await t.call(SCREENER, "/api/causality-assess", { caseId: "c1", eventIndex: 0, mode: "save", answers: { ...sug.prefill.answers, q5: "no", q10: "yes" }, who: { temporal: true, dechallengePositive: true, alternativeUnlikely: true, plausible: true } }); assert.equal(saved.status, 200, JSON.stringify(saved.body));
  let ev = (await t.state()).cases[0].data.events[0]; assert.equal(ev.naranjo.score, 6); assert.equal(ev.who_umc_calc.category, "Probable/Likely"); assert.ok(!ev.causality_reviewer?.value, "saving a calculation does not decide causality");
  await t.call(SCREENER, "/api/causality-assess", { caseId: "c1", eventIndex: 0, mode: "save", answers: ev.naranjo.answers, who: ev.who_umc_calc.inputs, apply: "naranjo" }); ev = (await t.state()).cases[0].data.events[0]; assert.equal(ev.causality_reviewer.value, "Probable/Likely"); assert.equal(ev.causality_method.value, "Naranjo");
  assert.equal((await t.call(SCREENER2, "/api/causality-assess", { caseId: "c1", eventIndex: 0 })).status, 404);
  const log = (await (await t.BUCKET.get("audit2/" + new Date().toISOString().slice(0, 7) + ".ndjson")).text()).split("\n").filter(Boolean).map(JSON.parse); assert.ok(log.some(e => e.action === "case.causality"));
});

test("the BioBERT causality service is optional; its input is PHI-redacted, and its answer is stored as a machine suggestion that never decides causality", async () => {
  const t0 = await setup(); assert.equal((await t0.call(SCREENER, "/api/bert-causality", { caseId: "c1", eventIndex: 0 })).status, 501);
  const t = await setup({ CAUSALITY_ENDPOINT: "https://causality.example.org/predict", CAUSALITY_TOKEN: "k".repeat(30) }), seen = [];
  const ok = async (url, init) => { if (String(url).startsWith("https://causality.example.org")) { seen.push({ auth: init.headers.Authorization, body: JSON.parse(init.body) }); return J({ label: "causal", probability: 0.9731, model: "drug-causality-bert-v2" }); } return new Response("", { status: 404 }); };
  const r = await withFetch(ok, () => t.call(SCREENER, "/api/bert-causality", { caseId: "c1", eventIndex: 0 })); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(seen[0].auth, "Bearer " + "k".repeat(30)); assert.ok(!/Alan Smith|0048291/.test(seen[0].body.text), seen[0].body.text); assert.match(seen[0].body.text, /\[NAME\]/);
  const ev = (await t.state()).cases[0].data.events[0], s = ev.causality_suggestions[0]; assert.deepEqual([s.state, s.label, s.probability, s.source], ["machine_suggestion", "causal", 0.973, "drug-causality-bert-v2"]); assert.ok(s.phiRedacted.MRN >= 1); assert.ok(!ev.causality_reviewer?.value);
  const bad = await withFetch(async () => J({ label: "maybe" }), () => t.call(SCREENER, "/api/bert-causality", { caseId: "c1", eventIndex: 0 })); assert.equal(bad.status, 502);
});
