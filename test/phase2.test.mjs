// Phase 2: team screening and clinical extraction. Synthetic fixtures only.
import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, SCREENER, SCREENER2, MEDICAL, QC, makeEnv } from "./helpers.mjs";
import worker from "../worker/index.js";

const ACICLOVIR = `Case presentation
A 54-year-old man with chronic kidney disease received aciclovir 10 mg/kg intravenously three times daily on day 1 for herpes zoster encephalitis.
Serum creatinine rose from 1.0 to 2.4 mg/dL on day 3, consistent with renal toxicity.
On day 4 he became confused with myoclonus, suggesting neurotoxicity.
He developed status epilepticus on day 5 and was treated with levetiracetam and lorazepam, and haemodialysis was started.
Aciclovir was stopped on day 5 and the seizures resolved by day 8.
Discussion
Aciclovir may cause neurotoxicity in renal impairment. Sepsis was excluded.`;
const TWO_PATIENTS = `Case presentation
Patient 1 was a 54-year-old man with chronic kidney disease who received aciclovir 800 mg orally five times daily for herpes zoster. On day 3 he developed confusion and myoclonus. Aciclovir was stopped and he recovered by day 6.
Patient 2 was a 31-year-old woman who received aciclovir intravenously for herpes simplex encephalitis. She developed a rash on day 2 and acute kidney injury on day 4. She was treated with fluids and the creatinine normalised.`;
const AGGREGATE = `Methods
We retrospectively reviewed 120 patients treated with aciclovir in a cohort study between 2015 and 2020.
Results
Neurotoxicity occurred in 9 patients (n=9). Acute kidney injury occurred in 14 patients.`;

async function withArticle(text, { authors = ["Rao A", "Iyer S"], assignments, extra = {} } = {}) {
  const base = { id: "1", title: "Aciclovir report", abstract: "A report.", authors, pubTypes: ["Case Reports"], ...extra };
  const t = await makeEnv({ articles: { 1: base }, assignments: assignments || [{ id: "a1", pmid: "1", portfolio: "Antivirals", molecules: ["aciclovir"], reviewer: SCREENER, status: "Pending" }] });
  await t.BUCKET.put("evidence/1/fulltext.txt", text);
  const s = await t.state(); s.articles["1"].fullTextTextKey = "evidence/1/fulltext.txt"; await t.BUCKET.put("bench.json", JSON.stringify(s));
  return t;
}
const byTerm = (p, term, cat) => p.events.find(e => e.term === term && (!cat || e.category === cat));

