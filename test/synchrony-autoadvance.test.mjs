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
  const done = await worker.autoAdvance(t.env, c.number), after = (await t.state()).cases.find(x => x.id === c.id);
  console.log("ADV", done, after.stage, after.assignee, after.history.at(-1).action);
  assert.equal(done, true); { assert.equal(after.stage, "qc"); assert.equal(after.assignee, QC); assert.equal(after.screener, SCREENER); assert.match(after.history.at(-1).action, /auto-submitted/); }
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
