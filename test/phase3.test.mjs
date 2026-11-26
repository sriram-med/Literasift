// Phase 3: ICSR automation and controlled outputs. Synthetic fixtures only.
import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, SCREENER, SCREENER2, MEDICAL, QC, makeEnv, readZip, haveXsd, ICH_DIR } from "./helpers.mjs";
import worker from "../worker/index.js";
import { makeXsdValidator } from "../server/xsd.mjs";

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
const AGGREGATE = `Methods\nWe retrospectively reviewed 120 patients treated with aciclovir in a cohort study.\nResults\nNeurotoxicity occurred in 9 patients (n=9).`;
const AUTHORS = [{ name: "Anil Rao", affiliations: ["Department of Nephrology, Test Hospital, Pune, India"], email: "anil.rao@test-hospital.example", corresponding: true }, { name: "Sita Iyer", affiliations: ["Department of Neurology, Test Hospital, Pune, India"], email: "", corresponding: false }];

// One article, one assignment already through screening (potential ICSR), team with a medical reviewer.
async function scenario(text, { authors = AUTHORS, abstract = "A case report.", article = {}, qc = false } = {}) {
  const secs = []; for (const line of text.split("\n")) { if (/^[A-Z][A-Za-z ]{2,30}$/.test(line)) secs.push({ path: line, title: line, paragraphs: [] }); else if (line.trim()) { if (!secs.length) secs.push({ path: "Case presentation", title: "Case presentation", paragraphs: [] }); secs.at(-1).paragraphs.push(line); } }
  const parsed = { sections: secs, tables: [], figures: [], authors, correspondenceEmails: authors.filter(a => a.email).map(a => a.email), correspondence: authors.filter(a => a.corresponding).map(a => a.name) };
  const t = await makeEnv({
    profiles: [{ email: MANAGER, name: "Boss", role: "manager", active: true }, { email: SCREENER, name: "Asha", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }, { email: MEDICAL, name: "Meera", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }, { email: QC, name: "Quinn", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }],
    memberships: [{ email: MEDICAL, portfolio: "Antivirals", role: "medical_reviewer" }, { email: QC, portfolio: "Antivirals", role: "qc" }],
    watches: [{ portfolio: "Antivirals", molecule: "aciclovir", query: "q" }],
    articles: { 1: { id: "1", title: "Aciclovir neurotoxicity: a case report", abstract, authors: authors.map(a => a.name), journal: "J Test", date: "2021", doi: "10.1234/1", pubTypes: ["Case Reports"], pullAt: "2026-11-01T10:00:00Z", evidence: { parsed: { key: "evidence/1/parsed.json" } }, fullTextTextKey: "evidence/1/fulltext.txt", ...article } },
    assignments: [{ id: "a1", pmid: "1", portfolio: "Antivirals", molecules: ["aciclovir"], reviewer: SCREENER, status: "Complete", disposition: { value: "potential_icsr", by: SCREENER, at: "2026-11-02T00:00:00Z" }, ...(qc ? { qc: { status: "approved", reviewer: QC } } : {}) }] });
  await t.BUCKET.put("evidence/1/fulltext.txt", text); await t.BUCKET.put("evidence/1/parsed.json", JSON.stringify(parsed));
  t.cases = async () => (await t.state()).cases || [];
  return t;
}
const fld = value => ({ value, state: "edited", evidence: [] });

