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