test("aciclovir case: renal toxicity, neurotoxicity and status epilepticus keep their chronology, and findings are classified rather than all captured", async () => {
  const t = await withArticle(ACICLOVIR), s = await t.state();
  const r = await worker.extractClinical(t.env, s.articles["1"], s);
  assert.equal(r.patients.length, 1); const p = r.patients[0];
  assert.deepEqual([p.descriptor.age, p.descriptor.sex], ["54", "Male"]);
  const aciclovir = p.drugs.find(d => /aciclovir/i.test(d.name)); assert.equal(aciclovir.role, "suspect"); assert.deepEqual([aciclovir.start.day, aciclovir.stop.day, aciclovir.stop.action], [1, 5, "withdrawn"]); assert.match(aciclovir.dose, /10 mg\/kg/); assert.match(aciclovir.route, /intravenous/i);
  assert.deepEqual(p.drugs.filter(d => d.role === "treatment").map(d => d.name).sort(), ["levetiracetam", "lorazepam"]); assert.deepEqual(p.procedures.map(x => x.name), ["haemodialysis"]);
  // candidates the reviewer can capture
  for (const term of ["renal toxicity", "neurotoxicity", "status epilepticus"]) assert.equal(byTerm(p, term, "ae").status, "candidate", term);
  // everything else is classified, with the reason
  assert.equal(byTerm(p, "herpes zoster encephalitis").category, "indication"); assert.equal(byTerm(p, "chronic kidney disease").category, "history"); assert.equal(byTerm(p, "serum creatinine").category, "lab");
  assert.equal(byTerm(p, "myoclonus").category, "manifestation"); assert.equal(byTerm(p, "myoclonus").parentId, byTerm(p, "neurotoxicity").id); assert.equal(byTerm(p, "confused").parentId, byTerm(p, "neurotoxicity").id);
  assert.equal(byTerm(p, "seizures").category, "manifestation"); assert.equal(byTerm(p, "seizures").parentId, byTerm(p, "status epilepticus").id);
  // hypothetical background in the Discussion is not a patient event
  assert.equal(p.events.filter(e => e.term === "neurotoxicity").length, 1); assert.ok(!p.events.some(e => e.term === "sepsis"));
  // chronology: onsets in order, with time since the suspect was started
  assert.deepEqual([byTerm(p, "renal toxicity").onset.day, byTerm(p, "neurotoxicity").onset.day, byTerm(p, "status epilepticus").onset.day], [3, 4, 5]);
  assert.equal(byTerm(p, "neurotoxicity").timeToOnset.days, 3); assert.equal(byTerm(p, "status epilepticus").timeToOnset.days, 4);
  assert.equal(byTerm(p, "seizures").outcome.text, "Recovered/resolved");
  // exact verbatim and sentence link, apart from normalised and suggested coding
  const se = byTerm(p, "status epilepticus"); assert.equal(se.verbatim, "status epilepticus"); assert.match(se.mentions[0].sentence, /^He developed status epilepticus on day 5/); assert.equal(se.suggested.pt, "Status epilepticus"); assert.equal(se.suggested.llt, null); assert.match(se.suggested.source, /unverified/);
  assert.ok(r.unitIndex[se.mentions[0].unitId].text.includes("status epilepticus")); assert.ok(se.reasons.length >= 1);
});

test("a two-patient article gives two separate patients with no cross-patient attribution of drugs, events, history or timelines", async () => {
  const t = await withArticle(TWO_PATIENTS), s = await t.state(), r = await worker.extractClinical(t.env, s.articles["1"], s);
  assert.equal(r.patients.length, 2); const [p1, p2] = r.patients;
  assert.deepEqual([p1.descriptor.age, p1.descriptor.sex, p1.descriptor.labelText], ["54", "Male", "Patient 1"]); assert.deepEqual([p2.descriptor.age, p2.descriptor.sex, p2.descriptor.labelText], ["31", "Female", "Patient 2"]);
  const terms = p => p.events.filter(e => e.category === "ae" || e.category === "manifestation").map(e => e.term).sort();
  assert.deepEqual(terms(p1), ["confusion", "myoclonus"]); assert.deepEqual(terms(p2), ["acute kidney injury", "rash"]);
  assert.ok(p1.events.some(e => e.term === "chronic kidney disease" && e.category === "history")); assert.ok(!p2.events.some(e => e.term === "chronic kidney disease"), "history belongs to patient 1 only");
  assert.ok(p1.events.every(e => e.mentions.every(m => p1.units.includes(m.unitId)))); assert.ok(p2.events.every(e => e.mentions.every(m => p2.units.includes(m.unitId))));
  assert.equal(p1.drugs.find(d => /aciclovir/i.test(d.name)).route, "orally"); assert.match(p2.drugs.find(d => /aciclovir/i.test(d.name)).route, /intravenous/i);
  assert.equal(p1.drugs.find(d => /aciclovir/i.test(d.name)).stop.day, undefined, "the recovery day is not mistaken for the stop day"); assert.equal(p1.drugs.find(d => /aciclovir/i.test(d.name)).stop.action, "withdrawn");
  assert.ok(!p2.drugs.find(d => /aciclovir/i.test(d.name)).stop, "patient 2 was not told to stop the drug");
  assert.deepEqual(p1.timeline.map(x => x.text), ["confusion", "myoclonus"]); assert.deepEqual(p2.timeline.map(x => x.text), ["rash", "acute kidney injury"]);
  assert.equal(r.aggregateOnly, false);
});