test("a two-patient article produces two separate drafts, each with its own evidence, drugs, events and history, and the three decisions are kept apart", async () => {
  const t = await scenario(TWO_PATIENTS);
  const crit = (await t.call(SCREENER, "/api/criteria", { id: "a1" })).body;
  assert.equal(crit.patients.length, 2); for (const p of crit.patients) { assert.equal(p.overall, "supported"); for (const k of ["patient", "reporter", "product", "event"]) { assert.equal(p.criteria[k].status, "supported", p.id + " " + k); } assert.ok(p.criteria.patient.evidence.length >= 1 && p.criteria.patient.evidence[0].sentence); }
  const made = (await t.call(SCREENER, "/api/drafts-create", { id: "a1" })).body;
  assert.equal(made.created.length, 2, JSON.stringify(made)); const cases = await t.cases();
  const c1 = cases.find(c => c.provenance.patientId === "P1"), c2 = cases.find(c => c.provenance.patientId === "P2");
  assert.equal(cases.length, 2); assert.notEqual(c1.number, c2.number);
  const terms = c => c.data.events.map(e => e.verbatim.value).sort();
  assert.deepEqual(terms(c1), ["confusion", "myoclonus"]); assert.deepEqual(terms(c2), ["acute kidney injury", "rash"]);
  assert.equal(c1.data.patient.age.value, "54"); assert.equal(c2.data.patient.sex.value, "Female"); assert.deepEqual(c1.data.patient.medical_history.map(h => h.value), ["chronic kidney disease"]); assert.deepEqual(c2.data.patient.medical_history, []);
  assert.equal(c1.data.products[0].route.value, "orally"); assert.match(c2.data.products[0].route.value, /intravenous/i);
  assert.equal(c1.data.products[0].stop_day, null, "stop day is not guessed from the recovery day"); assert.equal(c1.data.products[0].action_taken.value, "Drug withdrawn"); assert.ok(!c2.data.products[0].action_taken.value);
  for (const c of [c1, c2]) { for (const e of c.data.events) assert.ok(e.verbatim.evidence[0].excerpt.length > 10 && e.verbatim.evidence[0].unit, "each event links to its source sentence"); assert.equal(c.provenance.extractionVersion, "clinical-extraction/1"); assert.equal(c.versions[0].action, "created"); }
  assert.ok(c1.data.events.every(e => !/rash|kidney/.test(e.verbatim.value)) && c2.data.events.every(e => !/confusion|myoclonus/.test(e.verbatim.value)), "no cross-patient attribution");
  // separate decisions and separate dates
  assert.equal((await t.state()).assignments[0].disposition.value, "potential_icsr"); assert.equal(c1.data.minimum_criteria.overall, "supported"); assert.equal(c1.data.reportability.decision, null);
  assert.deepEqual(c1.data.dates, { publication: "2021", retrieved: "2026-11-01T10:00:00Z", reviewed: null, awareness: null });
  // idempotent: asking again creates nothing new
  const again = (await t.call(SCREENER, "/api/drafts-create", { id: "a1" })).body; assert.equal(again.created.length, 0); assert.equal(again.existing.length, 2); assert.equal((await t.cases()).length, 2);
});

