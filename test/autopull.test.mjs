import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, SCREENER, fakeNcbi, withFetch, makeEnv } from "./helpers.mjs";

const dAgo = n => new Date(Date.now() + 5.5 * 3600000 - n * 86400000).toISOString().slice(0, 10);
const W1 = { portfolio: "Antivirals", molecule: "aciclovir", query: '"aciclovir"[tiab]' }, W2 = { portfolio: "CNS", molecule: "aripiprazole", query: '"aripiprazole"[tiab]' };
const key = w => encodeURIComponent(w.portfolio) + "|" + encodeURIComponent(w.molecule);
const status = t => t.call(MANAGER, "/api/scheduler-status", {}).then(r => r.body);

test("automatic pull: on by default, can be paused, and each molecule can be switched off; 'pull now' overrides the pause", async () => {
  const t = await makeEnv({ watches: [W1, W2] }), recs = [{ pmid: "1", date: dAgo(1) }], ncbi = fakeNcbi(recs);
  let s = await status(t);
  assert.equal(s.autoPull, true); assert.equal(s.perWatch.length, 2); assert.ok(s.perWatch.every(w => w.auto && w.missing >= 1));
  await t.call(MANAGER, "/api/watch-auto", { watch: key(W2), on: false });
  await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/scheduled", {}));
  s = await status(t);
  assert.equal(s.perWatch.find(w => w.molecule === "aciclovir").missing, 0, "the molecule left on was pulled");
  assert.ok(s.perWatch.find(w => w.molecule === "aripiprazole").missing >= 1, "the molecule switched off was not");
  await t.call(MANAGER, "/api/settings", { autoPull: "off" });
  const paused = await status(t); assert.equal(paused.autoPull, false);
  const searches = () => ncbi.calls.filter(c => c.startsWith("esearch")).length, calls = searches();
  await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/scheduled", {}));
  assert.equal(searches(), calls, "while paused the scheduler runs no new PubMed searches");
  await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/scheduled", { force: true }));
  assert.equal((await status(t)).perWatch.find(w => w.molecule === "aripiprazole").missing, 0, "'pull now' ignores the pause and the per-molecule switch");
});

test("line listing is built live from visible cases and a copy is saved once a day by the scheduler", async () => {
  const t = await makeEnv({ watches: [W1] });
  const empty = (await t.call(MANAGER, "/api/line-listing", {})).body; assert.equal(empty.cases, 0); assert.ok(empty.head.includes("Client") && empty.head.includes("Reporter comments"));
  const s = await t.state();
  s.cases = [{ id: "c1", number: "LS-1", pmid: "1", portfolio: "Antivirals", molecule: "aciclovir", status: "Draft", assignee: MANAGER, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01", history: [], versions: [], stage: "medical_review",
    data: { patient: { age: { value: "54" }, sex: { value: "male" } }, reporter: { identifier: { value: "A. Rao" } }, reporter_comments: "We suggest aciclovir neurotoxicity.", other_reporters: [{ name: "S. Iyer" }], dates: {}, products: [{ role: "suspect", name: { value: "aciclovir" } }], events: [{ verbatim: { value: "status epilepticus" }, seriousness: { serious: true, hospitalization: true }, listedness: { value: "Unlisted" } }], confounders: [], treatment_given: [] } }];
  s.articles["1"] = { id: "1", title: "T", authors: ["Rao A"], journal: "J Case Rep", date: "2026" }; s.clients = [{ id: "k1", name: "Acme" }]; s.watches[0].client = "k1";
  await t.BUCKET.put("bench.json", JSON.stringify(s));
  const ll = (await t.call(MANAGER, "/api/line-listing", {})).body, h = ll.head, row = ll.rows[0];
  assert.equal(ll.cases, 1); assert.equal(row[h.indexOf("Client")], "Acme"); assert.equal(row[h.indexOf("Seriousness criteria")], "hospitalization"); assert.equal(row[h.indexOf("Other authors")], "S. Iyer");
  assert.equal((await t.call(MANAGER, "/api/line-listing", { client: "nope" })).body.cases, 0, "the client filter applies");
  await withFetch(fakeNcbi([]).handler, () => t.call(MANAGER, "/api/scheduled", {}));
  const snap = (await t.state()).lineListingSnapshot; assert.ok(snap && snap.cases === 1);
  assert.match(await (await t.BUCKET.get(snap.key)).text(), /^"Case","PMID"/);
});

