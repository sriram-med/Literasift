import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/index.js";
import { MANAGER, SCREENER, MEDICAL, QC, makeEnv } from "./helpers.mjs";
const authors = [{ name: "Anil Rao", affiliations: ["Test Hospital, India"], email: "reviewer@example.org", corresponding: true }];
const article = { id: "1", title: "Aciclovir case report", abstract: "Individual reports.", authors: ["Anil Rao"], pubTypes: ["Case Reports"], fullTextKey: "evidence/1/report.xml", evidence: { fulltext: { sha256: "a" }, parsed: { key: "evidence/1/parsed.json" } } };
const TEXT = "Patient 1 was a 54-year-old man who received aciclovir 800 mg orally on day 1 for herpes zoster. He had no rash on day 1. He developed a rash on day 4. Aciclovir was stopped on day 6 and the rash resolved. Patient 2 was a 54-year-old man who received aciclovir for herpes zoster. He was diagnosed with Stevens-Johnson syndrome on day 5, with skin blistering and mucosal erosions.";
async function env(automation = {}) {
  const t = await makeEnv({
    profiles: [{ email: MANAGER, name: "Boss", role: "manager", active: true }, { email: SCREENER, name: "Asha", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }, { email: QC, name: "Quinn", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }, { email: MEDICAL, name: "Meera", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }],
    memberships: [{ email: MEDICAL, portfolio: "Antivirals", role: "medical_reviewer" }, { email: QC, portfolio: "Antivirals", role: "qc" }],
    watches: [{ portfolio: "Antivirals", molecule: "aciclovir", query: "q" }], articles: { 1: article }, settings: { syncMode: "active", automation: { smpc: false, ...automation } },
    assignments: [{ id: "watch-1", pmid: "1", portfolio: "Antivirals", reviewer: SCREENER, molecules: ["aciclovir"], status: "Complete", disposition: { value: "potential_icsr" } }] });
  await t.BUCKET.put("evidence/1/parsed.json", JSON.stringify({ sections: [{ path: "Case presentation", title: "Case presentation", paragraphs: [TEXT] }], authors, correspondenceEmails: ["reviewer@example.org"], correspondence: ["Anil Rao"], tables: [], figures: [] }));
  return t;
}
test("incomplete drafts, drafts with exceptions and a switched-off setting all stay with the screener", async () => {
  for (const [automation, expectQc] of [[{}, null], [{ submit: false }, false]]) {
    const t = await env(automation); await t.call(MANAGER, "/api/synchrony", { action: "run" });
    const st = await t.state(), a = st.assignments[0];
    console.log("AUTO", JSON.stringify(automation), "issues", (a.synchrony?.issues || []).map(i => i.code), st.cases.map(c => [c.stage, c.assignee]));
    for (const c of st.cases) {
      if (expectQc === false || (a.synchrony?.issues || []).length) assert.equal(c.stage, "screening", "stays with the screener");
      else assert.equal(c.stage, "screening", "an incomplete draft is never auto-submitted");
    }
  }
});

test("a draft with every required field and no exceptions is sent to QC; one with a missing field is not", async () => {
  const t = await env(); await t.call(MANAGER, "/api/synchrony", { action: "run" });
  const st = await t.state(), c = st.cases.find(x => /rash/i.test(x.data.events.map(e => e.verbatim.value).join())), f = (value) => ({ value, state: "edited", evidence: [] });
  assert.equal(await worker.autoAdvance(t.env, c.number), false, "required fields and expectedness are still missing");
  assert.equal((await t.state()).cases.find(x => x.id === c.id).stage, "screening");
  const d = JSON.parse(JSON.stringify(c.data));
  d.reporter.country = f("India"); d.reporter.qualification = f("Physician"); d.products[0].indication = f("herpes zoster"); d.products[0].start_date = f("2026-10-01"); d.events[0].onset_date = f("2026-10-04"); d.events[0].outcome = f("Recovered/resolved"); d.events[0].listedness = f("Listed");
  await t.call(SCREENER, "/api/case-save", { id: c.id, status: "Draft", data: d });
  const tick = await scheduled(t);
  assert.equal(tick.status, 200, JSON.stringify(tick.body));
  assert.equal(tick.body.advanced, 1);
  const after = (await t.state()).cases.find(x => x.id === c.id);
  assert.equal(after.stage, "qc");
  assert.equal(after.assignee, QC);
  assert.equal(after.screener, SCREENER);
  assert.match(after.history.at(-1).action, /auto-submitted/);
  assert.equal((await scheduled(t)).body.advanced, 0);
  const final = (await t.state()).cases.find(x => x.id === c.id);
  assert.equal(final.history.filter(h => h.action.includes("auto-submitted")).length, 1);

  await update(t, state => {
    const returned = state.cases.find(x => x.id === c.id);
    returned.stage = "screening";
    returned.assignee = SCREENER;
    returned.qc = { status: "returned", flags: [] };
  });
  assert.equal((await scheduled(t)).body.advanced, 0);
  assert.equal((await t.state()).cases.find(x => x.id === c.id).stage, "screening");
});