test("aciclovir case: chronology, classified findings, dechallenge basis and seriousness basis reach the draft; the reviewer decides which findings are captured", async () => {
  const t = await scenario(ACICLOVIR);
  const ex = (await t.call(SCREENER, "/api/extract", { id: "a1" })).body.extraction, p = ex.patients[0], myo = p.events.find(e => e.term === "myoclonus");
  await t.call(SCREENER, "/api/extraction-decide", { id: "a1", eventId: myo.id, action: "promote" });
  const neuro = p.events.find(e => e.term === "neurotoxicity"); await t.call(SCREENER, "/api/extraction-decide", { id: "a1", eventId: neuro.id, action: "exclude", reason: "Described as a clinical impression only" });
  const made = (await t.call(SCREENER, "/api/drafts-create", { id: "a1" })).body; assert.equal(made.created.length, 1, JSON.stringify(made));
  const c = (await t.cases())[0], ev = c.data.events, names = ev.map(e => e.verbatim.value);
  assert.ok(names.includes("renal toxicity") && names.includes("status epilepticus") && names.includes("myoclonus")); assert.ok(!names.includes("neurotoxicity"), "an excluded candidate is not captured");
  assert.ok(!names.includes("serum creatinine") && !names.includes("herpes zoster encephalitis") && !names.includes("chronic kidney disease"), "labs, indications and history are not events");
  assert.deepEqual(c.data.patient.medical_history.map(h => h.value), ["chronic kidney disease"]); assert.equal(c.data.products[0].indication.value, "herpes zoster encephalitis");
  assert.deepEqual(c.data.treatment_given.sort(), ["haemodialysis", "levetiracetam", "lorazepam"]);
  const se = ev.find(e => e.verbatim.value === "status epilepticus"); assert.match(se.time_to_onset.value, /4 days after the suspect drug was started/); assert.equal(se.onset_day, 5); assert.match(se.seriousness_basis.value, /other medically important/); assert.ok(se.seriousness.serious); assert.ok(se.manifestations.some(m => m.verbatim === "seizures"));
  assert.equal(c.data.products[0].dechallenge_basis, "reported"); assert.match(c.data.products[0].dechallenge.value, /Positive/); assert.equal(c.data.products[0].rechallenge_basis, "unreported"); assert.ok(!c.data.products[0].rechallenge.value);
  assert.ok(ev.every(e => e.needs_medical_judgment.length >= 1), "each event lists what a medical reviewer still has to decide");
  assert.equal(se.pt.value, "Status epilepticus"); assert.ok(!se.pt_code.value); assert.equal(se.coding_status.value, "Proposed (unverified lexicon)");
  assert.equal(c.data.confounders.some(x => x.type === "Laboratory finding"), true);
  // narrative in chronological order, each statement linked to evidence
  const gen = await t.call(MEDICAL, "/api/narrative-generate", { caseId: c.id }); assert.equal(gen.status, 200, JSON.stringify(gen.body));
  const st = gen.body.narrative.statements, order = st.filter(s => s.kind === "event").map(s => ["renal toxicity", "myoclonus", "status epilepticus"].find(n => s.text.includes(n)));
  assert.deepEqual(order.slice(0, 2), ["renal toxicity", "myoclonus"]); assert.ok(order.indexOf("status epilepticus") > order.indexOf("myoclonus"));
  const evs = st.find(s => s.kind === "event" && /status epilepticus/.test(s.text)); assert.match(evs.evidence[0].excerpt, /status epilepticus on day 5/); assert.equal(evs.evidence[0].pmid, "1");
  assert.ok(st.find(s => s.kind === "dechallenge").text.includes("Positive")); assert.equal(st.at(-1).kind === "causality_company" || st.at(-1).kind === "confounders", true);
  const edited = await t.call(MEDICAL, "/api/narrative-save", { caseId: c.id, text: gen.body.narrative.text + " Reviewer addition: no rechallenge was performed." }); assert.equal(edited.body.narrative.edited, true); assert.equal(edited.body.narrative.statements.length, st.length);
});

test("ambiguous reporter evidence stops a draft until a reviewer confirms with a reason, and a missing reporter blocks it", async () => {
  const t1 = await scenario(TWO_PATIENTS.split("Patient 2")[0], { authors: [{ name: "Anil Rao", affiliations: [], email: "", corresponding: false }] });
  const crit = (await t1.call(SCREENER, "/api/criteria", { id: "a1" })).body; assert.equal(crit.patients[0].criteria.reporter.status, "uncertain"); assert.equal(crit.patients[0].overall, "uncertain");
  assert.ok(crit.patients[0].gaps.some(g => /reporter/i.test(g.item)), "the follow-up checklist asks for the reporter's details");
  let r = (await t1.call(SCREENER, "/api/drafts-create", { id: "a1" })).body; assert.equal(r.created.length, 0); assert.match(r.skipped[0].reason, /uncertain/); assert.deepEqual(r.skipped[0].uncertain, ["reporter"]);
  r = (await t1.call(SCREENER, "/api/drafts-create", { id: "a1", force: { P1: "Author confirmed by e-mail on 3 November" } })).body; assert.equal(r.created.length, 1); assert.equal((await t1.cases())[0].provenance.forced, "Author confirmed by e-mail on 3 November");
  const t2 = await scenario(TWO_PATIENTS.split("Patient 2")[0], { authors: [] });
  const r2 = (await t2.call(SCREENER, "/api/drafts-create", { id: "a1" })).body; assert.equal(r2.created.length, 0); assert.match(r2.skipped[0].reason, /Minimum criteria not met: reporter/);
});

