// Allocation: the manager numbers the articles and gives ranges (1-20, 21-40 ...) to a DE and a QC; the chosen QC gets each rejection.
import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, SCREENER, SCREENER2, QC, makeEnv } from "./helpers.mjs";

const QC2 = "venu@example.org";
const seed = () => {
  const articles = {}, assignments = [];
  for (let i = 1; i <= 6; i++) { articles[i] = { id: String(i), title: "Article " + i }; assignments.push({ id: "a" + i, pmid: String(i), portfolio: "Square", molecules: ["calcium"], reviewer: "", status: "Pending", ird: "2026-11-2" + i }); }
  return { profiles: [{ email: MANAGER, name: "Boss", role: "manager", active: true }, { email: SCREENER, name: "Sravan", role: "reviewer", active: true, capacity: 50 }, { email: SCREENER2, name: "Ravi", role: "reviewer", active: true, capacity: 50 },
      { email: QC, name: "Quinn", role: "reviewer", active: true, capacity: 50 }, { email: QC2, name: "Venu", role: "reviewer", active: true, capacity: 50 }],
    clients: [{ id: "c1", name: "Square" }], watches: [{ portfolio: "Square", molecule: "calcium", query: "calcium", client: "c1" }], articles, assignments,
    memberships: [QC, QC2].map(email => ({ email, portfolio: "Square", role: "qc" })).concat([SCREENER, SCREENER2].map(email => ({ email, portfolio: "Square", role: "screener" }))) };
};

test("ranges of numbered articles go to a DE and a QC; the chosen QC receives the rejections", async () => {
  const t = await makeEnv(seed());
  assert.equal((await t.call(SCREENER, "/api/allocation-list", {})).status, 403, "managers only");
  const list = (await t.call(MANAGER, "/api/allocation-list", {})).body;
  assert.deepEqual(list.rows.map(r => [r.no, r.pmid]), [[1, "1"], [2, "2"], [3, "3"], [4, "4"], [5, "5"], [6, "6"]], "numbered in IRD order");
  const ids = (a, b) => list.rows.filter(r => r.no >= a && r.no <= b).map(r => r.id);
  assert.equal((await t.call(MANAGER, "/api/allocation-apply", { groups: [{ ids: ids(1, 3), de: SCREENER, qc: SCREENER }] })).status, 400, "DE and QC must differ");
  assert.equal((await t.call(MANAGER, "/api/allocation-apply", { groups: [{ ids: ids(1, 3), de: SCREENER }, { ids: ids(3, 6), de: SCREENER2 }] })).status, 400, "ranges cannot overlap");
  const r = (await t.call(MANAGER, "/api/allocation-apply", { groups: [{ label: "No. 1 to 3", ids: ids(1, 3), de: SCREENER, qc: QC2 }, { label: "No. 4 to 6", ids: ids(4, 6), de: SCREENER2, qc: QC }] })).body;
  assert.equal(r.moved, 6); assert.deepEqual(r.skipped, []);
  const s = await t.state();
  assert.deepEqual(s.assignments.map(a => [a.id, a.reviewer, a.qcPlanned]), [["a1", SCREENER, QC2], ["a2", SCREENER, QC2], ["a3", SCREENER, QC2], ["a4", SCREENER2, QC], ["a5", SCREENER2, QC], ["a6", SCREENER2, QC]]);
  assert.match(s.assignments[0].history.at(-1).note, /Allocated by manager: DE .* QC .*No\. 1 to 3/);
  await t.call(SCREENER, "/api/disposition", { id: "a1", value: "excluded", reason: "No adverse event" });
  await t.call(SCREENER2, "/api/disposition", { id: "a5", value: "excluded", reason: "No adverse event" });
  const s2 = await t.state();
  assert.equal(s2.assignments.find(a => a.id === "a1").qc.reviewer, QC2, "range 1-3 goes to Venu");
  assert.equal(s2.assignments.find(a => a.id === "a5").qc.reviewer, QC, "range 4-6 goes to Quinn");
  // the open list no longer shows screened ones; changing QC later moves items already waiting
  assert.equal((await t.call(MANAGER, "/api/allocation-list", { only: "open" })).body.rows.length, 4);
  const load = Object.fromEntries((await t.call(MANAGER, "/api/allocation-list", { only: "open" })).body.load.map(p => [p.name, [p.deOpen, p.deDone, p.qcPlanned, p.qcWaiting, p.qcDone, p.byClient.Square]]));
  assert.deepEqual(load.Sravan, [2, 1, 0, 0, 0, { de: 3, qc: 0 }]); assert.deepEqual(load.Ravi, [2, 1, 0, 0, 0, { de: 3, qc: 0 }]);
  assert.deepEqual(load.Venu, [0, 0, 2, 1, 0, { de: 0, qc: 3 }], "Venu: 2 allocated, 1 waiting");
  assert.deepEqual(load.Quinn, [0, 0, 2, 1, 0, { de: 0, qc: 3 }]);
  await t.call(MANAGER, "/api/allocation-apply", { groups: [{ ids: ["a1"], qc: QC }] });
  assert.equal((await t.state()).assignments.find(a => a.id === "a1").qc.reviewer, QC);
  assert.equal((await t.call(MANAGER, "/api/allocation-apply", { groups: [{ ids: ["a1"], de: SCREENER2 }] })).body.skipped[0].why, "already screened");
});