test("My Desk queues, source labels, deadline basis and the jobs board", async () => {
  const t = await env(); await t.call(MANAGER, "/api/synchrony", { action: "run" });
  const st = await t.state(), c = st.cases.find(x => /rash/i.test(x.data.events.map(e => e.verbatim.value).join()));
  // each finding says where it came from
  const art = st.articles["1"]; assert.equal(worker.evidenceKind(art, { section: "Abstract", excerpt: "x" }), "abstract"); assert.equal(worker.evidenceKind(art, { section: "Table 2", excerpt: "x" }), "table");
  assert.equal(worker.evidenceKind(art, { section: "Case presentation", excerpt: "x" }), "full text"); assert.equal(worker.evidenceKind({ evidence: { fulltext: { extraction: { method: "ocr" } } } }, { section: "Body", excerpt: "x" }), "OCR");
  assert.ok(["abstract", "full text", "table", "OCR"].includes(worker.assessmentMatrix(st, c)[0].source), "matrix rows carry a source label");
  // an unconfirmed awareness date is named as the basis of the clock
  const dl = worker.deadlineBasis(st, c); assert.equal(dl.awarenessConfirmed, false); assert.match(dl.basis, /not confirmed|confirm the awareness/);
  // the five queues, one next action each
  const me = { email: SCREENER, role: "reviewer" }, fake = JSON.parse(JSON.stringify(st));
  const fc = fake.cases.find(x => x.id === c.id); fc.dueAt = "2000-01-01"; fc.qc = { status: "returned", flags: [{ path: "events.0.verbatim", label: "Reaction", status: "open", was: "x" }] };
  fake.assignments[0].synchrony = { status: "failed", attempts: 3, error: "source timed out", issues: [{ code: "full_text", text: "No authorised full text", action: "Attach the PDF" }] };
  const q = worker.deskQueues(fake, me);
  for (const k of ["dueSoon", "qcReturns", "failedJobs", "missingEvidence"]) { assert.ok(q[k].length >= 1, k); for (const i of q[k]) assert.ok(i.owner && i.reason && i.action, k + " item has owner, reason and action"); }
  assert.match(q.dueSoon[0].reason, /Overdue/); assert.match(q.qcReturns[0].reason, /Reaction/);
  const board = worker.jobsBoard(fake); assert.equal(board.counts.failed, 1); assert.equal(board.failures[0].attempts, 3); assert.equal(board.sourceFailures.length, 1);
  assert.deepEqual((await t.call(QC, "/api/synchrony", { action: "desk" })).body.queues.qcReturns, [], "other people's queues stay empty");
});

const scheduled = t => t.call("", "/api/synchrony-tick", {}, { Authorization: "Bearer " + t.env.RUN_TOKEN });
async function update(t, mutate) {
  const state = await t.state();
  mutate(state);
  await t.BUCKET.put("bench.json", JSON.stringify(state));
}
async function pending(t, settings = {}) {
  await update(t, state => {
    Object.assign(state.settings, settings);
    state.assignments[0].status = "Pending";
    delete state.assignments[0].disposition;
  });
}

test("scheduled screening advances an evidence-backed citation once and prepares patient-specific drafts", async () => {
  const t = await env();
  await pending(t);
  const r = await scheduled(t);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.screened, 1);
  const state = await t.state();
  assert.equal(state.assignments[0].disposition.by, "system");
  assert.equal(state.assignments[0].disposition.value, "potential_icsr");
  assert.equal(state.cases.length, 2);
  assert.equal(new Set(state.cases.map(c => c.provenance.patientId)).size, 2);
  assert.ok(state.cases.every(c => c.automation && c.stage === "screening"));
  assert.equal((await scheduled(t)).body.screened, 0);
  assert.equal((await t.state()).cases.length, 2);
});

test("article QC still gates automated preparation when required", async () => {
  const t = await env();
  await pending(t, { qcPotentialIcsr: true });
  assert.equal((await scheduled(t)).body.screened, 1);
  const state = await t.state();
  assert.equal(state.assignments[0].qc.status, "pending");
  assert.equal(state.assignments[0].qc.reviewer, QC);
  assert.equal((state.cases || []).length, 0);
  const qc = await t.call(QC, "/api/qc-decision", { id: "watch-1", decision: "approve" });
  assert.equal(qc.status, 200, JSON.stringify(qc.body));
  assert.equal((await scheduled(t)).body.created, 2);
});

test("uncertain evidence, existing decisions and portfolios outside Active screening stay in review", async () => {
  for (const settings of [{ syncMode: "shadow" }, { syncActivePortfolios: ["Other"] }, { syncAutoScreen: false }]) {
    const t = await env();
    await pending(t, settings);
    assert.equal((await scheduled(t)).body.screened, 0);
    assert.equal((await t.state()).assignments[0].disposition, undefined);
  }
  const t = await env();
  await pending(t);
  const textKey = article.evidence.parsed.key;
  const parsed = await (await t.BUCKET.get(textKey)).json();
  await t.BUCKET.put(textKey, JSON.stringify({ ...parsed, authors: [], correspondence: [], correspondenceEmails: [] }));
  assert.equal((await scheduled(t)).body.screened, 0);
  const state = await t.state();
  assert.equal(state.assignments[0].syncScreen.status, "needs_review");
  assert.equal(state.assignments[0].disposition, undefined);
  const excluded = await t.call(SCREENER, "/api/disposition", { id: "watch-1", value: "aggregate_safety" });
  assert.equal(excluded.status, 200);
  await t.BUCKET.put(textKey, JSON.stringify(parsed));
  assert.equal((await scheduled(t)).body.screened, 0);
  assert.equal((await t.state()).assignments[0].disposition.value, "aggregate_safety");
});

test("scheduler resumes enrichment after interruption and keeps the case history idempotent", async () => {
  const t = await env({ auto: false });
  assert.equal((await scheduled(t)).body.created, 2);
  await update(t, state => {
    state.settings.automation.auto = true;
    state.cases[0].syncEnrichment = { status: "running", until: Date.now() - 1, attempts: 1, lease: "interrupted" };
  });
  const result = await scheduled(t);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.created, 0);
  await scheduled(t);
  for (const c of (await t.state()).cases) {
    assert.ok(c.automation);
    assert.equal(c.syncEnrichment, undefined);
    assert.equal(c.history.filter(h => h.action.startsWith("automation ran")).length, 1);
  }
});
