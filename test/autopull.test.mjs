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