test("aggregate-only data never becomes an individual case draft; screening gates and QC gates apply", async () => {
  const t = await scenario(AGGREGATE, { article: { pubTypes: ["Journal Article"] } });
  const crit = (await t.call(SCREENER, "/api/criteria", { id: "a1" })).body; assert.equal(crit.aggregateOnly, true); assert.equal(crit.patients.length, 0);
  assert.equal((await t.call(SCREENER, "/api/drafts-create", { id: "a1" })).status, 409); assert.equal((await t.cases()).length, 0);
  const t2 = await scenario(TWO_PATIENTS); const s = await t2.state(); s.assignments[0].disposition.value = "excluded"; await t2.BUCKET.put("bench.json", JSON.stringify(s));
  assert.equal((await t2.call(SCREENER, "/api/drafts-create", { id: "a1" })).status, 409, "only potential ICSRs get drafts");
  const t3 = await scenario(TWO_PATIENTS, { qc: false }); const s3 = await t3.state(); s3.assignments[0].qc = { status: "pending", reviewer: QC }; await t3.BUCKET.put("bench.json", JSON.stringify(s3));
  assert.equal((await t3.call(SCREENER, "/api/drafts-create", { id: "a1" })).status, 409, "waiting for QC");
  assert.ok([403, 404].includes((await t3.call(SCREENER2, "/api/drafts-create", { id: "a1" })).status));
});

