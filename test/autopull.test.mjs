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

test("a pull searches only the molecule name and the names someone gave it: never the portfolio, nothing from the portfolio dictionary or the drug list", async () => {
  const t = await makeEnv({ watches: [{ portfolio: "Antivirals", molecule: "aciclovir", query: '("aciclovir"[tiab] OR "aciclovir"[MeSH Terms] OR "aciclovir"[Supplementary Concept] OR "Zovirax"[tiab] OR "Zovirax"[MeSH Terms] OR "Zovirax"[Supplementary Concept])' }, { portfolio: "CNS", molecule: "sertraline", query: '"sertraline"[tiab]' }] });
  const s = await t.state(); s.clients = [{ id: "k1", name: "Acme" }]; s.watches.forEach(w => { w.client = "k1"; });
  s.dictionaries = { Antivirals: { version: 1, products: [{ name: "aciclovir", generics: ["acyclovir"], brands: ["Zovirax", "Herpex"], salts: ["aciclovir sodium"], aliases: [] }] } };
  await t.BUCKET.put("bench.json", JSON.stringify(s));
  await t.BUCKET.put("drugkb.json", JSON.stringify({ version: 1, ingredients: { sertraline: { name: "sertraline", rxcui: "36437", brands: ["Zoloft", "Lustral"], salts: ["sertraline hydrochloride"], synonyms: [], atc: [], sources: [], enrichedAt: "2026-01-01" } }, sync: {} }));
  const ncbi = fakeNcbi([{ pmid: "1", date: dAgo(2) }]);
  for (const searchMode of ["precise", "broad"]) {
    ncbi.calls.length = 0;
    const r = await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/pull-client", { client: "k1", from: dAgo(5), to: dAgo(0), searchMode })); assert.equal(r.status, 200, JSON.stringify(r.body));
    const terms = decodeURIComponent(ncbi.calls.filter(c => c.startsWith("esearch")).join(" ").replace(/\+/g, " "));
    for (const name of ["aciclovir", "Zovirax", "sertraline"]) assert.ok(terms.includes(name), searchMode + ": " + name + " is searched");
    assert.equal(r.body.results.find(x => x.molecule === "aciclovir").term.includes("acyclovir"), false, "a spelling variant is searched only once approved");
    for (const name of ["Herpex", "aciclovir sodium", "Zoloft", "Lustral", "sertraline hydrochloride", "Antivirals", "CNS", "Acme"]) assert.ok(!terms.includes(name), searchMode + ": " + name + " is not searched; got " + terms.slice(0, 300));
  }
  // names given when the molecule is added (or later from Search & Pull) are searched
  const none = async () => new Response("{}", { status: 404 });
  await withFetch(none, () => t.call(MANAGER, "/api/molecule-add", { list: "sertraline, Zoloft", client: "k1", reuse: true }));
  ncbi.calls.length = 0; await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/pull-client", { client: "k1", from: dAgo(5), to: dAgo(0), searchMode: "precise" }));
  const t2 = decodeURIComponent(ncbi.calls.filter(c => c.startsWith("esearch")).join(" ").replace(/\+/g, " ")); assert.ok(t2.includes("Zoloft") && !t2.includes("Lustral"), t2.slice(0, 300));
  // a hand-written query is searched exactly as written
  const s2 = await t.state(); s2.watches.push({ portfolio: "X", molecule: "custom", query: "custom[ti] AND toxicity[tiab]", client: "k1" }); await t.BUCKET.put("bench.json", JSON.stringify(s2));
  ncbi.calls.length = 0; await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/pull-client", { client: "k1", from: dAgo(5), to: dAgo(0), molecules: ["X|custom"] }));
  assert.ok(decodeURIComponent(ncbi.calls.join(" ").replace(/\+/g, " ")).includes("custom[ti] AND toxicity[tiab]"));
});

