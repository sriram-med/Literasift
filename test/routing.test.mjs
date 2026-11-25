// Routing screener -> QC -> medical review, re-routing, reporting timelines and clinical summaries. Synthetic fixtures only.
import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, SCREENER, SCREENER2, MEDICAL, QC, makeEnv } from "./helpers.mjs";
import worker from "../worker/index.js";

async function setup() {
  return makeEnv({
    profiles: [{ email: MANAGER, name: "Boss", role: "manager", active: true }, { email: SCREENER, name: "Asha", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }, { email: SCREENER2, name: "Ravi", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }, { email: MEDICAL, name: "Meera", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }, { email: QC, name: "Quinn", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }],
    memberships: [{ email: MEDICAL, portfolio: "Antivirals", role: "medical_reviewer" }, { email: QC, portfolio: "Antivirals", role: "qc" }],
    articles: { 1: { id: "1", title: "A", abstract: "x", authors: [] } },
    assignments: [{ id: "a1", pmid: "1", portfolio: "Antivirals", molecules: ["aciclovir"], reviewer: SCREENER, status: "Pending" }] });
}
const stage = async t => (await t.call(MANAGER, "/api/state")).body ?? {};

test("an item moves screener -> QC -> medical reviewer on its own, and the medical reviewer is chosen by workload", async () => {
  const t = await setup();
  assert.equal((await t.call(SCREENER, "/api/disposition", { id: "a1", value: "potential_icsr" })).status, 200);
  let a = (await t.state()).assignments[0]; assert.equal(worker.stageOf(a), "qc"); assert.equal(a.qc.reviewer, QC);
  assert.equal((await t.call(QC, "/api/qc-decision", { id: "a1", decision: "approve" })).status, 200);
  a = (await t.state()).assignments[0]; assert.equal(worker.stageOf(a), "medical_review"); assert.equal(a.medicalReviewer, MEDICAL); assert.match(a.history.at(-1).note, /Routed to medical review: meera@/);
  const st = (await t.get(MEDICAL, "/api/state").then(r => r.json())); assert.equal(st.assignmentStages.a1, "medical_review");
});

test("a medical reviewer or manager re-routes any item to anybody at any stage, with a reason; nobody else can", async () => {
  const t = await setup(); await t.call(SCREENER, "/api/disposition", { id: "a1", value: "potential_icsr" }); await t.call(QC, "/api/qc-decision", { id: "a1", decision: "approve" });
  const route = (who, body) => t.call(who, "/api/route", { kind: "assignment", ids: ["a1"], ...body });
  assert.equal((await route(SCREENER, { stage: "qc", to: QC, reason: "I want QC again" })).status, 403, "a screener cannot route");
  assert.equal((await route(MEDICAL, { stage: "qc", to: QC, reason: "no" })).status, 400);
  assert.equal((await route(MEDICAL, { stage: "qc", to: "nobody@example.org", reason: "Second QC look" })).status, 400);
  assert.equal((await route(MEDICAL, { stage: "qc", to: QC, reason: "Second QC look needed" })).status, 200);
  let a = (await t.state()).assignments[0]; assert.equal(worker.stageOf(a), "qc"); assert.equal(a.qc.reviewer, QC);
  assert.equal((await route(MANAGER, { stage: "screening", to: SCREENER2, reason: "Reporter evidence misread" })).status, 200);
  a = (await t.state()).assignments[0]; assert.equal(worker.stageOf(a), "screening"); assert.equal(a.reviewer, SCREENER2); assert.equal(a.status, "Pending");
  assert.equal((await route(MANAGER, { stage: "medical_review", to: MEDICAL, reason: "Back to medical review" })).status, 200);
  a = (await t.state()).assignments[0]; assert.equal(worker.stageOf(a), "medical_review"); assert.equal(a.routedToMedical.by, MANAGER);
  assert.equal((await route(MANAGER, { stage: "closed", reason: "Nothing further to do" })).status, 200); assert.equal(worker.stageOf((await t.state()).assignments[0]), "closed");
  const log = (await (await t.BUCKET.get("audit2/" + new Date().toISOString().slice(0, 7) + ".ndjson")).text()).split("\n").filter(Boolean).map(JSON.parse).filter(e => e.action === "review.routed"); assert.equal(log.length, 4);
  // the original disposition decision (a1 had none after routing back) is kept in the history
  assert.ok(a.history.some(h => /Routed QC to Screening/.test(h.note)));
});

test("cases are routed between stages and people too, and reporting timelines and clinical summaries are supplied per case", async () => {
  const t = await setup(), s = await t.state();
  const f = x => ({ value: x }), ev = (vb, ser) => ({ verbatim: f(vb), seriousness: ser, listedness: f("Unlisted"), expectedness: f("Unlisted") });
  s.cases = [{ id: "c1", number: "LS-1", pmid: "1", portfolio: "Antivirals", molecule: "aciclovir", status: "Draft", assignee: MEDICAL, createdBy: SCREENER, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01", history: [], versions: [], stage: "medical_review",
    data: { patient: {}, reporter: {}, dates: { awareness: { value: "2026-01-10" } }, confounders: [], treatment_given: ["levetiracetam"], products: [{ name: f("aciclovir"), role: "suspect", indication: f("herpes zoster encephalitis"), action_taken: f("Drug withdrawn"), dechallenge: f("Positive: the event resolved"), rechallenge: f(""), rechallenge_basis: "unreported" }], events: [ev("status epilepticus", { serious: true, hospitalization: true })] } }];
  await t.BUCKET.put("bench.json", JSON.stringify(s));
  assert.equal((await t.call(SCREENER, "/api/route", { kind: "case", ids: ["c1"], stage: "qc", to: QC, reason: "Check coding" })).status, 403);
  assert.equal((await t.call(MEDICAL, "/api/route", { kind: "case", ids: ["c1"], stage: "qc", to: QC, reason: "Check coding please" })).status, 200);
  let c = (await t.state()).cases[0]; assert.deepEqual([c.stage, c.assignee, c.status], ["qc", QC, "Draft"]);
  const meta = (await t.get(MANAGER, "/api/state").then(r => r.json())).caseMeta.c1;
  assert.equal(meta.timeline.category, "Serious · Unlisted"); assert.equal(meta.timeline.days, 15); assert.equal(meta.timeline.start, "2026-01-10"); assert.equal(meta.timeline.due, "2026-01-25"); assert.equal(meta.timeline.status, "overdue"); assert.match(meta.timeline.startBasis, /awareness date confirmed/);
  const k = meta.clinical[0]; assert.deepEqual([k.indication, k.action, k.rechallenge, k.dcConfounded, k.rcConfounded], ["herpes zoster encephalitis", "Drug withdrawn", "Not reported", true, false], "positive dechallenge with treatment given is flagged as confounded");
  await t.call(MANAGER, "/api/case-classify", { ids: ["c1"], serious: "nonserious" });
  assert.equal((await t.get(MANAGER, "/api/state").then(r => r.json())).caseMeta.c1.timeline.days, 90, "a non-serious case runs on the 90-day clock");
});