test("duplicate and follow-up review: matches are explained, linking needs a person, the original case is preserved, and the follow-up diff shows what changed", async () => {
  const t = await scenario(ACICLOVIR), s0 = await t.state();
  s0.articles["2"] = { id: "2", title: "Long-term follow-up of aciclovir neurotoxicity", abstract: "Follow-up.", authors: ["Anil Rao"], journal: "J Test Case Rep", date: "2022", pubTypes: ["Case Reports"] };
  s0.articles["3"] = { id: "3", title: "Aciclovir toxicity, conference abstracts", abstract: "Abstract.", authors: ["Other Person"], journal: "Annual Meeting Abstracts", date: "2021", pubTypes: ["Congress"] };
  s0.assignments.push({ id: "a2", pmid: "2", portfolio: "Antivirals", molecules: ["aciclovir"], reviewer: SCREENER, status: "Complete", disposition: { value: "potential_icsr", by: SCREENER } });
  await t.BUCKET.put("bench.json", JSON.stringify(s0));
  await t.call(SCREENER, "/api/drafts-create", { id: "a1" });
  const original = (await t.cases())[0]; const originalData = JSON.stringify(original.data);
  // a follow-up case for the same patient, later: more outcome information
  const f = data => ({ ...data, patient: { ...data.patient }, products: data.products.map(p => ({ ...p })), events: data.events.map(e => ({ ...e })) });
  const follow = JSON.parse(JSON.stringify(original)); follow.id = "follow-1"; follow.number = "LS-2026-0900"; follow.pmid = "2"; follow.createdAt = "2026-12-01T00:00:00Z"; follow.provenance = { patientId: "P1", idempotencyKey: "draft|2|P1|Antivirals" }; follow.versions = []; follow.links = []; void f;
  follow.data.events.forEach(e => { if (e.verbatim.value === "status epilepticus") { e.outcome = fld("Recovered with sequelae"); } });
  const different = JSON.parse(JSON.stringify(original)); different.id = "other-1"; different.number = "LS-2026-0901"; different.pmid = "3"; different.createdAt = "2026-12-02T00:00:00Z"; different.provenance = { patientId: "P1" }; different.data.patient.age = fld("29"); different.data.patient.sex = fld("Female"); different.versions = []; different.links = [];
  const s = await t.state(); s.cases.push(follow, different); await t.BUCKET.put("bench.json", JSON.stringify(s));
  const dup = (await t.call(MEDICAL, "/api/duplicates", { caseId: follow.id })).body.candidates;
  assert.equal(dup.length, 1, "the different patient is not suggested"); assert.equal(dup[0].number, original.number); assert.equal(dup[0].level, "probable"); assert.equal(dup[0].relation, "");
  const why = dup[0].reasons.map(r => r.text).join(" | "); for (const part of ["Same patient descriptors: 54", "Same suspect product: aciclovir", "Same product-event pair", "Same first author", "Same site"]) assert.match(why, new RegExp(part));
  assert.equal(dup[0].link, null, "nothing is linked until a person confirms");
  assert.equal((await t.call(MEDICAL, "/api/duplicate-decide", { caseId: follow.id, otherId: original.id, decision: "follow_up", note: "no" })).status, 400);
  assert.ok([403, 404].includes((await t.call(SCREENER2, "/api/duplicate-decide", { caseId: follow.id, otherId: original.id, decision: "follow_up", note: "Same patient, later report" })).status));
  const decided = await t.call(MEDICAL, "/api/duplicate-decide", { caseId: follow.id, otherId: original.id, decision: "follow_up", note: "Same patient and event; the follow-up adds the outcome" });
  assert.equal(decided.status, 200, JSON.stringify(decided.body)); assert.equal(decided.body.earlier, original.number); assert.equal(decided.body.later, "LS-2026-0900");
  const after = await t.cases(), a = after.find(c => c.id === original.id), b = after.find(c => c.id === follow.id);
  assert.equal(JSON.stringify(a.data), originalData, "the original case is preserved"); assert.equal(b.followUpOf, original.id); assert.equal(a.links[0].kind, "has_follow_up"); assert.equal(b.links[0].kind, "follow_up_of"); assert.equal(b.links[0].by, MEDICAL);
  const diff = (await t.call(MEDICAL, "/api/case-diff", { caseId: follow.id, otherId: original.id })).body; assert.ok(diff.changes.some(c => c.path === "event status epilepticus / outcome" && c.to === "Recovered with sequelae" && (c.from === null || c.from !== c.to)), JSON.stringify(diff.changes));
  assert.equal((await t.call(MEDICAL, "/api/duplicate-decide", { caseId: different.id, otherId: original.id, decision: "not_duplicate", note: "Different patient, 29-year-old woman" })).status, 200);
  // version history: who edited, reviewed, approved and exported
  await t.call(MEDICAL, "/api/case-review", { caseId: original.id, note: "Medical review done" });
  const versions = (await t.call(MEDICAL, "/api/case-versions", { caseId: original.id })).body.versions; assert.deepEqual(versions.map(v => v.action), ["created", "reviewed"]); assert.equal(versions[1].by, MEDICAL); assert.match(versions[1].hash, /^[0-9a-f]{64}$/);
  const audit = (await (await t.BUCKET.get("audit2/" + new Date().toISOString().slice(0, 7) + ".ndjson")).text()).trim().split("\n").map(JSON.parse).filter(e => e.action === "case.link");
  assert.equal(audit.length, 2); assert.match(audit[0].detail.reasons, /Same patient descriptors/);
});