test("automatic pull: a start date makes earlier uncovered days wait, a future date holds everything back, and a bad date is refused", async () => {
  const t = await makeEnv({ watches: [W1] });
  const base = (await status(t)).perWatch[0].missing;
  assert.equal((await t.call(MANAGER, "/api/settings", { autoPullFrom: dAgo(10) })).status, 200);
  const s = await status(t); assert.equal(s.autoPullFrom, dAgo(10)); assert.equal(s.perWatch[0].missing, 1, "the days since the start date are one waiting range");
  const ncbi = fakeNcbi([{ pmid: "1", date: dAgo(5) }]);
  await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/scheduled", {}));
  assert.equal((await status(t)).perWatch[0].missing, 0, "the range from the start date was pulled");
  await t.call(MANAGER, "/api/settings", { autoPullFrom: dAgo(-30) });
  assert.equal((await status(t)).perWatch[0].missing, 0, "a start date in the future waits");
  assert.equal((await t.call(MANAGER, "/api/settings", { autoPullFrom: "soon" })).status, 400);
  await t.call(MANAGER, "/api/settings", { autoPullFrom: "" }); assert.equal((await status(t)).autoPullFrom, ""); assert.ok(base >= 1);
});

test("pulling is organised by client: a client can be paused, pulled alone, and clients are taken in turn", async () => {
  const t = await makeEnv({ watches: [W1, W2] });
  const s = await t.state(); s.clients = [{ id: "k1", name: "Acme" }, { id: "k2", name: "Beta" }]; s.watches[0].client = "k1"; s.watches[1].client = "k2"; await t.BUCKET.put("bench.json", JSON.stringify(s));
  const st = await status(t); assert.deepEqual(st.perClient.map(c => c.name).sort(), ["Acme", "Beta"]); assert.ok(st.perClient.every(c => c.auto && c.molecules === 1 && c.waiting >= 1));
  assert.equal((await t.call(SCREENER, "/api/client-auto", { client: "k2", on: false })).status, 403);
  await t.call(MANAGER, "/api/client-auto", { client: "k2", on: false });
  const ncbi = fakeNcbi([{ pmid: "1", date: dAgo(1) }]);
  await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/scheduled", {}));
  let a = await status(t); assert.equal(a.perClient.find(c => c.id === "k1").waiting, 0, "the running client was pulled"); assert.ok(a.perClient.find(c => c.id === "k2").waiting >= 1, "the paused client was not");
  await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/scheduled", { force: true, client: "k2" }));
  a = await status(t); assert.equal(a.perClient.find(c => c.id === "k2").waiting, 0, "pull now for one client pulls that client even when paused");
});

