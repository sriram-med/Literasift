// Overlapping searches (Calcium and Calcium chloride): one work item either way; per-drug counts follow the client's setting.
// Pulled articles: one table for copying, a picture, and Excel.
import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, SCREENER, makeEnv, readZip } from "./helpers.mjs";
import worker from "../worker/index.js";

const seed = () => ({
  profiles: [{ email: MANAGER, name: "Boss", role: "manager", active: true }, { email: SCREENER, name: "Asha", role: "reviewer", portfolio: "Navinta", active: true, capacity: 20 }],
  clients: [{ id: "c1", name: "Navinta" }],
  watches: [{ portfolio: "Navinta", molecule: "calcium", query: "Calcium", client: "c1" }, { portfolio: "Navinta", molecule: "calcium chloride", query: "Calcium chloride", client: "c1" }],
  articles: { 1: { id: "1", title: "Calcium chloride burns", journal: "Burns", date: "2026-11-01" }, 2: { id: "2", title: "Dietary calcium", journal: "Nutr", date: "2026-10-01" }, 3: { id: "3", title: "Calcium chloride in arrest", journal: "Resus", date: "2026-11-02" } },
  assignments: [{ id: "a1", pmid: "1", portfolio: "Navinta", molecules: ["calcium", "calcium chloride"], reviewer: SCREENER, pulledBy: SCREENER, status: "Pending", ird: "2026-11-22" },
    { id: "a2", pmid: "2", portfolio: "Navinta", molecules: ["calcium"], reviewer: SCREENER, status: "Pending", ird: "2026-11-22" },
    { id: "a3", pmid: "3", portfolio: "Navinta", molecules: ["calcium chloride", "calcium"], reviewer: SCREENER, pulledBy: SCREENER, status: "Pending", ird: "2026-11-15" }] });

test("the most specific drug is the one no other drug name contains", () => {
  const { primaryMolecule } = worker;
  assert.equal(primaryMolecule(["calcium", "calcium chloride"]), "calcium chloride");
  assert.equal(primaryMolecule(["acyclovir", "valacyclovir"]), "valacyclovir");
  assert.equal(primaryMolecule(["mirtazapine", "aripiprazole"]), "aripiprazole");
});

test("overlapping searches: counted under every drug by default, once under the most specific drug when set", async () => {
  const t = await makeEnv(seed());
  const stats = async () => Object.fromEntries((await t.call(MANAGER, "/api/drug-week-stats", { client: "c1", from: "2026-11-01", to: "2026-11-30", by: "ird" })).body.rows.map(r => [r.molecule, [r.pulled, r.shared]]));
  assert.deepEqual(await stats(), { calcium: [3, 2], "calcium chloride": [2, 2] }, "like alert emails: both drugs count the shared articles");
  assert.equal((await t.call(SCREENER, "/api/client-auto", { client: "c1", overlap: "once" })).status, 403);
  assert.equal((await t.call(MANAGER, "/api/client-auto", { client: "c1", overlap: "twice" })).status, 400);
  assert.equal((await t.call(MANAGER, "/api/client-auto", { client: "c1", overlap: "once" })).status, 200);
  assert.deepEqual(await stats(), { calcium: [1, 2], "calcium chloride": [2, 2] }, "once: the shared articles count only under calcium chloride");
  const st = (await (await t.get(SCREENER, "/api/state")).json()), a1 = st.assignments.find(a => a.id === "a1");
  assert.equal(st.assignments.length, 3, "still one work item per article"); assert.equal(a1.countedUnder, "calcium chloride"); assert.equal(a1.overlap, "once");
  const sched = (await t.call(SCREENER, "/api/scheduler-status", {})).body;
  assert.equal(sched.perClient.find(c => c.id === "c1").overlap, "once");
  const w = Object.fromEntries(sched.perWatch.filter(x => x.molecule).map(x => [x.molecule, [x.counted, x.shared]]));
  assert.deepEqual(w, { calcium: [1, 2], "calcium chloride": [2, 2] });
  // the paste box sets it too
  await t.call(MANAGER, "/api/saved-search-bulk", { client: "c1", text: "schedule | every: weekly | day: Sunday | time: 06:00 | count: alerts | overlap: each" });
  assert.equal((await t.state()).clients.find(c => c.id === "c1").overlap, undefined);
});

test("pulled articles: a table by IRD with the drug per the overlap setting, and Excel", async () => {
  const t = await makeEnv(seed());
  await t.call(MANAGER, "/api/client-auto", { client: "c1", overlap: "once" });
  const r = (await t.call(SCREENER, "/api/pulled-articles", { from: "2026-11-20", to: "2026-11-28" })).body;
  assert.deepEqual(r.rows.map(x => [x.pmid, x.drug, x.also]), [["2", "calcium", ""], ["1", "calcium chloride", "calcium"]]);
  assert.equal(r.rows[1].pulledBy, "Asha"); assert.equal(r.rows[1].journal, "Burns"); assert.equal(r.head[0], "No.");
  assert.deepEqual((await t.call(SCREENER, "/api/pulled-articles", { who: "me" })).body.rows.map(x => x.pmid).sort(), ["1", "3"]);
  const x = await t.raw(SCREENER, "/api/pulled-articles", { from: "2026-11-01", to: "2026-11-30", format: "xlsx" });
  assert.match(x.headers.get("content-type"), /spreadsheetml/);
  const sheet = readZip(await x.arrayBuffer()).get("xl/worksheets/sheet1.xml").toString("utf8");
  assert.match(sheet, /Calcium chloride burns/); assert.match(sheet, /Dietary calcium/);
});

test("overlap at three levels: all molecules, a client, one molecule; the most specific wins", async () => {
  const t = await makeEnv(seed());
  const stats = async () => Object.fromEntries((await t.call(MANAGER, "/api/drug-week-stats", { client: "c1", from: "2026-11-01", to: "2026-11-30", by: "ird" })).body.rows.map(r => [r.molecule, r.pulled]));
  assert.deepEqual(await stats(), { calcium: 3, "calcium chloride": 2 });
  assert.equal((await t.call(SCREENER, "/api/overlap-set", { scope: "all", value: "once" })).status, 403);
  assert.equal((await t.call(MANAGER, "/api/overlap-set", { scope: "all", value: "once" })).status, 200);
  assert.deepEqual(await stats(), { calcium: 1, "calcium chloride": 2 }, "default for all molecules: once");
  await t.call(MANAGER, "/api/client-auto", { client: "c1", overlap: "each" });
  assert.deepEqual(await stats(), { calcium: 3, "calcium chloride": 2 }, "the client overrides the default");
  assert.equal((await t.call(MANAGER, "/api/overlap-set", { scope: "molecule", watch: "Navinta|calcium", value: "once" })).status, 200);
  assert.deepEqual(await stats(), { calcium: 1, "calcium chloride": 2 }, "the molecule overrides the client");
  await t.call(MANAGER, "/api/overlap-set", { scope: "molecule", watch: "Navinta|calcium", value: "default" });
  await t.call(MANAGER, "/api/client-auto", { client: "c1", overlap: "default" });
  assert.deepEqual(await stats(), { calcium: 1, "calcium chloride": 2 }, "back to the default for all molecules");
  assert.equal((await t.call(MANAGER, "/api/overlap-set", { scope: "molecule", watch: "Navinta|nothing", value: "once" })).status, 404);
  const st = await (await t.get(MANAGER, "/api/state")).json();
  assert.equal(st.config.overlapDefault, "once");
});