test("E2B(R3): an incomplete case fails with field-level errors, a completed one validates and is approved by a medical reviewer, and final output is gated, versioned and tamper-evident", async () => {
  const t = await scenario(ACICLOVIR, { article: { affiliationCountry: "India" } });
  await t.call(SCREENER, "/api/drafts-create", { id: "a1" });
  let c = (await t.cases())[0];
  const bad = await t.call(MEDICAL, "/api/e2b-validate", { caseId: c.id, profile: "EU" });
  assert.equal(bad.body.ok, false); const fields = bad.body.issues.filter(i => i.severity === "error").map(i => i.field);
  for (const f of ["C.1.4", "E.i.2.1b", "E.i.7", "H.1"]) assert.ok(fields.includes(f), f + " missing from " + fields); assert.ok(bad.body.issues.every(i => i.field && i.path && i.message && i.profile === "EU"), "field-level, with a path to the value");
  assert.equal(bad.body.xsd.available, false);
  // approval and final export are refused with the reasons
  const refused = await t.call(MEDICAL, "/api/case-approve", { caseId: c.id, profile: "EU" }); assert.equal(refused.status, 409); assert.ok(refused.body.issues.length >= 4);
  assert.equal((await t.raw(MEDICAL, "/api/case-export", { id: c.id, format: "e2b", final: true, profile: "EU" })).status, 409);
  const draft = await t.raw(MEDICAL, "/api/case-export", { id: c.id, format: "e2b", profile: "EU" }); assert.equal(draft.status, 200); const draftXml = await draft.text(); assert.match(draftXml, /<!-- DRAFT: not approved for submission/); assert.match(draftXml, /extension="EMA"/);
  // the reviewer completes the case
  await t.call(MEDICAL, "/api/case-dates", { caseId: c.id, awareness: "2026-11-02", note: "Retrieved and read on this date" });
  c = (await t.cases())[0]; assert.equal(c.data.dates.awareness.confirmedBy, MEDICAL); assert.ok(c.dueAt, "the reporting due date now runs from the awareness date");
  const data = JSON.parse(JSON.stringify(c.data)); data.reporter.country = fld("India"); data.reporter.qualification = fld("Physician");
  data.events.forEach((e, i) => { e.pt_code = fld(["10038428", "10042264", "10041962", "10028332"][i] || "10000001"); e.meddra_version = fld("29.1"); e.outcome = e.outcome.value ? e.outcome : fld("Unknown"); e.causality_reviewer = fld("Possible"); e.causality_reporter = fld("Probable/Likely"); });
  assert.equal((await t.call(MEDICAL, "/api/case-save", { id: c.id, status: "Draft", data, notes: "coded by the medical reviewer" })).status, 200);
  await t.call(MEDICAL, "/api/narrative-generate", { caseId: c.id });
  const ok = (await t.call(MEDICAL, "/api/e2b-validate", { caseId: c.id, profile: "EU" })).body; assert.equal(ok.ok, true, JSON.stringify(ok.issues.filter(i => i.severity === "error"))); assert.ok(ok.warnings >= 1, "warnings stay visible");
  assert.ok([403, 404].includes((await t.call(SCREENER, "/api/case-approve", { caseId: c.id, profile: "EU" })).status), "approval is for a medical reviewer or manager");
  const fda = await t.call(MEDICAL, "/api/case-approve", { caseId: c.id, profile: "FDA" }); assert.equal(fda.status, 409); assert.match(fda.body.error, /review only/);
  const fdaCheck = (await t.call(MEDICAL, "/api/e2b-validate", { caseId: c.id, profile: "FDA" })).body; assert.ok(fdaCheck.issues.some(i => i.field === "FDA.C.1.7.1" && i.severity === "error") && fdaCheck.issues.some(i => i.field === "FDA.C.1.12"));
  const approved = await t.call(MEDICAL, "/api/case-approve", { caseId: c.id, profile: "EU", note: "Checked against the article" }); assert.equal(approved.status, 200, JSON.stringify(approved.body)); assert.match(approved.body.approval.hash, /^[0-9a-f]{64}$/);
  const fin = await t.raw(MEDICAL, "/api/case-export", { id: c.id, format: "e2b", final: true, profile: "EU" }); assert.equal(fin.status, 200); const finalXml = await fin.text();
  assert.match(finalXml, /<!-- FINAL: approved by meera@example.org/); assert.ok(finalXml.includes("<MCCI_IN200100UV01") && finalXml.includes("literatureReference") && finalXml.includes("10042264"));
  assert.equal((await t.raw(MEDICAL, "/api/case-export", { id: c.id, format: "e2b", final: true, profile: "ICH" })).status, 409, "approved for EU only");
  const cioms = await t.raw(MEDICAL, "/api/case-export", { id: c.id, format: "cioms", final: true }); assert.equal(cioms.status, 200); assert.ok(new TextDecoder("latin1").decode(await cioms.arrayBuffer()).includes("FINAL: approved by meera@example.org"));
  const structured = JSON.parse(await (await t.raw(MEDICAL, "/api/case-export", { id: c.id, format: "structured", final: true })).text()); assert.equal(structured.case.final, true); assert.ok(structured.narrative.statements.length >= 5); assert.equal(structured.dates.awareness.value, "2026-11-02"); assert.ok(structured.versions.some(v => v.action === "approved"));
  // an edit after approval invalidates it
  const data2 = JSON.parse(JSON.stringify((await t.cases())[0].data)); data2.events[0].outcome = fld("Recovered/resolved"); await t.call(MEDICAL, "/api/case-save", { id: c.id, status: "Draft", data: data2, notes: "late edit" });
  const stale = await t.raw(MEDICAL, "/api/case-export", { id: c.id, format: "e2b", final: true, profile: "EU" }); assert.equal(stale.status, 409); assert.match((await stale.json()).error, /changed after it was approved/);
  const versions = (await t.call(MEDICAL, "/api/case-versions", { caseId: c.id })).body.versions.map(v => v.action); for (const a of ["created", "edited", "approved", "exported"]) assert.ok(versions.includes(a), a);
  const log = (await (await t.BUCKET.get("audit2/" + new Date().toISOString().slice(0, 7) + ".ndjson")).text()).trim().split("\n").map(JSON.parse).map(e => e.action); for (const a of ["case.draft_created", "case.approved", "case.export", "case.dates"]) assert.ok(log.includes(a), a);
  assert.equal((await worker.verifyAuditChain(t.env)).ok, true);
});

