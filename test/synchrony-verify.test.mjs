// Verification scenario: identical demographics, a rash absent on day 1 and present on day 4, a manifestation of a documented diagnosis,
// and two suspects with different causality, taken through the normal entry points to a signed package whose formats must agree.
import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, SCREENER, MEDICAL, QC, makeEnv, readZip } from "./helpers.mjs";

const authors = [{ name: "Anil Rao", affiliations: ["Test Hospital, India"], email: "reviewer@example.org", corresponding: true }];
const article = { id: "1", title: "Aciclovir case report", abstract: "Individual reports.", authors: ["Anil Rao"], pubTypes: ["Case Reports"], fullTextKey: "evidence/1/report.xml", evidence: { fulltext: { sha256: "a" }, parsed: { key: "evidence/1/parsed.json" } } };
const assignment = { id: "watch-1", pmid: "1", portfolio: "Antivirals", reviewer: SCREENER, molecules: ["aciclovir"], status: "Complete", disposition: { value: "potential_icsr" } };
const field = (value, state = "edited") => ({ value, state, evidence: [] });
const TEXT = "Patient 1 was a 54-year-old man who received aciclovir 800 mg orally on day 1 for herpes zoster. He had no rash on day 1. He developed a rash on day 4. Aciclovir was stopped on day 6 and the rash resolved. Patient 2 was a 54-year-old man who received aciclovir for herpes zoster. He was diagnosed with Stevens-Johnson syndrome on day 5, with skin blistering and mucosal erosions.";

async function scenario() {
  const t = await makeEnv({
    profiles: [{ email: MANAGER, name: "Boss", role: "manager", active: true }, { email: SCREENER, name: "Asha", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }, { email: MEDICAL, name: "Meera", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }, { email: QC, name: "Quinn", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }],
    memberships: [{ email: MEDICAL, portfolio: "Antivirals", role: "medical_reviewer" }, { email: QC, portfolio: "Antivirals", role: "qc" }],
    watches: [{ portfolio: "Antivirals", molecule: "aciclovir", query: "q" }], articles: { 1: article }, settings: { syncMode: "active", esignApprovers: "any", automation: { smpc: false } }, assignments: [assignment] });
  await t.BUCKET.put("evidence/1/parsed.json", JSON.stringify({ sections: [{ path: "Case presentation", title: "Case presentation", paragraphs: [TEXT] }], authors, correspondenceEmails: ["reviewer@example.org"], correspondence: ["Anil Rao"], tables: [], figures: [] }));
  return t;
}

test("patient drafts: separate per patient, four criteria with exact passages, onset after negation, manifestations not promoted to reactions", async () => {
  const t = await scenario(); await t.call(MANAGER, "/api/synchrony", { action: "run" });
  const st0 = await t.state(); console.log("ISSUES", JSON.stringify(st0.assignments[0].synchrony.issues.map(i => i.text)), JSON.stringify(st0.assignments[0].synchrony.patients));
  const cases = st0.cases; assert.equal(cases.length, 2, "two patients with identical demographics stay separate");
  const p1 = cases.find(c => /rash/i.test(c.data.events.map(e => e.verbatim.value).join())), p2 = cases.find(c => c !== p1);
  for (const c of [p1, p2]) { const crit = c.data.minimum_criteria.criteria; for (const k of ["patient", "reporter", "product", "event"]) { assert.ok(["supported", "uncertain", "missing"].includes(crit[k].status), k); assert.ok(crit[k].status === "supported" ? (crit[k].evidence.length > 0 || k === "reporter") : true, k + " has its evidence"); } }
  assert.equal(p1.data.events.length, 1, "one reaction for the rash"); assert.equal(p1.data.events[0].onset_day, 4, "onset is day 4, not day 1");
  const evidence = (p1.data.events[0].verbatim.evidence || []).map(e => e.excerpt || e.sentence || "").join(" | "); assert.match(evidence, /developed a rash on day 4/);
  console.log("EVIDENCE-P1", evidence.slice(0, 300)); console.log("P2-EVENTS", JSON.stringify(p2.data.events.map(e => [e.verbatim.value, (e.manifestations || []).map(m => m.verbatim)])));
  assert.ok(!p2.data.events.some(e => /blister|erosion/i.test(e.verbatim.value)), "manifestations of a documented diagnosis are not separate reactions");
  assert.ok(p2.data.events.some(e => /stevens/i.test(e.verbatim.value)), "the diagnosis is the reaction");
});

