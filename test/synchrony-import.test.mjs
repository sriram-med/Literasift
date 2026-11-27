import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, SCREENER, MEDICAL, QC, makeEnv, withFetch } from "./helpers.mjs";

const PROFILES = [{ email: MANAGER, name: "Boss", role: "manager", active: true }, { email: SCREENER, name: "Asha", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }, { email: QC, name: "Quinn", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }, { email: MEDICAL, name: "Meera", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }];
const OCR = "Aciclovir rash after treatment of herpes zoster\nAnil Rao1, Meera Das2\n1 Department of Medicine, Test Hospital, India\nCorrespondence: Anil Rao, anil.rao@example.org\n\nCase presentation. A 54-year-old man received aciclovir 800 mg orally on day 1 for herpes zoster. He had no rash on day 1. He developed a rash on day 4. Aciclovir was stopped on day 6 and the rash resolved. The authors, Anil Rao and Meera Das, report this as a possible adverse drug reaction to aciclovir.";
const env = () => makeEnv({ profiles: PROFILES, memberships: [{ email: MEDICAL, portfolio: "Antivirals", role: "medical_reviewer" }, { email: QC, portfolio: "Antivirals", role: "qc" }], watches: [{ portfolio: "Antivirals", molecule: "aciclovir", query: "q" }], settings: { syncMode: "active", automation: { smpc: false } } });

test("pasted OCR text becomes an article, a potential-ICSR assignment, stored full text and a prepared draft; replay adds nothing", async () => {
  const t = await env(), body = { title: "Aciclovir rash, scanned report", portfolio: "Antivirals", molecule: "aciclovir", text: OCR };
  const a = await t.call(SCREENER, "/api/synchrony-import", body); assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.match(a.body.pmid, /^DOC-/); assert.equal(a.body.textRead, true); assert.equal(a.body.drafts.length, 1, JSON.stringify(a.body));
  const s1 = await t.state(); assert.equal(s1.assignments.filter(x => x.pmid === a.body.pmid).length, 1); assert.equal(s1.assignments[0].disposition.value, "potential_icsr"); const ar = s1.articles[a.body.pmid]; assert.deepEqual(ar.authors, ["Anil Rao", "Meera Das"], "two authors read from the pasted header"); assert.equal(ar.authorDetails[0].corresponding, true); assert.equal(ar.authorDetails[0].email, "anil.rao@example.org"); assert.equal(s1.articles[a.body.pmid].fullTextStatus, "Captured");
  console.log("IMPORT", JSON.stringify({ drafts: a.body.drafts.length, mode: a.body.mode, issues: (s1.assignments[0].synchrony?.issues || []).map(i => i.code) }));
  const again = await t.call(SCREENER, "/api/synchrony-import", body); assert.equal(again.status, 200);
  const s2 = await t.state(); assert.equal(s2.assignments.length, 1, "no duplicate assignment"); assert.equal(s2.cases.length, s1.cases.length, "no duplicate draft"); assert.equal(Object.keys(s2.articles).length, 1);
});