test("pulling dates: a client and a molecule can each have a start and stop date; the molecule's own dates win; bad dates are refused", async () => {
  const t = await makeEnv({ watches: [W1, W2] });
  const s = await t.state(); s.clients = [{ id: "k1", name: "Acme" }]; s.watches.forEach(w => { w.client = "k1"; }); await t.BUCKET.put("bench.json", JSON.stringify(s));
  assert.equal((await t.call(SCREENER, "/api/client-auto", { client: "k1", startFrom: dAgo(9) })).status, 403);
  assert.equal((await t.call(MANAGER, "/api/client-auto", { client: "k1", startFrom: "soon" })).status, 400);
  assert.equal((await t.call(MANAGER, "/api/client-auto", { client: "k1", startFrom: dAgo(2), until: dAgo(9) })).status, 400, "start after stop");
  assert.equal((await t.call(MANAGER, "/api/client-auto", { client: "k1", startFrom: dAgo(10) })).status, 200);
  let st = await status(t); const c = st.perClient.find(x => x.id === "k1"); assert.equal(c.startFrom, dAgo(10)); assert.ok(st.perWatch.every(w => w.effective.from === dAgo(10)));
  const waiting = st.perWatch[0].missing; assert.equal(waiting, 1);
  // a stop date in the past leaves the days after it out
  await t.call(MANAGER, "/api/client-auto", { client: "k1", until: dAgo(6) });
  st = await status(t); assert.equal(st.perWatch[0].effective.until, dAgo(6));
  const ncbi = fakeNcbi([{ pmid: "1", date: dAgo(8) }]);
  await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/scheduled", {}));
  st = await status(t); assert.equal(st.perWatch[0].missing, 0, "only the window up to the stop date was needed");
  // the molecule's own dates win over the client's
  await t.call(MANAGER, "/api/watch-auto", { watch: key(W1), startFrom: dAgo(30), until: "" });
  st = await status(t); const w1 = st.perWatch.find(w => w.molecule === "aciclovir"), w2 = st.perWatch.find(w => w.molecule === "aripiprazole");
  assert.equal(w1.effective.from, dAgo(30)); assert.equal(w1.effective.until, dAgo(6), "an empty stop date follows the client"); assert.equal(w2.effective.from, dAgo(10));
  assert.equal((await t.call(MANAGER, "/api/watch-auto", { watch: key(W1), startFrom: "x" })).status, 400);
  await t.call(MANAGER, "/api/watch-auto", { watch: key(W1), startFrom: "" }); assert.equal((await status(t)).perWatch.find(w => w.molecule === "aciclovir").effective.from, dAgo(10));
});

test("fast pulls lose nothing: windows run side by side, split under a cap, and retry a failure, yet every article is retrieved once and counted against PubMed", async () => {
  const t = await makeEnv({ watches: [W1, W2], NCBI_GAP_MS: 0, RETRY_BASE_MS: 1 });
  const s = await t.state(); s.clients = [{ id: "k1", name: "Acme" }]; s.watches.forEach(w => { w.client = "k1"; }); await t.BUCKET.put("bench.json", JSON.stringify(s));
  const recs = Array.from({ length: 80 }, (_, i) => ({ pmid: String(1000 + i), date: dAgo(1 + Math.floor(i * 1.7)) })), from = dAgo(140), to = dAgo(0);
  const ncbi = fakeNcbi(recs, { cap: 6, failWindows: { [from]: 2 } });
  const t0 = Date.now();
  const r = await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/pull-client", { client: "k1", from, to, dateField: "pdat" })); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.results.every(x => x.complete && x.retrieved === x.expected), JSON.stringify(r.body.results)); assert.equal(r.body.complete, true);
  const st = await t.state(), want = new Set(recs.map(x => x.pmid));
  assert.deepEqual(new Set(Object.keys(st.articles)), want, "every article PubMed reported is stored");
  for (const w of ["aciclovir", "aripiprazole"]) { const own = st.assignments.filter(a => (a.molecules || []).includes(w) || a.portfolio); }
  const per = {}; for (const a of st.assignments) per[a.portfolio + "|" + a.pmid] = (per[a.portfolio + "|" + a.pmid] || 0) + 1;
  assert.ok(Object.values(per).every(n => n === 1), "never two assignments for the same article in a portfolio");
  assert.ok(st.runs.every(run => run.windows.every(w => ["reconciled", "zero_results"].includes(w.state))), "every window, including the split halves, is reconciled");
  assert.ok(Date.now() - t0 < 20000, "no waiting when the gap is zero");
});