test("aggregate-only data is recognised and does not become individual patients", async () => {
  const t = await withArticle(AGGREGATE, { extra: { pubTypes: ["Journal Article"], abstract: "A retrospective cohort." } }), s = await t.state(), r = await worker.extractClinical(t.env, s.articles["1"], s);
  assert.equal(r.aggregateOnly, true); assert.equal(r.patients.length, 0); assert.ok(r.aggregateMentions.length >= 1); assert.match(r.aggregateMentions[0].text, /patients|cohort|n=/i);
});

test("reporter attribution separates authors, correspondence, quoted clinicians and patients, and flags ambiguity", async () => {
  const text = `Case presentation\nA 54-year-old man received aciclovir. The treating nephrologist, Dr. Mehta, advised stopping it. The patient reported that he felt confused.`;
  let t = await withArticle(text, { authors: [] }), s = await t.state(), r = await worker.extractClinical(t.env, s.articles["1"], s);
  assert.equal(r.reporters.status, "missing"); assert.match(r.reporters.flags[0], /No author metadata/);
  t = await withArticle(text), s = await t.state(); r = await worker.extractClinical(t.env, s.articles["1"], s);
  assert.equal(r.reporters.status, "uncertain"); assert.equal(r.reporters.candidates[0].role, "first author"); assert.ok(r.reporters.flags.some(f => /corresponding author|contact/.test(f)));
  assert.ok(r.reporters.quoted.some(q => /Mehta/.test(q.name) && /not a reporter/.test(q.role))); assert.ok(r.reporters.patientVoice.length >= 1 && /not a reporter/.test(r.reporters.patientVoice[0].role));
  assert.ok(!r.reporters.candidates.some(c => /Mehta/.test(c.name)), "a quoted clinician is never offered as the reporter");
  // JATS metadata with a corresponding author makes attribution supported
  t = await withArticle(text); s = await t.state();
  s.articles["1"].evidence = { parsed: { key: "evidence/1/parsed.json" } }; await t.BUCKET.put("evidence/1/parsed.json", JSON.stringify({ sections: [{ title: "Case presentation", path: "Case presentation", level: 1, paragraphs: ["A 54-year-old man received aciclovir."] }], tables: [], figures: [], correspondenceEmails: ["anil.rao@test-hospital.example"], correspondence: ["Anil Rao"], authors: [{ name: "Anil Rao", affiliations: ["Dept of Nephrology, Test Hospital, Pune, India"], email: "anil.rao@test-hospital.example", corresponding: true }, { name: "Sita Iyer", affiliations: ["Dept of Neurology"], email: "", corresponding: false }] }));
  await t.BUCKET.put("bench.json", JSON.stringify(s)); r = await worker.extractClinical(t.env, s.articles["1"], s);
  assert.equal(r.reporters.status, "supported"); assert.equal(r.reporters.candidates[0].name, "Anil Rao"); assert.equal(r.reporters.candidates[0].corresponding, true);
});

test("table rows are cell-level evidence and a table can introduce patients", async () => {
  const t = await withArticle("", { extra: { abstract: "Two patients with aciclovir toxicity." } }), s = await t.state();
  s.articles["1"].evidence = { parsed: { key: "evidence/1/parsed.json" } };
  await t.BUCKET.put("evidence/1/parsed.json", JSON.stringify({ sections: [{ title: "Results", path: "Results", level: 1, paragraphs: [] }], figures: [], authors: [], tables: [{ label: "Table 1", caption: "Patients", rows: [["Patient", "Age", "Sex", "Event"], ["1", "54", "M", "Status epilepticus on day 5"], ["2", "31", "F", "Rash on day 2"]] }] }));
  await t.BUCKET.put("bench.json", JSON.stringify(s)); const r = await worker.extractClinical(t.env, s.articles["1"], s);
  assert.equal(r.patients.length, 2); const [p1, p2] = r.patients;
  assert.deepEqual([p1.descriptor.age, p1.descriptor.sex], ["54", "Male"]); assert.deepEqual([p2.descriptor.age, p2.descriptor.sex], ["31", "Female"]);
  const se = p1.events.find(e => e.term === "status epilepticus"); assert.deepEqual(se.mentions[0].cell, { table: "Table 1", row: 2 }); assert.equal(se.onset.day, 5);
  assert.ok(p2.events.some(e => e.term === "rash") && !p2.events.some(e => e.term === "status epilepticus"));
});