test("a Discover record is sent to Synchrony with its abstract; a portfolio is required", async () => {
  const t = await env();
  assert.equal((await t.call(SCREENER, "/api/synchrony-import", { title: "x", text: OCR })).status, 400);
  const r = await t.call(SCREENER, "/api/synchrony-import", { portfolio: "Antivirals", molecule: "aciclovir", record: { title: "Aciclovir neurotoxicity in renal failure", doi: "10.1000/abc", authors: ["A Rao"], journal: "J Test", year: "2026", abstract: "A 70-year-old woman with renal failure received aciclovir and developed confusion on day 3." } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); const s = await t.state(), art = s.articles[r.body.pmid];
  assert.equal(art.doi, "10.1000/abc"); assert.match(art.abstract, /renal failure/); assert.equal(s.assignments[0].disposition.value, "potential_icsr");
});

test("AI review flags a value the patient's own sentence contradicts, and drops anything it cannot quote", async () => {
  const t = await makeEnv({ profiles: PROFILES, watches: [{ portfolio: "Antivirals", molecule: "aciclovir", query: "q" }], settings: { syncMode: "active", automation: { smpc: false }, ai: { enabled: true, monthlyTokens: 20000, perCaseTokens: 20000 } } }, { OPENAI_API_KEY: "synthetic-test-key-1234567890" });
  await t.call(SCREENER, "/api/synchrony-import", { title: "Aciclovir rash, scanned report", portfolio: "Antivirals", molecule: "aciclovir", text: OCR, aiAllowed: true });
  const c = (await t.state()).cases[0], d = JSON.parse(JSON.stringify(c.data)), f = v => ({ value: v, state: "edited", evidence: [] });
  d.events[0].onset_date = f("day 9"); d.products[0].dose = f("800 mg"); await t.call(SCREENER, "/api/case-save", { id: c.id, status: "Draft", data: d });
  let sent = "";
  const model = async (url, init) => { sent = JSON.parse(init.body).messages[1].content; const L = sent.split("\n"), n = L.findIndex(l => /developed a rash on day 4/.test(l)), ids = Object.fromEntries(L.filter(l => /^f\d+ /.test(l)).map(l => [l.split(" ").slice(1, -2).join(" "), l.split(" ")[0]]));
    const onset = Object.entries(ids).find(([k]) => /^onset/.test(k))[1], dose = Object.entries(ids).find(([k]) => /^dose/.test(k))[1];
    return Response.json({ choices: [{ message: { content: JSON.stringify({ x: [{ f: onset, p: "The article says day 4", s: n, v: "day 4" }, { f: dose, p: "Dose differs", s: n, v: "1200 mg" }] }) } }], usage: { total_tokens: 150 } }); };
  const r = await withFetch(model, () => t.call(SCREENER, "/api/case-ai-review", { id: c.id })); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.issues.length, 1, "the quote it cannot support is dropped"); assert.match(r.body.issues[0].path, /onset_date/); assert.equal(r.body.issues[0].suggestion, "day 4"); assert.match(r.body.issues[0].sentence, /day 4/);
  const again = await withFetch(model, () => t.call(SCREENER, "/api/case-ai-review", { id: c.id })); assert.equal(again.body.cached, true, "same case, same text: no tokens");
});

const CASE1 = "Aciclovir neurotoxicity in a patient with advanced kidney disease\nRahul Mehta1, Sunita Rao1\n1 Department of Nephrology, AIIMS, New Delhi, India\nCorrespondence: Rahul Mehta, rahul.mehta@example.org\n\nCase report. A 54-year-old Indian man with chronic kidney disease (eGFR 28) and hypertension, weight 72 kg, was admitted to the Department of Nephrology, AIIMS, New Delhi, India, with herpes zoster. He received intravenous aciclovir 10 mg/kg three times daily for 5 days. He was also taking amlodipine 5 mg daily and metformin 500 mg twice daily. On day 3 of treatment he became confused and developed hallucinations and myoclonic jerks. Serum creatinine rose from 2.1 to 3.4 mg/dL on day 3. Aciclovir was discontinued on day 5 and haemodialysis was performed. The neurological symptoms resolved completely within 48 hours of stopping aciclovir. The authors consider the neurotoxicity probably related to aciclovir. He had no previous seizures.";

