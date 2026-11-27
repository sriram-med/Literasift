// Admin: bulk user creation, allocation, routing back, listedness in the case form. Synthetic fixtures only.
import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, SCREENER, SCREENER2, MEDICAL, QC, makeEnv } from "./helpers.mjs";
import worker from "../worker/index.js";

const mk = async () => makeEnv({
  profiles: [{ email: MANAGER, name: "Boss", role: "manager", active: true }, { email: SCREENER, name: "Asha", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }],
  watches: [{ portfolio: "Antivirals", molecule: "aciclovir", query: "q" }],
  articles: { 1: { id: "1", title: "A", abstract: "x", authors: [] }, 2: { id: "2", title: "B", abstract: "y", authors: [] } },
  assignments: [{ id: "a1", pmid: "1", portfolio: "Antivirals", molecules: ["aciclovir"], reviewer: SCREENER, status: "Complete", disposition: { value: "potential_icsr", by: SCREENER }, qc: { status: "approved", reviewer: QC } }, { id: "a2", pmid: "2", portfolio: "Antivirals", molecules: ["aciclovir"], status: "Pending" }] });

test("a manager creates many users at once with roles; bad rows are reported and nobody else may do it", async () => {
  const t = await mk();
  const rows = [{ name: "Meera", email: MEDICAL, portfolio: "Antivirals", role: "medical_reviewer", capacity: 20 }, { name: "Quinn", email: QC, portfolio: "Antivirals", role: "qc" }, { name: "Ravi", email: SCREENER2, role: "screener", capacity: 30 }, { name: "", email: "bad", role: "screener" }, { name: "X", email: "x@example.org", role: "wizard" }];
  assert.equal((await t.call(SCREENER, "/api/users-bulk", { rows })).status, 403);
  const r = (await t.call(MANAGER, "/api/users-bulk", { rows })).body;
  assert.deepEqual([r.created, r.failed], [3, 2]); assert.deepEqual(r.results.filter(x => !x.ok).map(x => x.row), [4, 5]);
  const s = await t.state(); assert.equal(s.profiles.length, 5);
  assert.ok(s.memberships.some(m => m.email === MEDICAL && m.role === "medical_reviewer" && m.portfolio === "Antivirals")); assert.ok(s.memberships.some(m => m.email === SCREENER2 && m.portfolio === "*"));
  assert.equal(s.assignments.find(a => a.id === "a2").reviewer !== undefined, true, "unassigned work is allocated to the new people");
  const again = (await t.call(MANAGER, "/api/users-bulk", { rows: [rows[0]] })).body; assert.deepEqual([again.created, again.updated], [0, 1]);
  assert.equal((await t.call(MANAGER, "/api/users-bulk", { rows: [{ name: "Owner", email: MANAGER, role: "qc" }] })).body.failed, 1, "the owner profile is protected");
  assert.equal((await t.call(MANAGER, "/api/user-update", { email: MEDICAL, active: false })).status, 200); assert.equal((await t.state()).profiles.find(p => p.email === MEDICAL).active, false);
  assert.equal((await t.call(MANAGER, "/api/user-update", { email: MANAGER, active: false })).status, 400);
});

test("an assignment can be routed back to screening or QC with a reason; reassignment keeps its history", async () => {
  const t = await mk(); await t.call(MANAGER, "/api/users-bulk", { rows: [{ name: "Quinn", email: QC, portfolio: "Antivirals", role: "qc" }] });
  assert.equal((await t.call(SCREENER, "/api/route-back", { id: "a1", to: "screening", reason: "I want to redo this" })).status, 403);
  assert.equal((await t.call(QC, "/api/route-back", { id: "a1", to: "screening", reason: "no" })).status, 400);
  assert.equal((await t.call(QC, "/api/route-back", { id: "a1", to: "screening", reason: "Reporter evidence was misread" })).status, 200);
  const a = (await t.state()).assignments.find(x => x.id === "a1"); assert.equal(a.disposition, null); assert.equal(a.status, "Pending"); assert.equal(a.reviewer, SCREENER); assert.match(a.history.at(-1).note, /Routed back to screening.*previous disposition: potential_icsr/);
  assert.equal((await t.call(MANAGER, "/api/reassign", { ids: ["a1"], to: QC, reason: "Screener on leave" })).status, 200);
});

test("cases are routed back to Draft or to another person in bulk; approval is cleared; the case list shows who did it", async () => {
  const t = await mk(); const s = await t.state(); const rec = { id: "c1", number: "LS-2026-0001", pmid: "1", portfolio: "Antivirals", status: "Ready for medical review", assignee: SCREENER, createdBy: SCREENER, createdAt: "2026-01-01", updatedAt: "2026-01-01", approval: { hash: "x" }, data: { patient: {}, products: [], events: [], reporter: {} }, history: [], versions: [] };
  s.cases = [rec]; await t.BUCKET.put("bench.json", JSON.stringify(s));
  assert.equal((await t.call(SCREENER, "/api/case-route", { ids: ["c1"], status: "Draft", reason: "Needs more work" })).status, 403);
  assert.equal((await t.call(MANAGER, "/api/case-route", { ids: ["c1"], reason: "no target" })).status, 400);
  const r = await t.call(MANAGER, "/api/case-route", { ids: ["c1"], status: "Draft", assignee: SCREENER, reason: "Medical review found a missing outcome" }); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.moved, 1);
  const c = (await t.state()).cases[0]; assert.equal(c.status, "Draft"); assert.equal(c.approval, undefined); assert.match(c.history.at(-1).action, /routed: status Ready for medical review to Draft/);
});

test("the listedness dropdown and the exported expectedness are one value, and an override of a label decision is marked", () => {
  const e = { verbatim: { value: "x" }, listedness: { value: "Unlisted" }, expectedness: { value: "" }, listedness_assessment: { decision: "listed" } };
  const out = worker.normalizeCase({ patient: {}, products: [], events: [e] }).events[0];
  assert.equal(out.expectedness.value, "Unlisted"); assert.equal(out.listedness.value, "Unlisted"); assert.equal(out.listedness_assessment.manual_override, true);
});