test("a manual pull always fetches again: after pulled articles are cleared, pulling the same dates brings them back", async () => {
  const t = await makeEnv({ watches: [W1], NCBI_GAP_MS: 0, RETRY_BASE_MS: 1 });
  const s = await t.state(); s.clients = [{ id: "k1", name: "Acme" }]; s.watches[0].client = "k1"; await t.BUCKET.put("bench.json", JSON.stringify(s));
  const from = dAgo(10), to = dAgo(0), ncbi = fakeNcbi([{ pmid: "11", date: dAgo(3) }, { pmid: "12", date: dAgo(5) }]);
  const pull = () => withFetch(ncbi.handler, () => t.call(MANAGER, "/api/pull-client", { client: "k1", from, to, dateField: "crdt" })).then(r => r.body.results[0]);
  assert.equal((await pull()).added, 2); assert.equal((await pull()).added, 0, "a repeat adds nothing new");
  assert.equal((await t.call(MANAGER, "/api/pulled-purge", { reason: "free space", confirm: "DELETE 2" })).status, 200); assert.equal(Object.keys((await t.state()).articles).length, 0);
  const again = await pull(); assert.equal(again.added, 2, JSON.stringify(again)); assert.equal(Object.keys((await t.state()).articles).length, 2); assert.equal((await t.state()).assignments.length, 2);
});

test("a client pull searches every name known for a molecule (dictionary and drug list), like a single-molecule pull does", async () => {
  const t = await makeEnv({ watches: [{ portfolio: "Antivirals", molecule: "aciclovir", query: '"aciclovir"[tiab]' }, { portfolio: "CNS", molecule: "sertraline", query: '"sertraline"[tiab]' }], NCBI_GAP_MS: 0, RETRY_BASE_MS: 1 });
  const s = await t.state(); s.clients = [{ id: "k1", name: "Acme" }]; s.watches.forEach(w => { w.client = "k1"; });
  s.dictionaries = { Antivirals: { version: 1, products: [{ name: "aciclovir", generics: ["acyclovir"], brands: ["Zovirax"], salts: ["aciclovir sodium"], aliases: [] }] } };
  await t.BUCKET.put("bench.json", JSON.stringify(s));
  await t.BUCKET.put("drugkb.json", JSON.stringify({ version: 1, ingredients: { sertraline: { name: "sertraline", rxcui: "36437", brands: ["Zoloft", "Lustral"], salts: ["sertraline hydrochloride"], synonyms: [], atc: [], sources: [], enrichedAt: "2026-01-01" } }, sync: {} }));
  const ncbi = fakeNcbi([{ pmid: "1", date: dAgo(2) }]);
  const r = await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/pull-client", { client: "k1", from: dAgo(5), to: dAgo(0), dateField: "crdt", online: false })); assert.equal(r.status, 200, JSON.stringify(r.body));
  const terms = decodeURIComponent(ncbi.calls.filter(c => c.startsWith("esearch")).join(" ").replace(/\+/g, " "));
  for (const name of ["Zovirax", "acyclovir", "aciclovir sodium", "Zoloft", "Lustral", "sertraline hydrochloride"]) assert.ok(terms.includes('"' + name + '"'), name + " is searched; got " + terms.slice(0, 400));
  assert.ok(r.body.results.every(x => x.names > 0), "the result says how many extra names were searched");
  const w = (await t.state()).watches.find(x => x.molecule === "aciclovir"); assert.ok(/Zovirax/.test(w.query), "the broader search is kept for the automatic pull");
  // filters apply on top of the broad search and are not saved into the watch
  const n2 = fakeNcbi([{ pmid: "2", date: dAgo(2) }]); await withFetch(n2.handler, () => t.call(MANAGER, "/api/pull-client", { client: "k1", from: dAgo(5), to: dAgo(0), caseReports: true, online: false }));
  assert.ok(decodeURIComponent(n2.calls.join(" ").replace(/\+/g, " ")).includes("case reports"));
  assert.ok(!(await t.state()).watches.some(x => /case reports/.test(x.query)));
});