test("broad search style: bare names like the PubMed website, a client switch that rewrites its searches, and a comparison with PubMed", async () => {
  const t = await makeEnv({ watches: [{ portfolio: "CNS", molecule: "sertraline", query: '"sertraline"[tiab]', names: ["Zoloft", "sertraline hydrochloride"] }], NCBI_GAP_MS: 0, RETRY_BASE_MS: 1 });
  const s = await t.state(); s.clients = [{ id: "k1", name: "Square" }]; s.watches[0].client = "k1"; await t.BUCKET.put("bench.json", JSON.stringify(s));
  await t.BUCKET.put("drugkb.json", JSON.stringify({ version: 1, ingredients: { sertraline: { name: "sertraline", rxcui: "1", brands: ["Zoloft", "Lustral"], salts: ["sertraline hydrochloride"], synonyms: [], atc: [], sources: [], enrichedAt: "x" } }, sync: {} }));
  const ncbi = fakeNcbi([{ pmid: "1", date: dAgo(2) }, { pmid: "2", date: dAgo(3) }]);
  const term = () => decodeURIComponent(ncbi.calls.filter(c => c.startsWith("esearch")).join(" ").replace(/\+/g, " "));
  const r = await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/pull-client", { client: "k1", from: dAgo(6), to: dAgo(0), dateField: "crdt", searchMode: "broad", online: false })); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.results[0].mode, "pubmed"); assert.ok(term().includes("((sertraline) OR (Zoloft) OR (sertraline hydrochloride))") && !term().includes("Lustral") && !term().includes("[tiab]"), term().slice(0, 300));
  assert.equal(typeof r.body.results[0].expected, "number", "in PubMed default mode the count is the website count"); assert.ok(r.body.results[0].term.includes("[crdt]"), "the executed term is reported");
  assert.equal((await t.call(MANAGER, "/api/client-auto", { client: "k1", searchMode: "nope" })).status, 400);
  const sw = await t.call(MANAGER, "/api/client-auto", { client: "k1", searchMode: "broad" }); assert.equal(sw.status, 200); assert.ok(sw.body.restyled <= 1, "PubMed default is already the default style");
  let st = await t.state(); assert.equal(st.clients[0].searchMode, "pubmed"); assert.ok(!/\[tiab\]/.test(st.watches[0].query) && /Zoloft/.test(st.watches[0].query), st.watches[0].query);
  assert.equal((await status(t)).perClient.find(c => c.id === "k1").searchMode, "pubmed");
  await t.call(MANAGER, "/api/client-auto", { client: "k1", searchMode: "precise" }); st = await t.state(); assert.ok(/\[tiab\]/.test(st.watches[0].query) && st.clients[0].searchMode === "precise");
  const cmp = await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/client-compare", { client: "k1", from: dAgo(6), to: dAgo(0) })); assert.equal(cmp.status, 200, JSON.stringify(cmp.body));
  const row = cmp.body.rows[0]; assert.equal(row.molecule, "sertraline"); assert.equal(row.site, 2); assert.ok(row.allTime === null || row.allTime === 2, "the undated count is asked for"); assert.ok(row.link.startsWith("https://pubmed.ncbi.nlm.nih.gov/?term="));
  const sc = await t.call(SCREENER, "/api/compare-client", { client: "k1" }); assert.ok(sc.status === 400 || sc.body.rows.every(r => r.portfolio === "CNS"), "others compare only the molecules of their own portfolios");
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

test("calcium acetate (a two-word name) is given to PubMed unquoted for its automatic term mapping, never reduced to calcium, and NCBI PubMed Central adds articles found only in full texts", async () => {
  const t = await makeEnv({ watches: [{ portfolio: "Renal", molecule: "calcium acetate", query: '"calcium acetate"[tiab]' }] });
  const s = await t.state(); s.clients = [{ id: "k1", name: "Square" }]; s.watches[0].client = "k1"; await t.BUCKET.put("bench.json", JSON.stringify(s));
  const pm = fakeNcbi([{ pmid: "1", date: dAgo(2) }]), seen = [];
  const handler = async (u, i) => { const url = new URL(String(u)), db = url.searchParams.get("db");
    if (db === "pmc") { seen.push(url.pathname.split("/").pop() + " " + (url.searchParams.get("term") || "")); if (url.pathname.endsWith("esearch.fcgi")) return new Response(JSON.stringify({ esearchresult: { count: "2", idlist: ["7001", "7002"] } }));
      return new Response(JSON.stringify({ result: { uids: ["7001", "7002"], 7001: { articleids: [{ idtype: "pmid", value: "1" }] }, 7002: { articleids: [{ idtype: "pmid", value: "77" }] } } })); }
    if (url.pathname.endsWith("esummary.fcgi") && (url.searchParams.get("id") || "").includes("77")) return new Response(JSON.stringify({ result: { uids: ["77"], 77: { title: "Calcium acetate in full text only", fulljournalname: "J Renal", pubdate: "2024", articleids: [{ idtype: "pubmed", value: "77" }] } } }));
    return pm.handler(u, i); };
  const r = await withFetch(handler, () => t.call(MANAGER, "/api/pull-client", { client: "k1", allDates: true, searchMode: "broad", includePmc: true, online: false })); assert.equal(r.status, 200, JSON.stringify(r.body));
  const term = decodeURIComponent(pm.calls.filter(c => c.startsWith("esearch")).join(" ").replace(/\+/g, " ")); assert.ok(term.includes("((calcium acetate))") && !/\(calcium\)|"calcium"/.test(term), term.slice(0, 300));
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

test("the other names of a molecule can be edited, and its search is rebuilt from the molecule and those names only", async () => {
  const t = await makeEnv({ watches: [{ portfolio: "CNS", molecule: "sertraline", query: '"sertraline"[tiab]' }] });
  assert.deepEqual((await status(t)).perWatch[0].names, []);
  await t.call(MANAGER, "/api/watch-auto", { watch: "CNS|sertraline", names: "Zoloft, Lustral" });
  const w = (await t.state()).watches[0]; assert.deepEqual(w.names, ["Zoloft", "Lustral"]); assert.ok(/Zoloft/.test(w.query) && /Lustral/.test(w.query) && !/CNS/.test(w.query), w.query);
  assert.deepEqual((await status(t)).perWatch[0].names, ["Zoloft", "Lustral"]);
  await t.call(MANAGER, "/api/watch-auto", { watch: "CNS|sertraline", names: "" }); assert.ok(!/Zoloft/.test((await t.state()).watches[0].query));
});

test("the same pull gives the same result every time, even when PubMed randomly fails a third of the requests", async () => {
  const t = await makeEnv({ watches: [W1, W2] });
  const s = await t.state(); s.clients = [{ id: "k1", name: "Acme" }]; s.watches.forEach(w => { w.client = "k1"; }); await t.BUCKET.put("bench.json", JSON.stringify(s));
  const recs = Array.from({ length: 57 }, (_, i) => ({ pmid: String(4000 + i), date: dAgo(1 + i * 6) })), ncbi = fakeNcbi(recs, { cap: 9 });
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const flaky = async (u, i) => { const r = rnd();
    if (r < 0.12) return new Response("rate", { status: 429 });
    if (r < 0.2) return new Response("<html>busy</html>", { status: 200 });
    if (r < 0.26) return new Response('{"esearchresult":{"ERROR":"Search Backend failed"}}', { status: 200 });
    if (r < 0.33 && String(u).includes("efetch")) { const full = await (await ncbi.handler(u, i)).text(); return new Response(full.slice(0, Math.floor(full.length / 2)), { status: 200 }); }
    return ncbi.handler(u, i); };
  const seen = [];
  for (let k = 0; k < 5; k++) {
    const r = await withFetch(flaky, () => t.call(MANAGER, "/api/pull-client", { client: "k1", from: dAgo(365), to: dAgo(0), searchMode: "precise" }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    seen.push(r.body.results.map(x => [x.molecule, x.expected, x.retrieved, x.complete].join(":")).join(" | "));
  }
  assert.ok(seen.every(x => x === seen[0]), "identical every time:\n" + seen.join("\n"));
  assert.ok(seen[0].split(" | ").every(x => x.endsWith(":57:57:true")), seen[0]);
  assert.equal(Object.keys((await t.state()).articles).length, 57);
});

test("book chapters, records without an English title, and PMIDs PubMed cannot supply no longer leave a pull incomplete", async () => {
  const t = await makeEnv({ watches: [W1] });
  const s = await t.state(); s.clients = [{ id: "k1", name: "Acme" }]; s.watches[0].client = "k1"; await t.BUCKET.put("bench.json", JSON.stringify(s));
  const recs = [{ pmid: "11", date: dAgo(2) }, { pmid: "12", date: dAgo(3) }, { pmid: "13", date: dAgo(4) }, { pmid: "14", date: dAgo(5) }], ncbi = fakeNcbi(recs);
  const book = '<PubmedBookArticle><BookDocument><PMID Version="1">12</PMID><ArticleTitle>Aciclovir</ArticleTitle><Book><BookTitle>LiverTox</BookTitle></Book><Abstract><AbstractText>Liver injury overview.</AbstractText></Abstract></BookDocument></PubmedBookArticle>';
  const handler = async (u, i) => { const url = new URL(String(u)), op = url.pathname.split("/").pop();
    if (op === "esummary.fcgi") { const res = await (await ncbi.handler(u, i)).json(); if (res.result["12"]) res.result["12"] = { booktitle: "LiverTox", title: "" }; if (res.result["13"]) res.result["13"] = { vernaculartitle: "Aciclovir und Leber", title: "" }; if (res.result["14"] || (url.searchParams.get("id") || "").includes("14")) res.result["14"] = { uid: "14", error: "cannot get document summary" }; return Response.json(res); }
    if (op === "efetch.fcgi") { const xml = await (await ncbi.handler(u, i)).text(); return new Response(xml.replace(/<PubmedArticle>(?:(?!<\/PubmedArticle>)[\s\S])*?<PMID[^>]*>12<\/PMID>[\s\S]*?<\/PubmedArticle>/, book)); }
    return ncbi.handler(u, i); };
  const r = await withFetch(handler, () => t.call(MANAGER, "/api/pull-client", { client: "k1", from: dAgo(10), to: dAgo(0), searchMode: "precise" })); assert.equal(r.status, 200, JSON.stringify(r.body));
  const x = r.body.results[0]; assert.equal(x.complete, true, JSON.stringify(x)); assert.equal(x.expected, 4); assert.equal(x.retrieved, 3); assert.equal(x.unavailable, 1); assert.equal(x.notStored, 0);
  const st = await t.state(); assert.ok(st.articles["12"] && /LiverTox|Aciclovir/.test(st.articles["12"].title), "the book chapter is stored"); assert.ok(st.articles["13"], "the record without an English title is stored");
  assert.ok(x.pubmedUrl.startsWith("https://pubmed.ncbi.nlm.nih.gov/?term=") && decodeURIComponent(x.pubmedUrl).includes("[crdt]"), "a link to exactly the same search");
});

test("the final PMID-by-PMID check finds an article the window searches missed and adds it to the same pull", async () => {
  const t = await makeEnv({ watches: [W1] });
  const s = await t.state(); s.clients = [{ id: "k1", name: "Acme" }]; s.watches[0].client = "k1"; await t.BUCKET.put("bench.json", JSON.stringify(s));
  const from = dAgo(200), to = dAgo(0), recs = Array.from({ length: 12 }, (_, i) => ({ pmid: String(600 + i), date: dAgo(3 + i * 15) })).concat([{ pmid: "699", date: dAgo(50) }]);
  const ncbi = fakeNcbi(recs), whole = from.replaceAll("-", "/");
  // the date-slice searches never mention PMID 699 (and their counts agree with that); only the search over the whole range lists it
  const handler = async (u, i) => { const url = new URL(String(u)), term = url.searchParams.get("term") || "";
    if (url.pathname.endsWith("esearch.fcgi") && !term.includes(whole + "[crdt]")) { const res = await (await ncbi.handler(u, i)).json(); const ids = res.esearchresult.idlist.filter(x => x !== "699"); res.esearchresult.idlist = ids; res.esearchresult.count = String(Number(res.esearchresult.count) - (res.esearchresult.idlist.length < (await (await ncbi.handler(u, i)).json()).esearchresult.idlist.length ? 1 : 0)); return Response.json(res); }
    return ncbi.handler(u, i); };
  const r = await withFetch(handler, () => t.call(MANAGER, "/api/pull-client", { client: "k1", from, to, searchMode: "precise" })); assert.equal(r.status, 200, JSON.stringify(r.body));
  const x = r.body.results[0]; assert.equal(x.idCheck, true, JSON.stringify(x)); assert.equal(x.filledByCheck, 1); assert.equal(x.retrieved, 13); assert.equal(x.complete, true);
  const st = await t.state(); assert.ok(st.articles["699"]); assert.ok(st.assignments.some(a => a.pmid === "699"), "it is in the queue too"); assert.ok(st.runs[0].ids.includes("699"), "and in the same pull");
});


test("comparison checks exact PMIDs under the selected molecule, date basis and filters", async () => {
  const molecule = "Calcium acetate", watch = { portfolio:"Renal medicines", molecule, names:[], query:'"calcium acetate"[tiab]', client:"square" };
  const t = await makeEnv({ watches:[watch,{ ...W2, client:"square" }], clients:[{ id:"square", name:"Square" }],
    articles:{ "11":{ id:"11", citationXmlKey:"existing.xml" }, "22":{ id:"22", citationXmlKey:"other.xml" } },
    assignments:[{ pmid:"11", portfolio:watch.portfolio, molecules:[molecule] },{ pmid:"22", portfolio:watch.portfolio, molecules:["Calcium chloride"] }] });
  const ncbi = fakeNcbi([{ pmid:"11", date:dAgo(2) },{ pmid:"22", date:dAgo(2) },{ pmid:"33", date:dAgo(3) }]);
  const options = { client:"square", from:dAgo(6), to:dAgo(0), dateField:"pdat", english:true, searchMode:"broad", molecules:["Renal%20medicines|Calcium%20acetate"] };
  const compared = await withFetch(ncbi.handler, () => t.call(MANAGER,"/api/compare-client",options));
  assert.equal(compared.status,200,JSON.stringify(compared.body));
  assert.equal(compared.body.rows.length,1);
  const row = compared.body.rows[0];
  assert.deepEqual([row.site,row.stored,row.missing,row.missingSample],[3,1,2,["22","33"]]);
  assert.match(row.term,/\(Calcium acetate\)/); assert.ok(!/\(Calcium\)|"Calcium"/.test(row.term), "the salt is not reduced to calcium");
  assert.match(row.term,/\[dp\].*\[dp\]/);
  assert.match(row.term,/english\[lang\]/);
  assert.doesNotMatch(row.term,/\[crdt\]|Renal medicines|Square/);
  assert.equal(new URL(row.link).searchParams.get("term"),row.term);
  const pull = await withFetch(ncbi.handler, () => t.call(MANAGER,"/api/pull-client",options));
  assert.equal(pull.body.results[0].term,row.term);
  assert.equal(pull.body.results[0].added,2);
  assert.equal(pull.body.results[0].complete,true);
  assert.equal((await t.state()).assignments.filter(a => a.pmid === "22").length,1);
});