const team = () => ({
  profiles: [{ email: MANAGER, name: "Boss", role: "manager", active: true }, { email: SCREENER, name: "Asha", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 20 }, { email: SCREENER2, name: "Ravi", role: "reviewer", portfolio: "Anticonvulsants", active: true, capacity: 20 },
    { email: QC, name: "Quinn", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 20 }, { email: MEDICAL, name: "Meera", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 20 }],
  watches: [{ portfolio: "Antivirals", molecule: "aciclovir", query: "q" }, { portfolio: "Anticonvulsants", molecule: "levetiracetam", query: "q2" }],
  articles: { 1: { id: "1", title: "Aciclovir neurotoxicity", abstract: "A case.", authors: ["Rao A"], fullTextKey: "evidence/1/pmc.xml", fullTextStatus: "Captured" } },
  assignments: [{ id: "a1", pmid: "1", portfolio: "Antivirals", molecules: ["aciclovir"], reviewer: SCREENER, status: "In review" }, { id: "a2", pmid: "1", portfolio: "Anticonvulsants", molecules: ["levetiracetam"], reviewer: SCREENER2, status: "In review" }] });
const stateFor = async (t, who) => (await t.get(who, "/api/state")).json();

test("two portfolios review the same citation independently, each seeing only its own assignment and decisions", async () => {
  const t = await makeEnv(team()); await t.BUCKET.put("evidence/1/pmc.xml", "<article/>");
  assert.deepEqual((await stateFor(t, SCREENER)).assignments.map(a => a.id), ["a1"]); assert.deepEqual((await stateFor(t, SCREENER2)).assignments.map(a => a.id), ["a2"]);
  assert.equal((await t.call(SCREENER, "/api/disposition", { id: "a2", value: "potential_icsr" })).status, 404, "another portfolio's assignment is invisible");
  assert.equal((await t.call(SCREENER, "/api/disposition", { id: "a1", value: "excluded", reason: "made up reason" })).status, 400);
  assert.equal((await t.call(SCREENER, "/api/disposition", { id: "a1", value: "excluded", reason: "Other (explain in the note)" })).status, 400, "Other needs a note");
  assert.equal((await t.call(SCREENER, "/api/disposition", { id: "a1", value: "excluded", reason: "No suspect product" })).status, 200);
  assert.equal((await t.call(SCREENER2, "/api/disposition", { id: "a2", value: "aggregate_safety", note: "Cohort in the discussion" })).status, 200);
  const s = await t.state(), a1 = s.assignments.find(a => a.id === "a1"), a2 = s.assignments.find(a => a.id === "a2");
  assert.equal(a1.disposition.value, "excluded"); assert.equal(a1.disposition.reason, "No suspect product"); assert.equal(a2.disposition.value, "aggregate_safety"); assert.equal(a1.status, "Awaiting QC", "every rejection is re-checked by QC"); assert.equal(a1.qc.status, "pending"); assert.equal(a2.status, "Complete");
  assert.equal(Object.keys(s.articles).length, 1, "one shared article record");
  // downloads and exports follow the same access rules as the interface
  const dl = who => t.get(who, "/api/full-text/1");
  assert.equal((await dl(SCREENER)).status, 200); assert.equal((await dl(SCREENER2)).status, 200); assert.equal((await dl(QC)).status, 404); assert.equal((await dl(MEDICAL)).status, 404);
  assert.equal((await t.raw(QC, "/api/export", { pmids: ["1"] })).status, 400, "no access: nothing to export");
  assert.equal((await t.call(QC, "/api/batch-zip", { runId: "x" })).status, 403);
  const log = (await (await t.BUCKET.get("audit2/" + new Date().toISOString().slice(0, 7) + ".ndjson")).text()).trim().split("\n").map(JSON.parse).filter(e => e.action === "review.disposition");
  assert.equal(log.length, 2); assert.ok(log.every(e => e.actor.startsWith("user:")));
});