test("broad search style: bare names like the PubMed website, a client switch that rewrites its searches, and a comparison with PubMed", async () => {
  const t = await makeEnv({ watches: [{ portfolio: "CNS", molecule: "sertraline", query: '"sertraline"[tiab]' }], NCBI_GAP_MS: 0, RETRY_BASE_MS: 1 });
  const s = await t.state(); s.clients = [{ id: "k1", name: "Square" }]; s.watches[0].client = "k1"; await t.BUCKET.put("bench.json", JSON.stringify(s));
  await t.BUCKET.put("drugkb.json", JSON.stringify({ version: 1, ingredients: { sertraline: { name: "sertraline", rxcui: "1", brands: ["Zoloft"], salts: ["sertraline hydrochloride"], synonyms: [], atc: [], sources: [], enrichedAt: "x" } }, sync: {} }));
  const ncbi = fakeNcbi([{ pmid: "1", date: dAgo(2) }, { pmid: "2", date: dAgo(3) }]);
  const term = () => decodeURIComponent(ncbi.calls.filter(c => c.startsWith("esearch")).join(" ").replace(/\+/g, " "));
  const r = await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/pull-client", { client: "k1", from: dAgo(6), to: dAgo(0), dateField: "crdt", searchMode: "broad", online: false })); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.results[0].mode, "broad"); assert.ok(/\(\(sertraline OR /.test(term()) && term().includes("Zoloft") && term().includes('"sertraline hydrochloride"') && !term().includes("[tiab]"), term().slice(0, 300));
  assert.equal(typeof r.body.results[0].siteCount, "number", "the website-style count is reported");
  assert.equal((await t.call(MANAGER, "/api/client-auto", { client: "k1", searchMode: "nope" })).status, 400);
  const sw = await t.call(MANAGER, "/api/client-auto", { client: "k1", searchMode: "broad" }); assert.equal(sw.status, 200); assert.equal(sw.body.restyled, 1);
  let st = await t.state(); assert.equal(st.clients[0].searchMode, "broad"); assert.ok(!/\[tiab\]/.test(st.watches[0].query) && /Zoloft/.test(st.watches[0].query), st.watches[0].query);
  assert.equal((await status(t)).perClient.find(c => c.id === "k1").searchMode, "broad");
  await t.call(MANAGER, "/api/client-auto", { client: "k1", searchMode: "precise" }); st = await t.state(); assert.ok(/\[tiab\]/.test(st.watches[0].query) && st.clients[0].searchMode === undefined);
  const cmp = await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/client-compare", { client: "k1", from: dAgo(6), to: dAgo(0) })); assert.equal(cmp.status, 200, JSON.stringify(cmp.body));
  const row = cmp.body.rows[0]; assert.equal(row.molecule, "sertraline"); assert.equal(row.site, 2); assert.ok(row.allTime === null || row.allTime === 2, "the undated count is asked for"); assert.ok(row.link.startsWith("https://pubmed.ncbi.nlm.nih.gov/?term="));
  assert.equal((await t.call(SCREENER, "/api/client-compare", { client: "k1" })).status, 403);
});

test("a pull can run in the background: the request answers at once with a job, and progress is polled until it is done", async () => {
  const t = await makeEnv({ watches: [W1, W2] }, { DEFER_EVIDENCE: "1" });
  const s = await t.state(); s.clients = [{ id: "k1", name: "Acme" }]; s.watches.forEach(w => { w.client = "k1"; }); await t.BUCKET.put("bench.json", JSON.stringify(s));
  const ncbi = fakeNcbi([{ pmid: "1", date: dAgo(2) }, { pmid: "2", date: dAgo(3) }]);
  await withFetch(ncbi.handler, async () => {
    const start = await t.call(MANAGER, "/api/pull-client", { client: "k1", from: dAgo(6), to: dAgo(0), dateField: "crdt", background: true, online: false });
    assert.equal(start.status, 200); assert.ok(start.body.job && start.body.total === 2, JSON.stringify(start.body)); assert.equal(start.body.results, undefined, "it answers before the work is done");
    let p; for (let i = 0; i < 200; i++) { p = (await t.call(MANAGER, "/api/pull-job", { id: start.body.job })).body; if (p.state !== "running") break; await new Promise(r => setTimeout(r, 25)); }
    assert.equal(p.state, "done", JSON.stringify(p)); assert.equal(p.payload.results.length, 2); assert.ok(p.payload.results.every(x => x.complete)); assert.equal(p.payload.total, 4);
    assert.equal((await t.call(SCREENER, "/api/pull-job", { id: start.body.job })).status, 404, "another user cannot read the job");
    assert.equal((await t.call(MANAGER, "/api/pull-job", { id: "nope" })).status, 404);
  });
  const plain = await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/pull-client", { client: "k1", from: dAgo(6), to: dAgo(0), online: false })); assert.equal(plain.body.job, undefined); assert.ok(plain.body.results, "without background it still answers with the results");
});