test("two suspects with different causality: narrative, CIOMS I, E2B(R3) and line listing agree, after field-specific QC and signature", async () => {
  const t = await scenario(); await t.call(MANAGER, "/api/synchrony", { action: "run" });
  const s0 = await t.state(), c = s0.cases.find(x => /rash/i.test(x.data.events.map(e => e.verbatim.value).join())), d = c.data;
  d.reporter.country = field("India"); d.reporter.qualification = field("Physician"); d.products[0].indication = field("herpes zoster"); d.products[0].start_date = field("2026-10-01");
  d.products[0].dechallenge = field("Positive: the rash resolved after the drug was stopped"); d.events[0].onset_date = field("2026-10-04"); d.events[0].outcome = field("Recovered/resolved"); d.events[0].listedness = field("Unknown"); d.events[0].expectedness = field("Unknown");
  const second = JSON.parse(JSON.stringify(d.products[0])); second.name = field("ibuprofen"); second.dose = field("400 mg"); second.pair_id = null; second.dechallenge = field("Negative: the rash persisted"); second.indication = field("pain");
  d.products.push(second); await t.BUCKET.put("bench.json", JSON.stringify(s0));
  // the screener saves through the normal route, so pair ids are assigned by the application
  const fresh = JSON.parse(JSON.stringify((await t.state()).cases.find(x => x.id === c.id).data));
  assert.equal((await t.call(SCREENER, "/api/case-save", { id: c.id, status: "Draft", data: fresh })).status, 200);
  const saved = (await t.state()).cases.find(x => x.id === c.id), ids = saved.data.products.map(p => p.pair_id); assert.ok(ids[0] && ids[1] && ids[0] !== ids[1], "each suspect has its own pair id");
  saved.data.events[0].product_causality = { [ids[0]]: { causality_reporter: field("Probable/Likely"), causality_reviewer: field("Probable/Likely"), causality_method: field("WHO-UMC"), causality_rationale: field("Positive dechallenge for aciclovir") },
    [ids[1]]: { causality_reporter: field("Unlikely"), causality_reviewer: field("Unlikely"), causality_method: field("WHO-UMC"), causality_rationale: field("The rash persisted when ibuprofen continued") } };
  assert.equal((await t.call(SCREENER, "/api/case-save", { id: c.id, status: "Draft", data: saved.data })).status, 200);
  const sub = await t.call(SCREENER, "/api/case-submit", { id: c.id }); assert.equal(sub.status, 200, JSON.stringify(sub.body));
  assert.equal((await t.call(QC, "/api/case-qc", { id: c.id, decision: "approve" })).body.to, MEDICAL);
  await t.call(MEDICAL, "/api/case-dates", { caseId: c.id, awareness: "2026-11-02", note: "Article reviewed on this date" }); await t.call(MEDICAL, "/api/narrative-generate", { caseId: c.id });
  assert.equal((await t.call(MEDICAL, "/api/case-approve", { caseId: c.id, profile: "ICH", note: "Compared with the evidence." })).status, 200);
  const pre = (await t.call(MEDICAL, "/api/sign-preview", { kind: "case", id: c.id, meaning: "case_approve" })).body;
  assert.equal((await t.call(MEDICAL, "/api/sign", { kind: "case", id: c.id, meaning: "case_approve", expected_content_sha256: pre.content_sha256, reviewed_evidence_sha256: pre.evidence_sha256 }, { "x-esign-reauth": "1" })).status, 200);
  assert.equal((await t.call(MANAGER, "/api/synchrony", { action: "run" })).body.packages, 1);
  const files = readZip(await (await t.raw(MEDICAL, "/api/synchrony", { action: "package", id: c.id })).arrayBuffer()), text = n => files.get(n).toString("latin1");
  const narrative = text("narrative.txt"), e2b = text("E2B-R3.xml"), cioms = text("CIOMS-I.pdf"), csv = text("line-listing.csv");
  // patient, reaction and outcome appear in every format
  for (const [name, body] of [["narrative", narrative], ["E2B", e2b], ["CIOMS", cioms], ["line listing", csv]]) { assert.match(body, /rash/i, name + " names the reaction"); assert.match(body, /aciclovir/i, name + " names the first suspect"); assert.match(body, /ibuprofen/i, name + " names the second suspect"); }
  assert.match(narrative, /54-year-old/); assert.match(e2b, /value="54"/); assert.match(cioms, /54/); assert.match(csv, /54 years/);
  for (const [name, body] of [["narrative", narrative], ["E2B", e2b], ["CIOMS", cioms], ["line listing", csv]]) assert.match(body, /Recovered/i, name + " carries the outcome");
  // each drug keeps its own causality, and no format gives one drug the other's
  assert.match(narrative, /Company causality assessment: aciclovir \/ rash: Probable\/Likely[^;]*; ibuprofen \/ rash: Unlikely/i); assert.match(narrative, /Dechallenge for ibuprofen: Negative/); assert.match(narrative, /Dechallenge: Positive/);
  const rows = csv.trim().split(/\r?\n/).map(l => l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map(x => x.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'))), head = rows[0], who = head.indexOf("Suspect product"), cz = head.indexOf("Causality (WHO-UMC)");
  const pair = n => rows.slice(1).find(r => r[who] === n); assert.equal(pair("aciclovir")[cz], "Probable/Likely"); assert.equal(pair("ibuprofen")[cz], "Unlikely");
  assert.equal((e2b.match(/Reviewer: Probable\/Likely/g) || []).length, 1); assert.equal((e2b.match(/Reviewer: Unlikely/g) || []).length, 1);
  assert.match(cioms, /Probable\/Likely/); assert.match(cioms, /Unlikely/);
  // Phase 2: one matrix row per suspect and reaction, blank when unassessed
  const mx = (await t.call(MEDICAL, "/api/synchrony", { action: "matrix", id: c.id })).body, mrow = n => mx.rows.find(r => r.product === n);
  assert.equal(mx.rows.length, 2); assert.equal(mrow("aciclovir").causality, "Probable/Likely"); assert.equal(mrow("ibuprofen").causality, "Unlikely"); assert.equal(mx.deadline.awarenessConfirmed, true);
  // Phase 3: the four formats agree, and the package manifest records the case version, hashes and signer
  const view = (await t.call(MEDICAL, "/api/synchrony", { action: "view", id: c.id })).body; assert.deepEqual(view.agreement, [], JSON.stringify(view.agreement));
  const manifest = JSON.parse(text("manifest.json")); assert.equal(manifest.agreement.discrepancies, 0); assert.ok(manifest.evidenceSha256 && manifest.contentSha256 && manifest.signer, "bound to hashes and signer");
  const again = await t.call(MANAGER, "/api/synchrony", { action: "run" }); assert.equal(again.body.packages, 0, "regenerating the same version creates no new package");
  // delivery: handoff, rejection, corrected delivery against the same package; a second correction of the same rejection is refused
  const ho = await t.call(MEDICAL, "/api/synchrony", { action: "handoff", id: c.id, recipient: "Partner safety desk", note: "Sent by secure transfer, ref 1" }); assert.equal(ho.status, 200, JSON.stringify(ho.body));
  const hid = (await t.state()).cases.find(x => x.id === c.id).handoffs[0].id;
  assert.equal((await t.call(MEDICAL, "/api/synchrony", { action: "reject", id: c.id, taskId: hid, note: "Gateway rejected the file: bad receiver id" })).status, 200);
  assert.equal((await t.call(MEDICAL, "/api/synchrony", { action: "acknowledge", id: c.id, taskId: hid, note: "Acknowledged after rejection" })).status, 409, "a rejected delivery cannot be acknowledged");
  const fix = await t.call(MEDICAL, "/api/synchrony", { action: "handoff", id: c.id, recipient: "Partner safety desk", note: "Corrected delivery, ref 2", correctsId: hid }); assert.equal(fix.status, 200, JSON.stringify(fix.body));
  const hs = (await t.state()).cases.find(x => x.id === c.id).handoffs; assert.equal(hs.length, 2); assert.equal(hs[1].correctsId, hid); assert.equal(hs[0].correctedBy, hs[1].id); assert.equal(hs[1].approvalHash, hs[0].approvalHash, "the corrected delivery is bound to the same package");
  assert.equal((await t.call(MEDICAL, "/api/synchrony", { action: "handoff", id: c.id, recipient: "Partner safety desk", note: "Corrected again, ref 3", correctsId: hid })).status, 409);
  // Phase 4: manager dashboard
  const jobs = (await t.call(MANAGER, "/api/synchrony", { action: "jobs" })).body; assert.ok(jobs.counts.completed >= 1); assert.equal(jobs.preparedCases, 2); assert.equal((await t.call(SCREENER, "/api/synchrony", { action: "jobs" })).status, 403);
});

test("each draft carries an ordered chronology from the patient's own passages, labelled with its source", async () => {
  const t = await scenario(); await t.call(MANAGER, "/api/synchrony", { action: "run" });
  const cs = (await t.state()).cases, p1 = cs.find(c => /rash/i.test(c.data.events.map(e => e.verbatim.value).join())), p2 = cs.find(c => c !== p1);
  const view = (await t.call(MEDICAL, "/api/synchrony", { action: "view", id: p1.id })).body, kinds = view.chronology.map(i => i.kind);
  assert.ok(kinds.includes("exposure") && kinds.includes("onset") && kinds.includes("action"), JSON.stringify(kinds));
  const onsets = view.chronology.filter(i => i.kind === "onset"); assert.ok(onsets.some(i => i.negated && /day 1/i.test(i.text)), "the early denial stays visible"); assert.ok(onsets.some(i => !i.negated && /day 4/i.test(i.text)), "the later onset stays visible");
  assert.ok(view.chronology.every(i => i.source), "every item says where it came from");
  assert.ok(!view.chronology.some(i => /Stevens|blister/i.test(i.text)), "the other patient's passages are not in this chronology");
});
