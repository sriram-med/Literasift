// Saved searches: one per molecule (its names, mode and filters). Manual pulls, comparisons and the daily automatic pull all run it, so they cannot differ.
import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, SCREENER, fakeNcbi, withFetch, makeEnv } from "./helpers.mjs";

const dAgo = n => new Date(Date.now() + 5.5 * 3600000 - n * 86400000).toISOString().slice(0, 10);
const key = w => encodeURIComponent(w.portfolio) + "|" + encodeURIComponent(w.molecule);
async function setup() {
  const watches = [{ id: "ca", portfolio: "Square", molecule: "calcium acetate", query: "((calcium acetate))", names: [], client: "sq" },
    { id: "om", portfolio: "Square", molecule: "omeprazole", query: "((omeprazole))", names: [], client: "sq" }];
  const t = await makeEnv({ watches, clients: [{ id: "sq", name: "Square" }], memberships: [{ email: SCREENER, portfolio: "Square", role: "reviewer" }] });
  return { t, watches };
}
const esearchTerms = ncbi => ncbi.calls.filter(c => c.startsWith("esearch")).map(c => c.split(" ").slice(1).join(" "));

test("every molecule's saved search is listed with its names, mode, filters and exact query", async () => {
  const { t } = await setup();
  const r = await t.call(MANAGER, "/api/saved-searches", { client: "sq" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.searches.map(s => s.molecule), ["calcium acetate", "omeprazole"]);
  const ca = r.body.searches[0];
  assert.equal(ca.mode, "pubmed"); assert.equal(ca.query, "((calcium acetate))"); assert.deepEqual(ca.names, []); assert.equal(ca.canEdit, true);
  assert.deepEqual(ca.filters, { humans: false, caseReports: false, english: false, noReviews: false, safety: false });
});

test("a manager edits a saved search: names, mode and filters become a new query version, and only managers may save", async () => {
  const { t, watches } = await setup();
  const k = key(watches[0]);
  const bad = await t.call(MANAGER, "/api/saved-search", { key: k, mode: "custom", customQuery: "", save: true });
  assert.equal(bad.status, 400);
  const r = await t.call(MANAGER, "/api/saved-search", { key: k, names: "PhosLo, calcium acetate", mode: "precise", filters: { humans: true }, save: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.search.mode, "precise"); assert.deepEqual(r.body.search.names, ["PhosLo"], "the molecule itself is not repeated as a name");
  assert.ok(r.body.search.query.includes('"PhosLo"[tiab]') && r.body.search.query.endsWith("AND humans[mh]"), r.body.search.query);
  const w = (await t.state()).watches.find(x => x.id === "ca");
  assert.equal(w.query, r.body.search.query, "the stored query is the saved search, so the daily pull runs it");
  assert.equal(w.versions.length, 2); assert.match(w.versions[1].note, /^saved search edited/); assert.equal(w.client, "sq");
  const denied = await t.call(SCREENER, "/api/saved-search", { key: k, mode: "pubmed", save: true });
  assert.equal(denied.status, 403);
  // a custom query runs exactly as written, with the safety filter only if ticked
  const c = await t.call(MANAGER, "/api/saved-search", { key: k, mode: "custom", customQuery: '"calcium acetate"[tiab] AND hyperphosphatemia', filters: {}, save: true });
  assert.equal(c.body.search.query, '"calcium acetate"[tiab] AND hyperphosphatemia');
  assert.equal(c.body.search.customQuery, '"calcium acetate"[tiab] AND hyperphosphatemia');
  const back = await t.call(MANAGER, "/api/saved-search", { key: k, mode: "pubmed", save: true });
  assert.equal(back.body.search.query, "((calcium acetate) OR (PhosLo))"); assert.equal((await t.state()).watches.find(x => x.id === "ca").customQuery, undefined);
});

test("a preview counts the draft in PubMed for the chosen dates without saving anything", async () => {
  const { t, watches } = await setup();
  const ncbi = fakeNcbi([{ pmid: "1", date: dAgo(2) }, { pmid: "2", date: dAgo(3) }, { pmid: "3", date: dAgo(40) }]);
  const r = await withFetch(ncbi.handler, () => t.call(SCREENER, "/api/saved-search", { key: key(watches[0]), mode: "precise", from: dAgo(10), to: dAgo(0) }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.count.count, 2); assert.ok(r.body.preview.query.includes('"calcium acetate"[tiab]'));
  assert.equal((await t.state()).watches.find(x => x.id === "ca").query, "((calcium acetate))", "a preview never saves");
});

test("a pull with only dates runs each molecule's saved search, and the daily automatic pull runs the same one", async () => {
  const { t, watches } = await setup();
  await t.call(MANAGER, "/api/saved-search", { key: key(watches[0]), mode: "precise", filters: { english: true }, save: true });
  const saved = (await t.call(MANAGER, "/api/saved-searches", { client: "sq" })).body.searches[0].query;
  const ncbi = fakeNcbi([{ pmid: "11", date: dAgo(2) }]);
  const r = await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/pull-client", { client: "sq", from: dAgo(5), to: dAgo(0), molecules: [key(watches[0])] }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const x = r.body.results[0];
  assert.equal(x.saved, true); assert.equal(x.mode, "precise"); assert.ok(x.term.startsWith("(" + saved + ") AND ("), x.term);
  const st = await t.state();
  assert.equal(st.runs.find(run => run.id === x.runId).snapshot.query, saved);
  // the scheduler: the same saved search with its own dates. An edit applies from the day it is made (earlier windows keep the version in force then),
  // so the edit is dated back here to cover yesterday's window.
  const s2 = await t.state(); s2.watches.find(w => w.id === "ca").versions.at(-1).effectiveFrom = dAgo(30); await t.BUCKET.put("bench.json", JSON.stringify(s2));
  ncbi.calls.length = 0;
  await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/scheduled", { force: true }));
  const daily = esearchTerms(ncbi).filter(term => term.includes("calcium acetate"));
  assert.ok(daily.length, "the daily pull searched calcium acetate");
  assert.ok(daily.every(term => term.startsWith("(" + saved + ") AND (")), daily[0]);
});

test("Compare shows each molecule's saved search with its own filters", async () => {
  const { t, watches } = await setup();
  await t.call(MANAGER, "/api/saved-search", { key: key(watches[1]), filters: { humans: true }, save: true });
  const ncbi = fakeNcbi([{ pmid: "21", date: dAgo(2) }]);
  const r = await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/compare-client", { client: "sq", from: dAgo(5), to: dAgo(0), dateField: "crdt" }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.saved, true);
  const om = r.body.rows.find(x => x.molecule === "omeprazole"), ca = r.body.rows.find(x => x.molecule === "calcium acetate");
  assert.equal(om.filters.humans, true); assert.ok(om.query.includes("humans[mh]"));
  assert.equal(ca.filters.humans, false); assert.ok(!ca.query.includes("humans[mh]"));
});

test("product names with strengths and dosage forms are searched as the drug; combinations as all of their parts", async () => {
  const watches = [{ id: "a", portfolio: "USV", molecule: "Acarbose Tablets 25 mg and 50mg", query: "((Acarbose Tablets 25 mg and 50mg))", names: [], client: "usv" },
    { id: "v", portfolio: "USV", molecule: "VOBOSE 0.2/0.3 mg", query: "x", names: ["Voglibose"], client: "usv" },
    { id: "g", portfolio: "USV", molecule: "Glimepiride and Metformin Hydrochloride Tablets 1mg/500mg", query: "x", names: [], client: "usv", searchMode: "precise" }];
  const t = await makeEnv({ watches, clients: [{ id: "usv", name: "USV" }] });
  const q = Object.fromEntries((await t.call(MANAGER, "/api/saved-searches", { client: "usv" })).body.searches.map(s => [s.id, s.query]));
  assert.equal(q.a, "((Acarbose))");
  assert.equal(q.v, "((VOBOSE) OR (Voglibose))");
  assert.ok(q.g.startsWith('((("Glimepiride"[tiab]') && q.g.includes(') AND ("Metformin Hydrochloride"[tiab]') && !/mg|Tablets/.test(q.g), q.g);
});

test("a molecule can have its own dates: Compare and Pull use them, the other molecules keep the shared dates", async () => {
  const { t, watches } = await setup();
  const ncbi = fakeNcbi([{ pmid: "31", date: dAgo(2) }, { pmid: "32", date: dAgo(50) }, { pmid: "33", date: dAgo(80) }]);
  const own = { [key(watches[0])]: { from: dAgo(90), to: dAgo(0) } };
  const r = await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/compare-client", { client: "sq", from: dAgo(5), to: dAgo(0), dateField: "crdt", dates: own }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ca = r.body.rows.find(x => x.molecule === "calcium acetate"), om = r.body.rows.find(x => x.molecule === "omeprazole");
  assert.equal(ca.ownDates, true); assert.equal(ca.from, dAgo(90)); assert.equal(ca.count, 3);
  assert.equal(om.ownDates, false); assert.equal(om.from, dAgo(5)); assert.equal(om.count, 1);
  // a pull sends each molecule with its own dates
  const p = await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/pull-client", { client: "sq", from: dAgo(90), to: dAgo(0), molecules: [key(watches[0])] }));
  assert.equal(p.body.results[0].expected, 3); assert.equal(p.body.results[0].from, dAgo(90));
});

test("a brand PubMed cannot read is not searched loosely: nothing is pulled and the saved search must be fixed", async () => {
  const watches = [{ id: "p", portfolio: "USV", molecule: "Pioz MF G-1 _2", query: "x", names: [], client: "usv" }];
  const t = await makeEnv({ watches, clients: [{ id: "usv", name: "USV" }] });
  assert.equal((await t.call(MANAGER, "/api/saved-searches", { client: "usv" })).body.searches[0].query, "((Pioz MF G-1))", "the duplicate marker is dropped");
  const recs = Array.from({ length: 50 }, (_, i) => ({ pmid: String(900 + i), date: dAgo(2) })), ncbi = fakeNcbi(recs);
  const handler = async (u, i) => { const res = await ncbi.handler(u, i); if (!String(u).includes("esearch")) return res;
    const j = await res.json(); j.esearchresult.warninglist = { phrasesignored: [], quotedphrasesnotfound: [], outputmessages: [] }; j.esearchresult.errorlist = { phrasesnotfound: ["Pioz"] }; return new Response(JSON.stringify(j)); };
  const r = await withFetch(handler, () => t.call(MANAGER, "/api/pull-client", { client: "usv", from: dAgo(5), to: dAgo(0) }));
  const x = r.body.results[0];
  assert.match(x.error, /could not read part of "Pioz MF G-1"/); assert.deepEqual(x.loose, ["Pioz MF G-1"]);
  assert.equal(Object.keys((await t.state()).articles).length, 0, "nothing was pulled");
});

test("a custom search saved before anything was pulled applies to every date, so the automatic catch-up runs it too", async () => {
  const watches = [{ id: "m", portfolio: "Laurus", molecule: "metformin", query: "((metformin))", names: [], client: "l" }];
  const t = await makeEnv({ watches, clients: [{ id: "l", name: "Laurus" }] });
  const k = encodeURIComponent("Laurus") + "|metformin";
  const r = await t.call(MANAGER, "/api/saved-search", { key: k, mode: "custom", customQuery: "(metformin) AND (Philippines)", save: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const w = (await t.state()).watches[0]; assert.equal(w.versions.at(-1).effectiveFrom, "0000-00-00");
  const ncbi = fakeNcbi([{ pmid: "71", date: dAgo(2) }]);
  await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/scheduled", { force: true }));
  const terms = esearchTerms(ncbi);
  assert.ok(terms.length && terms.every(x => x.includes("(metformin) AND (Philippines)")), terms[0]);
  // once something has been pulled, a later edit applies from today only
  const again = await t.call(MANAGER, "/api/saved-search", { key: k, mode: "custom", customQuery: "(metformin) AND (Philippines[ad])", save: true });
  assert.equal(again.status, 200); assert.notEqual((await t.state()).watches[0].versions.at(-1).effectiveFrom, "0000-00-00");
});

test("a molecule's countries narrow its saved search for pulls, the daily pull and counts", async () => {
  const watches = [{ id: "h", portfolio: "Laurus", molecule: "hydroxychloroquine", query: "((hydroxychloroquine))", names: [], client: "l" }, { id: "a", portfolio: "Laurus", molecule: "atorvastatin", query: "((atorvastatin))", names: ["atorvastatin calcium"], client: "l" }];
  const t = await makeEnv({ watches, clients: [{ id: "l", name: "Laurus" }] });
  const h = await t.call(MANAGER, "/api/saved-search", { key: "Laurus|hydroxychloroquine", countries: "Ghana, Philippines", save: true });
  assert.equal(h.body.search.query, "(((hydroxychloroquine))) AND (Ghana OR Philippines)");
  const a = await t.call(MANAGER, "/api/saved-search", { key: "Laurus|atorvastatin", countries: "UAE", save: true });
  assert.equal(a.body.search.query, '(((atorvastatin) OR (atorvastatin calcium))) AND ("United Arab Emirates" OR UAE)');
  assert.deepEqual(a.body.search.countries, ["UAE"]);
  const st = await t.state(); assert.equal(st.watches.find(w => w.id === "a").query, a.body.search.query, "the stored search (and so the daily pull) includes the country");
  const ncbi = fakeNcbi([{ pmid: "5", date: dAgo(2) }]);
  const p = await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/pull-client", { client: "l", from: dAgo(5), to: dAgo(0), molecules: ["Laurus|hydroxychloroquine"] }));
  assert.ok(p.body.results[0].term.includes("AND (Ghana OR Philippines)"), p.body.results[0].term);
  const clear = await t.call(MANAGER, "/api/saved-search", { key: "Laurus|atorvastatin", countries: "", save: true });
  assert.equal(clear.body.search.query, "((atorvastatin) OR (atorvastatin calcium))");
});

test("pasted settings update several saved searches at once, line by line (Laurus block)", async () => {
  const { readFileSync } = await import("node:fs");
  const mols = ["atorvastatin", "hydroxychloroquine", "metformin", "trientine", "sodium phenylbutyrate", "bictegravir and emtricitabine and tenofovir alafenamide"];
  const watches = mols.map((m, i) => ({ id: "w" + i, portfolio: "Laurus", molecule: m, query: "((" + m + "))", names: [], client: "l", countries: ["India"] }));
  const t = await makeEnv({ watches, clients: [{ id: "l", name: "Laurus" }] });
  const text = readFileSync(new URL("./fixtures/laurus-paste.txt", import.meta.url), "utf8") + "\nunknown drug | countries:";
  const r = await t.call(MANAGER, "/api/saved-search-bulk", { client: "l", text });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.saved, 6); assert.equal(r.body.failed, 1);
  const st = await t.state(), w = m => st.watches.find(x => x.molecule === m);
  for (const m of mols) assert.deepEqual(w(m).countries, [], m + " has no country");
  assert.equal(w("metformin").searchMode, "custom"); assert.ok(w("metformin").query.startsWith('("Metformin"[All Fields]'));
  assert.equal(w("trientine").query, "((trientine))");
  assert.equal(w("bictegravir and emtricitabine and tenofovir alafenamide").query, "((bictegravir AND emtricitabine AND tenofovir alafenamide))");
  assert.equal((await t.call(SCREENER, "/api/saved-search-bulk", { client: "l", text })).status, 403);
  const c = (await t.state()).clients[0]; assert.equal(c.lastPaste, text, "the client remembers the last pasted block");
  // an old block left in the box with a new one pasted before it: refused, nothing saved
  const twice = await t.call(MANAGER, "/api/saved-search-bulk", { client: "l", text: "metformin | countries: India\n" + text });
  assert.equal(twice.status, 400); assert.match(twice.body.error, /more than once.*metformin/);
  assert.deepEqual((await t.state()).watches.find(w => w.molecule === "metformin").countries, []); assert.ok(c.lastPasteAt); assert.equal(c.lastPasteBy, MANAGER);
});