test("pull without dates: everything PubMed has for the molecule, whatever its dates, split only where PubMed would cut the list; a huge literature is reported, not pulled", async () => {
  const t = await makeEnv({ watches: [W1] });
  const s = await t.state(); s.clients = [{ id: "k1", name: "Square" }]; s.watches[0].client = "k1"; await t.BUCKET.put("bench.json", JSON.stringify(s));
  const dates = ["2003-05-01", "2009-11-20", "2015-02-02", "2019-07-07", "2022-01-15", "2024-12-24", dAgo(3), dAgo(40), dAgo(400), "1998-03-03"];
  const recs = dates.map((d, i) => ({ pmid: String(500 + i), date: d })), ncbi = fakeNcbi(recs, { cap: 3 });
  const r = await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/pull-client", { client: "k1", allDates: true, searchMode: "precise", online: false })); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.allDates, true); assert.equal(r.body.results[0].count, 10, JSON.stringify(r.body.results)); assert.equal(r.body.results[0].complete, true);
  assert.deepEqual(new Set(Object.keys((await t.state()).articles)), new Set(recs.map(x => x.pmid)), "articles of every year are stored");
  // no dates given at all means the same
  const again = await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/pull-client", { client: "k1", online: false })); assert.equal(again.body.allDates, true); assert.equal(again.body.results[0].added, 0);
  // a molecule whose literature is far too large is reported, not pulled whole
  const big = fakeNcbi(Array.from({ length: 30 }, (_, i) => ({ pmid: String(900 + i), date: dAgo(i) })), {});
  const bigHandler = async (u, i) => { const url = new URL(String(u)); if (url.pathname.endsWith("esearch.fcgi") && !/\[(?:crdt|dp)\]/.test(url.searchParams.get("term") || "")) return new Response(JSON.stringify({ esearchresult: { count: "90000", idlist: [] } })); return big.handler(u, i); };
  const huge = await withFetch(bigHandler, () => t.call(MANAGER, "/api/pull-client", { client: "k1", allDates: true, online: false })); assert.ok(/more than the 25000/.test(huge.body.results[0].error), JSON.stringify(huge.body.results));
});