test("pre-population: weight, route, indication, per-drug frequency, onset, outcome, dechallenge, intervention, reporter country and the authors' causality come from the patient's own sentences", async () => {
  const t = await env(), r = await t.call(SCREENER, "/api/synchrony-import", { title: "Aciclovir neurotoxicity", portfolio: "Antivirals", molecule: "aciclovir", text: CASE1, aiAllowed: true }); assert.equal(r.status, 200, JSON.stringify(r.body));
  const c = (await t.state()).cases[0], d = c.data, val = f => f?.value, drug = n => d.products.find(p => (val(p.name) || "").toLowerCase() === n);
  assert.equal(val(d.patient.weight), "72"); assert.equal(val(drug("aciclovir").route), "Intravenous"); assert.equal(val(drug("aciclovir").indication), "herpes zoster", "the indication is not a reaction");
  assert.ok(!d.events.some(e => /zoster/i.test(val(e.verbatim))), "herpes zoster is not listed as an adverse event"); assert.equal(val(drug("amlodipine").frequency), "daily"); assert.equal(val(drug("metformin").frequency), "twice daily");
  assert.ok(!d.patient.medical_history.some(h => /seizure/i.test(val(h))), "a denied history item is not history"); assert.ok(d.patient.medical_history.some(h => /kidney/i.test(val(h))));
  const e = d.events.find(x => /neurotox/i.test(val(x.verbatim))); assert.equal(e.onset_day, 3); assert.match(val(e.time_to_onset), /day 3/); assert.equal(val(e.outcome), "Recovered/resolved"); assert.match(val(drug("aciclovir").dechallenge), /^Positive/); assert.equal(drug("aciclovir").stop_day, 5);
  assert.equal(val(e.causality_reporter), "Probable/Likely"); assert.match(val(e.seriousness_basis), /dialysis/); assert.equal(e.seriousness.other_medically_important, true);
  assert.equal(val(d.reporter.country), "India"); assert.match(val(d.reporter.department), /Nephrology/);
  assert.ok(e.outcome.evidence.length && e.outcome.state === "proposed", "each value carries its sentence and stays a proposal");
});

test("pre-population on a second report: a reaction outside the old lexicon, one history item, hospitalisation stated apart, 'rechallenge not attempted', and a worked causality rationale", async () => {
  const t = await env(), text = "Sulfonylurea hypoglycaemia in the elderly\nMaria Lopez, John Smith, Wei Zhang\nDepartment of Geriatrics, Hospital Clinic, Barcelona, Spain\nE-mail: m.lopez@example.es\n\nWe report a 67-year-old woman with type 2 diabetes mellitus and hypertension who developed severe hypoglycaemia 3 days after starting glibenclamide 5 mg orally once daily for diabetes. Her blood glucose was 1.9 mmol/L. She was hospitalised and treated with intravenous glucose. Glibenclamide was withdrawn and glucose normalised within 24 hours. She recovered fully. Rechallenge was not attempted. Concomitant medications included ramipril 5 mg daily. We consider the hypoglycaemia possibly related to glibenclamide.";
  const r = await t.call(SCREENER, "/api/synchrony-import", { title: "Glibenclamide hypoglycaemia", portfolio: "Antivirals", molecule: "glibenclamide", text }); assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = await t.state(), c = s.cases[0], d = c.data, val = f => f?.value, g = d.products.find(p => /glibenclamide/i.test(val(p.name))), e = d.events[0];
  assert.equal(d.events.length, 1); assert.match(val(e.verbatim), /hypoglyc/i, "the reaction is found, and the comorbidities are not reactions"); assert.equal(val(e.pt), "Hypoglycaemia");
  assert.deepEqual(d.patient.medical_history.map(val).sort(), ["diabetes mellitus", "hypertension"], "no duplicate history item");
  assert.match(val(e.seriousness_basis), /hospitalis/i); assert.equal(e.seriousness.hospitalization, true);
  assert.equal(val(g.rechallenge), "Not done"); assert.match(val(g.dechallenge), /^Positive/); assert.equal(val(e.outcome), "Recovered/resolved"); assert.match(val(e.time_to_onset), /3 days after starting/);
  assert.match(val(e.temporal_relationship), /Onset 3 days/); assert.match(val(e.concomitant_factors), /ramipril/); assert.match(val(e.objective_evidence), /glucose 1\.9/i); assert.match(val(e.causality_rationale), /Dechallenge: Positive/); assert.equal(val(e.causality_reporter), "Possible");
  assert.equal(val(d.patient.country), "Spain"); assert.equal(s.articles[r.body.pmid].authors.length, 3); assert.equal(d.other_reporters.length, 2, "the other two authors are recorded");
});