test("E2B(R3) XML is checked against the ICH schema when the validator is available: valid output passes, damaged XML is reported with its element", async (tc) => {
  if (!haveXsd) return tc.skip("ICH schema files or xmllint not available");
  process.env.ICH_SCHEMA_DIR = ICH_DIR; const validate = await makeXsdValidator(); assert.ok(validate);
  const t = await scenario(ACICLOVIR, { article: { affiliationCountry: "India" } }, { }); t.env.XSD_VALIDATE = validate;
  await t.call(SCREENER, "/api/drafts-create", { id: "a1" }); const c = (await t.cases())[0];
  const good = (await t.call(MEDICAL, "/api/e2b-validate", { caseId: c.id, profile: "ICH" })).body; assert.equal(good.xsd.available, true); assert.deepEqual(good.xsd.errors, [], JSON.stringify(good.xsd.errors));
  const xml = worker.e2bBatch([c], {}, { profile: "ICH" }), broken = xml.replace("<creationTime", "<creationTimeX").replace("</creationTimeX>", "");
  const errors = await validate(xml.replace(/<statusCode code="active"\/>/, "<statusCode code=\"active\"/><bogusElement/>")); assert.ok(errors.length >= 1); assert.ok(errors[0].line > 0 && errors[0].message.length > 5);
  void broken;
});