test("calcium acetate (a two-word name) gets a field-tagged broad search, and NCBI PubMed Central adds articles found only in full texts", async () => {
  const t = await makeEnv({ watches: [{ portfolio: "Renal", molecule: "calcium acetate", query: '"calcium acetate"[tiab]' }] });
  const s = await t.state(); s.clients = [{ id: "k1", name: "Square" }]; s.watches[0].client = "k1"; await t.BUCKET.put("bench.json", JSON.stringify(s));
  const pm = fakeNcbi([{ pmid: "1", date: dAgo(2) }]), seen = [];
  const handler = async (u, i) => { const url = new URL(String(u)), db = url.searchParams.get("db");
    if (db === "pmc") { seen.push(url.pathname.split("/").pop() + " " + (url.searchParams.get("term") || "")); if (url.pathname.endsWith("esearch.fcgi")) return new Response(JSON.stringify({ esearchresult: { count: "2", idlist: ["7001", "7002"] } }));
      return new Response(JSON.stringify({ result: { uids: ["7001", "7002"], 7001: { articleids: [{ idtype: "pmid", value: "1" }] }, 7002: { articleids: [{ idtype: "pmid", value: "77" }] } } })); }
    if (url.pathname.endsWith("esummary.fcgi") && (url.searchParams.get("id") || "").includes("77")) return new Response(JSON.stringify({ result: { uids: ["77"], 77: { title: "Calcium acetate in full text only", fulljournalname: "J Renal", pubdate: "2024", articleids: [{ idtype: "pubmed", value: "77" }] } } }));
    return pm.handler(u, i); };
  const r = await withFetch(handler, () => t.call(MANAGER, "/api/pull-client", { client: "k1", allDates: true, searchMode: "broad", includePmc: true, online: false })); assert.equal(r.status, 200, JSON.stringify(r.body));
  const term = decodeURIComponent(pm.calls.filter(c => c.startsWith("esearch")).join(" ").replace(/\+/g, " ")); assert.ok(term.includes('"calcium acetate"[All Fields]') && term.includes('"calcium acetate"[MeSH Terms]'), term.slice(0, 300));
  assert.ok(seen.some(x => x.startsWith("esearch") && x.includes('"calcium acetate"[All Fields]')), "PubMed Central is searched with the names");
  assert.equal(r.body.results[0].pmc.found, 2, JSON.stringify(r.body.results[0])); assert.ok(!r.body.results[0].pmc.error);
  // the Discover sources include PubMed Central
  const d = await withFetch(handler, () => t.call(MANAGER, "/api/discover", { q: "calcium acetate", sources: ["pmc"], limit: 5 })); assert.equal(d.status, 200, JSON.stringify(d.body)); assert.ok(JSON.stringify(d.body).includes("pmc"));
});

test("a long pull runs every search window in one go (no 12-window limit), shows its progress, and keeps its answer after it finishes", async () => {
  const t = await makeEnv({ watches: [W1] }, { DEFER_EVIDENCE: "1" });
  const s = await t.state(); s.clients = [{ id: "k1", name: "Acme" }]; s.watches[0].client = "k1"; await t.BUCKET.put("bench.json", JSON.stringify(s));
  const recs = Array.from({ length: 72 }, (_, i) => ({ pmid: String(3000 + i), date: dAgo(1 + i * 5) })), ncbi = fakeNcbi(recs, { cap: 2 });
  await withFetch(ncbi.handler, async () => {
    const start = await t.call(MANAGER, "/api/pull-client", { client: "k1", from: dAgo(365), to: dAgo(0), background: true, searchMode: "precise", online: false }); assert.ok(start.body.job);
    let p, sawProgress = false; for (let i = 0; i < 400; i++) { p = (await t.call(MANAGER, "/api/pull-job", { id: start.body.job })).body; if (Array.isArray(p.progress) && p.progress[0]?.stage) sawProgress = true; if (p.state !== "running") break; await new Promise(x => setTimeout(x, 25)); }
    assert.equal(p.state, "done", JSON.stringify(p).slice(0, 400)); assert.ok(sawProgress, "progress is reported while it runs");
    const x = p.payload.results[0]; assert.equal(x.complete, true, JSON.stringify(x)); assert.equal(x.retrieved, 72); assert.equal(x.count, 72);
    const run = (await t.state()).runs.find(r => r.windows.length > 12); assert.ok(run, "the pull needed more than 12 windows"); assert.ok(run.windows.every(w => ["reconciled", "zero_results"].includes(w.state)));
    const kept = await t.BUCKET.get("jobs/pull/" + start.body.job + ".json"); assert.ok(kept, "the answer is stored, so it survives a restart");
  });
  assert.equal((await t.call(MANAGER, "/api/pull-job", { id: "00000000-0000-0000-0000-000000000000" })).status, 404);
});