test("a reaction the lexicon does not list is found after an event verb and kept as a proposal with its sentence", async () => {
  const t = await env(), text = "Metoclopramide and acute dystonia\nA. Patel, R. Singh\nDepartment of Paediatrics, City Hospital, Mumbai, India\nCorrespondence: a.patel@example.org\n\nA 9-year-old boy received metoclopramide 5 mg intravenously for vomiting. Two hours later he developed an oculogyric crisis with upward deviation of the eyes. Metoclopramide was stopped and the crisis resolved after procyclidine.";
  const r = await t.call(SCREENER, "/api/synchrony-import", { title: "Metoclopramide dystonia", portfolio: "Antivirals", molecule: "metoclopramide", text }); assert.equal(r.status, 200, JSON.stringify(r.body));
  const c = (await t.state()).cases[0], ev = c.data.events.map(e => e.verbatim.value.toLowerCase()); assert.ok(ev.some(x => /oculogyric crisis|dystonia/.test(x)), JSON.stringify(ev)); assert.ok(!ev.some(x => /vomiting/.test(x)), "the indication symptom is not the reaction");
  const e = c.data.events.find(x => /oculogyric|dystonia/i.test(x.verbatim.value)); assert.ok(e.verbatim.evidence.length && e.verbatim.evidence[0].excerpt.toLowerCase().includes(e.verbatim.value.toLowerCase().split(" ").pop().slice(0, 6)), "a sentence naming it is attached: " + JSON.stringify([e.verbatim.value, e.verbatim.evidence[0]?.excerpt])); assert.equal(e.verbatim.state, "proposed");
});

test("open questions become tasks by themselves, a letter to the author is drafted from them, and a late case escalates once and moves off an inactive holder", async () => {
  const t = await env(), r = await t.call(SCREENER, "/api/synchrony-import", { title: "Aciclovir rash, scanned report", portfolio: "Antivirals", molecule: "aciclovir", text: OCR }); assert.equal(r.status, 200);
  await t.call(MANAGER, "/api/synchrony", { action: "run" });
  const c = (await t.state()).cases[0]; assert.ok((c.followups || []).some(f => f.kind === "auto" && f.status === "open"), "questions were added as tasks: " + JSON.stringify(c.followups));
  const n = c.followups.length; await t.call(MANAGER, "/api/synchrony", { action: "run" }); assert.equal((await t.state()).cases[0].followups.length, n, "no duplicate tasks on repeat");
  const l = await t.call(SCREENER, "/api/synchrony", { action: "followup_letter", id: c.id }); assert.equal(l.status, 200, JSON.stringify(l.body)); assert.equal(l.body.to, "anil.rao@example.org"); assert.match(l.body.body, /Dear Anil Rao/); assert.match(l.body.body, /1\. /); assert.ok(!/\bnull\b|undefined/.test(l.body.body));
  // escalation
  const st = await t.state(), x = st.cases[0]; x.dueAt = "2000-01-01"; st.profiles.find(p => p.email === x.assignee).active = false; await t.BUCKET.put("bench.json", JSON.stringify(st));
  const tick = await t.call(MANAGER, "/api/scheduled", {}); const after = (await t.state()).cases[0];
  assert.equal(after.escalation.level, 2); assert.ok(after.history.some(h => /Escalated: Overdue/.test(h.action))); assert.notEqual(after.assignee, x.assignee, "moved off the inactive holder");
  const hist = after.history.length; await t.call(MANAGER, "/api/scheduled", {}); assert.equal((await t.state()).cases[0].history.length, hist, "escalation happens once per level");
});