test("QC is an independent step: all potential ICSRs are checked by someone other than the screener, with return and re-submission", async () => {
  const t = await makeEnv(team());
  await t.call(MANAGER, "/api/membership-save", { email: QC, portfolio: "Antivirals", role: "qc" }); await t.call(MANAGER, "/api/membership-save", { email: SCREENER, portfolio: "Antivirals", role: "qc" });
  assert.equal((await t.call(SCREENER, "/api/membership-save", { email: QC, portfolio: "Antivirals", role: "qc" })).status, 403, "only managers grant roles");
  assert.equal((await t.call(MANAGER, "/api/membership-save", { email: QC, portfolio: "Nowhere", role: "qc" })).status, 400); assert.equal((await t.call(MANAGER, "/api/membership-save", { email: QC, portfolio: "Antivirals", role: "wizard" })).status, 400);
  const d = await t.call(SCREENER, "/api/disposition", { id: "a1", value: "potential_icsr", note: "54-year-old with status epilepticus after aciclovir" });
  assert.equal(d.status, 200); assert.equal(d.body.qc.reviewer, QC, "the QC reviewer is never the screener, even though the screener also holds the QC role");
  let a1 = (await t.state()).assignments.find(a => a.id === "a1"); assert.equal(a1.status, "Awaiting QC"); assert.equal(a1.qc.status, "pending");
  assert.equal((await t.call(SCREENER, "/api/disposition", { id: "a1", value: "excluded", reason: "No adverse event" })).status, 409, "frozen while QC is pending");
  assert.equal((await t.call(SCREENER, "/api/qc-decision", { id: "a1", decision: "approve" })).status, 409, "no self-QC");
  assert.equal((await t.call(SCREENER2, "/api/qc-decision", { id: "a1", decision: "approve" })).status, 404);
  assert.equal((await t.call(QC, "/api/qc-decision", { id: "a1", decision: "return", note: "no" })).status, 400);
  assert.equal((await t.call(QC, "/api/qc-decision", { id: "a1", decision: "return", note: "The suspect product is not clear from the abstract." })).status, 200);
  a1 = (await t.state()).assignments.find(a => a.id === "a1"); assert.equal(a1.status, "QC returned"); assert.equal(a1.qc.status, "returned");
  assert.equal((await stateFor(t, MANAGER)).monitoring.qcReturned, 1);
  assert.equal((await t.call(SCREENER, "/api/disposition", { id: "a1", value: "potential_icsr", note: "Full text confirms aciclovir" })).status, 200);
  assert.equal((await t.call(QC, "/api/qc-decision", { id: "a1", decision: "approve", note: "Agreed" })).status, 200);
  a1 = (await t.state()).assignments.find(a => a.id === "a1"); assert.equal(a1.status, "Complete"); assert.equal(a1.qc.status, "approved"); assert.equal(a1.qc.rounds, 1); assert.ok(a1.history.some(h => /QC returned/.test(h.note)) && a1.history.some(h => /QC approved/.test(h.note)));
  assert.ok((await t.state()).assignments.find(a => a.id === "a2").qc === undefined, "the other portfolio's review is untouched");
});

