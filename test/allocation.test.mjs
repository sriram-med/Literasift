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
  const list = (await t.call(MANAGER, "/api/allocation-list", { from: "", to: "" })).body;
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
  assert.equal((await t.call(MANAGER, "/api/allocation-list", { from: "", to: "", only: "open" })).body.rows.length, 4);
  const load = Object.fromEntries((await t.call(MANAGER, "/api/allocation-list", { from: "", to: "", only: "open" })).body.load.map(p => [p.name, [p.deOpen, p.deDone, p.qcPlanned, p.qcWaiting, p.qcDone, p.byClient.Square]]));
  assert.deepEqual(load.Sravan, [2, 1, 0, 0, 0, { de: 3, qc: 0 }]); assert.deepEqual(load.Ravi, [2, 1, 0, 0, 0, { de: 3, qc: 0 }]);
  assert.deepEqual(load.Venu, [0, 0, 2, 1, 0, { de: 0, qc: 3 }], "Venu: 2 allocated, 1 waiting");
  assert.deepEqual(load.Quinn, [0, 0, 2, 1, 0, { de: 0, qc: 3 }]);
  await t.call(MANAGER, "/api/allocation-apply", { groups: [{ ids: ["a1"], qc: QC }] });
  assert.equal((await t.state()).assignments.find(a => a.id === "a1").qc.reviewer, QC);
  assert.equal((await t.call(MANAGER, "/api/allocation-apply", { groups: [{ ids: ["a1"], de: SCREENER2 }] })).body.skipped[0].why, "already screened");
});

test("allocation shows this week by default; rejections QC agrees with are archived and can be restored", async () => {
  const st = seed(); const d = n => new Date(Date.now() + 5.5 * 3600000 - n * 864e5).toISOString().slice(0, 10);
  st.assignments.forEach((a, i) => { a.ird = i < 3 ? d(0) : "2026-01-05"; a.reviewer = SCREENER; });
  const t = await makeEnv(st);
  const wk = (await t.call(MANAGER, "/api/allocation-list", {})).body;
  assert.equal(wk.rows.length, 3, "older weeks are not listed"); assert.ok(wk.from <= d(0) && wk.to >= d(0));
  const mon = new Date(wk.from + "T00:00:00Z"); assert.equal(mon.getUTCDay(), 1, "weeks start on Monday");
  await t.call(SCREENER, "/api/disposition", { id: "a1", value: "excluded", reason: "No adverse event" });
  await t.call(SCREENER, "/api/disposition", { id: "a2", value: "excluded", reason: "No adverse event" });
  await t.call(QC, "/api/qc-decision", { id: "a1", decision: "approve", note: "Agree" });
  await t.call(QC, "/api/qc-decision", { id: "a2", decision: "return", note: "Please recheck the table" });
  const s = await t.state(); assert.equal(s.assignments.find(a => a.id === "a1").archived.reason, "Rejection agreed by QC"); assert.equal(s.assignments.find(a => a.id === "a2").archived, undefined, "sent back stays active");
  const view = await (await t.get(SCREENER, "/api/state")).json();
  assert.ok(!view.assignments.some(a => a.id === "a1"), "gone from the DE's queue and Library"); assert.deepEqual(view.archivedArticles.map(a => [a.pmid, a.qcName]), [["1", "Quinn"]]);
  assert.ok((await (await t.get(QC, "/api/state")).json()).archivedArticles.some(a => a.id === "a1"), "QC sees it in the Archive");
  assert.equal((await t.call(MANAGER, "/api/allocation-list", { only: "all" })).body.rows.length, 2, "and gone from Allocation");
  assert.equal((await t.call(SCREENER, "/api/article-restore", { id: "a1" })).status, 403);
  assert.equal((await t.call(QC, "/api/article-restore", { id: "a1" })).status, 200);
  assert.equal((await t.state()).assignments.find(a => a.id === "a1").archived, undefined);
  // older agreed rejections can be archived in one go; the setting turns automatic archiving off
  const s2 = await t.state(); s2.assignments.find(a => a.id === "a1").archived = undefined; await t.BUCKET.put("bench.json", JSON.stringify(s2));
  assert.equal((await t.call(MANAGER, "/api/archive-agreed", {})).body.archived, 1);
  await t.call(MANAGER, "/api/settings", { autoArchiveRejected: false });
  await t.call(SCREENER, "/api/disposition", { id: "a3", value: "excluded", reason: "No adverse event" });
  await t.call(QC, "/api/qc-decision", { id: "a3", decision: "approve" });
  assert.equal((await t.state()).assignments.find(a => a.id === "a3").archived, undefined);
});

test("teams: saved DE + QC pairs for the weekly allocation", async () => {
  const t = await makeEnv(seed());
  assert.equal((await t.call(SCREENER, "/api/alloc-teams", { teams: [] })).status, 403);
  assert.equal((await t.call(MANAGER, "/api/alloc-teams", { teams: [{ de: SCREENER, qc: SCREENER }] })).status, 400, "DE and QC differ");
  assert.equal((await t.call(MANAGER, "/api/alloc-teams", { teams: [{ de: SCREENER, qc: QC }, { de: SCREENER, qc: QC2 }] })).status, 400, "one team per DE");
  assert.equal((await t.call(MANAGER, "/api/alloc-teams", { teams: [{ qc: QC }] })).status, 400, "a team needs a DE");
  const ok = (await t.call(MANAGER, "/api/alloc-teams", { teams: [{ de: SCREENER, qc: QC2 }, { de: SCREENER2, qc: QC }] })).body;
  assert.equal(ok.teams.length, 2);
  const list = (await t.call(MANAGER, "/api/allocation-list", { from: "", to: "" })).body;
  assert.deepEqual(list.teams.map(x => [x.de, x.qc]), [[SCREENER, QC2], [SCREENER2, QC]]);
});

test("team counts for every role's Dashboard: names and counts only, no emails for non-managers", async () => {
  const t = await makeEnv(seed());
  await t.call(MANAGER, "/api/alloc-teams", { teams: [{ de: SCREENER, qc: QC2 }, { de: SCREENER2, qc: QC }] });
  const list = (await t.call(MANAGER, "/api/allocation-list", { from: "", to: "" })).body;
  await t.call(MANAGER, "/api/allocation-apply", { groups: [{ ids: list.rows.slice(0, 3).map(r => r.id), de: SCREENER, qc: QC2 }, { ids: list.rows.slice(3).map(r => r.id), de: SCREENER2, qc: QC }] });
  const de = (await t.call(SCREENER, "/api/team-counts", { from: "2026-11-01", to: "2026-11-30" })).body;
  assert.deepEqual(de.teams, [{ de: "Sravan", qc: "Venu" }, { de: "Ravi", qc: "Quinn" }]);
  const sr = de.load.find(p => p.name === "Sravan"); assert.equal(sr.deOpen, 3); assert.equal(sr.email, "Sravan");
  assert.ok(!JSON.stringify(de).includes("@example.org"), "no email addresses for non-managers");
  assert.equal((await t.call(QC, "/api/team-counts", { from: "2026-11-01", to: "2026-11-30" })).body.load.find(p => p.name === "Quinn").qcPlanned, 3);
  assert.equal((await t.call(MANAGER, "/api/team-counts", { from: "2026-11-01", to: "2026-11-30" })).body.teams[0].de, SCREENER);
});