test("listedness is assessed against versioned reference safety information with the exact label passage and a reviewer decision", async () => {
  const t = await scenario(ACICLOVIR); await t.call(SCREENER, "/api/drafts-create", { id: "a1" }); const c = (await t.cases())[0];
  const RSI = "4.8 Undesirable effects\nNervous system disorders: headache, dizziness, confusion, hallucinations, somnolence, seizures, convulsions.\nRenal and urinary disorders: renal toxicity; increases in blood urea and creatinine; acute renal failure.\nHaemodialysis may be considered in severe overdose.\n" + "Further text. ".repeat(10);
  assert.equal((await t.call(MEDICAL, "/api/rsi-save", { product: "aciclovir", market: "India", version: "2025-03", text: RSI })).status, 403, "only managers load reference safety information");
  assert.equal((await t.call(MANAGER, "/api/rsi-save", { product: "aciclovir", version: "x", text: "too short" })).status, 400);
  const saved = await t.call(MANAGER, "/api/rsi-save", { product: "aciclovir", market: "India", version: "2025-03", effectiveDate: "2025-03-01", source: "Approved SmPC, section 4.8", text: RSI }); assert.equal(saved.status, 200);
  const index = c.data.events.findIndex(e => e.verbatim.value === "status epilepticus"), seizureIndex = c.data.events.findIndex(e => e.verbatim.value === "renal toxicity");
  const sug = (await t.call(MEDICAL, "/api/listedness-suggest", { caseId: c.id, eventIndex: seizureIndex, rsiId: saved.body.id })).body;
  assert.ok(sug.passages.some(p => /acute renal failure/.test(p.passage) && p.heading === "4.8 Undesirable effects"), JSON.stringify(sug.passages)); assert.equal(sug.rsi.version, "2025-03");
  const none = (await t.call(MEDICAL, "/api/listedness-suggest", { caseId: c.id, eventIndex: index, rsiId: saved.body.id })).body; assert.ok(none.passages.some(p => /seizures/.test(p.passage)), "a related manifestation term is found, and the reviewer still decides");
  const passage = sug.passages.find(p => /acute renal failure/.test(p.passage)).passage;
  assert.equal((await t.call(MEDICAL, "/api/listedness-decide", { caseId: c.id, eventIndex: seizureIndex, rsiId: saved.body.id, decision: "listed", passage: "invented text", note: "Matches label" })).status, 400, "a passage must really be in the document");
  assert.equal((await t.call(MEDICAL, "/api/listedness-decide", { caseId: c.id, eventIndex: seizureIndex, rsiId: saved.body.id, decision: "listed", note: "no passage" })).status, 400);
  assert.equal((await t.call(MEDICAL, "/api/listedness-decide", { caseId: c.id, eventIndex: seizureIndex, rsiId: saved.body.id, decision: "listed", passage, note: "Renal failure is in section 4.8" })).status, 200);
  assert.equal((await t.call(MEDICAL, "/api/listedness-decide", { caseId: c.id, eventIndex: index, rsiId: saved.body.id, decision: "unlisted", note: "Status epilepticus is not in section 4.8" })).status, 200);
  const after = (await t.cases())[0].data.events; assert.equal(after[seizureIndex].listedness_assessment.decision, "listed"); assert.equal(after[seizureIndex].listedness_assessment.version, "2025-03"); assert.equal(after[seizureIndex].listedness_assessment.market, "India"); assert.equal(after[seizureIndex].expectedness.value, "Listed"); assert.equal(after[index].expectedness.value, "Unlisted"); assert.match(after[seizureIndex].rsi.value, /RSI v2025-03/);
});

test("restricted full text stays in the workbench and out of case packages and batch ZIPs", async () => {
  const t = await scenario(TWO_PATIENTS.split("Patient 2")[0], { article: { fullTextKey: "evidence/1/unpaywall.pdf", fullTextStatus: "Captured", fullTextRestricted: true, fullTextOrigin: "Unpaywall" } });
  await t.BUCKET.put("evidence/1/unpaywall.pdf", "%PDF-1.4 licensed copy"); await t.call(SCREENER, "/api/drafts-create", { id: "a1", force: {} }); let cases = await t.cases();
  if (!cases.length) { await t.call(SCREENER, "/api/drafts-create", { id: "a1", force: { P1: "Reporter confirmed by e-mail" } }); cases = await t.cases(); }
  const zip = await t.raw(MEDICAL, "/api/case-export", { id: cases[0].id, format: "package" }); const files = readZip(await zip.arrayBuffer());
  assert.ok(files.has("E2B-R3-DRAFT.xml") && files.has("CIOMS-I-DRAFT.pdf") && files.has("narrative.txt")); assert.ok(![...files.keys()].some(n => /source_PMID_1\.pdf/.test(n)), "the restricted PDF is not packaged");
  assert.equal((await t.get(SCREENER, "/api/full-text/1")).status, 200, "an authorised reviewer can still read it in the workbench");
});