test("reassignment needs a reason and a portfolio manager; bulk allocation routes by availability, workload and due date", async () => {
  const state = team(); state.profiles.push({ email: "second@example.org", name: "Second", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 20 });
  state.assignments.push({ id: "a3", pmid: "1", portfolio: "Antivirals", molecules: ["aciclovir"], reviewer: "", status: "Pending" }, { id: "a4", pmid: "1", portfolio: "Antivirals", molecules: ["aciclovir"], reviewer: "", status: "Pending" });
  state.assignments[0].reviewer = SCREENER; state.assignments[0].dueAt = "2020-01-01";
  const t = await makeEnv(state);
  assert.equal((await t.call(SCREENER, "/api/reassign", { ids: ["a1"], to: "second@example.org", reason: "Holiday cover for this week" })).status, 403);
  assert.equal((await t.call(MANAGER, "/api/reassign", { ids: ["a1"], to: "second@example.org", reason: "no" })).status, 400);
  assert.equal((await t.call(MANAGER, "/api/reassign", { ids: ["a1"], to: "nobody@example.org", reason: "Holiday cover for this week" })).status, 400);
  assert.equal((await t.call(MANAGER, "/api/reassign", { ids: ["a1"], to: "second@example.org", reason: "Holiday cover for this week" })).body.moved, 1);
  let s = await t.state(), a1 = s.assignments.find(a => a.id === "a1"); assert.equal(a1.reviewer, "second@example.org"); assert.match(a1.history.at(-1).note, /Reassigned from .* to second@example.org: Holiday cover/);
  // SCREENER is away; the other screener has an overdue item; allocation prefers neither the absent nor the late one when someone else is free
  await t.call(MANAGER, "/api/profile", { email: SCREENER, name: "Asha", portfolio: "Antivirals", capacity: 20, awayFrom: "2020-01-01", awayUntil: "2099-01-01" });
  s = await t.state(); s.assignments.push({ id: "a5", pmid: "1", portfolio: "Antivirals", molecules: ["aciclovir"], reviewer: "", status: "Pending" }, { id: "a6", pmid: "1", portfolio: "Antivirals", molecules: ["aciclovir"], reviewer: "", status: "Pending" }); await t.BUCKET.put("bench.json", JSON.stringify(s));
  assert.equal((await t.call(SCREENER2, "/api/allocate-bulk", { portfolio: "Antivirals" })).status, 403);
  const r = await t.call(MANAGER, "/api/allocate-bulk", { portfolio: "Antivirals" });
  assert.equal(r.body.allocated, 2, JSON.stringify(r.body)); s = await t.state();
  for (const id of ["a5", "a6"]) { const a = s.assignments.find(x => x.id === id); assert.ok(a.reviewer && a.reviewer !== SCREENER, "the absent screener gets nothing"); assert.match(a.dueAt, /^\d{4}-\d{2}-\d{2}$/); }
  assert.ok((await stateFor(t, MANAGER)).monitoring.overdue >= 1);
  const log = (await (await t.BUCKET.get("audit2/" + new Date().toISOString().slice(0, 7) + ".ndjson")).text()).trim().split("\n").map(JSON.parse).find(e => e.action === "review.reassigned");
  assert.match(log.detail.reason, /Holiday cover/);
});

test("a screener's extraction decisions are per portfolio: promote a manifestation, exclude a candidate with a reason", async () => {
  const state = team(); const t = await makeEnv(state);
  await t.BUCKET.put("evidence/1/fulltext.txt", ACICLOVIR); const s0 = await t.state(); s0.articles["1"].fullTextTextKey = "evidence/1/fulltext.txt"; await t.BUCKET.put("bench.json", JSON.stringify(s0));
  const ex = (await t.call(SCREENER, "/api/extract", { id: "a1" })).body.extraction, p = ex.patients[0], myo = p.events.find(e => e.term === "myoclonus"), lab = p.events.find(e => e.term === "serum creatinine");
  assert.equal((await t.call(SCREENER, "/api/extraction-decide", { id: "a1", eventId: myo.id, action: "promote" })).status, 200);
  assert.equal((await t.call(SCREENER, "/api/extraction-decide", { id: "a1", eventId: lab.id, action: "exclude", reason: "" })).status, 400);
  assert.equal((await t.call(SCREENER, "/api/extraction-decide", { id: "a1", eventId: lab.id, action: "exclude", reason: "Laboratory finding only" })).status, 200);
  assert.equal((await t.call(SCREENER, "/api/extraction-decide", { id: "a1", eventId: "P9:e1", action: "promote" })).status, 404);
  assert.equal((await t.call(SCREENER, "/api/extraction-decide", { id: "a2", eventId: myo.id, action: "promote" })).status, 404, "not their portfolio");
  const mine = (await t.call(SCREENER, "/api/extract", { id: "a1" })).body, theirs = (await t.call(SCREENER2, "/api/extract", { id: "a2" })).body;
  assert.equal(mine.decisions[myo.id].action, "promote"); assert.equal(mine.decisions[lab.id].reason, "Laboratory finding only"); assert.deepEqual(theirs.decisions, {}, "the other portfolio sees none of these decisions");
});
