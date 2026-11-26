// Regressions found while verifying Synchrony end to end. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, SCREENER, MEDICAL, QC, makeEnv, withFetch } from "./helpers.mjs";

const authors = [{ name: "Anil Rao", affiliations: ["Test Hospital, India"], email: "reviewer@example.org", corresponding: true }];
const article = { id: "1", title: "Aciclovir case report", abstract: "Individual reports.", authors: ["Anil Rao"], pubTypes: ["Case Reports"], fullTextKey: "evidence/1/report.xml", evidence: { fulltext: { sha256: "a" }, parsed: { key: "evidence/1/parsed.json" } } };
const assignment = { id: "watch-1", pmid: "1", portfolio: "Antivirals", reviewer: SCREENER, molecules: ["aciclovir"], status: "Complete", disposition: { value: "potential_icsr" } };
const field = value => ({ value, state: "edited", evidence: [] });
const TWO = "Patient 1 was a 54-year-old man who received aciclovir 800 mg orally on day 1 for herpes zoster. He developed a rash on day 4. Patient 2 was a 54-year-old man who received aciclovir for herpes zoster. He weighed 73 kg. Serum creatinine rose from 1.0 to 2.4 mg/dL on day 6. He developed acute kidney injury on day 5.";

async function scenario(settings = {}, env = {}, text = TWO, extra = {}) {
  const t = await makeEnv({
    profiles: [{ email: MANAGER, name: "Boss", role: "manager", active: true }, { email: SCREENER, name: "Asha", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }, { email: MEDICAL, name: "Meera", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }, { email: QC, name: "Quinn", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }],
    memberships: [{ email: MEDICAL, portfolio: "Antivirals", role: "medical_reviewer" }, { email: QC, portfolio: "Antivirals", role: "qc" }],
    watches: [{ portfolio: "Antivirals", molecule: "aciclovir", query: "q" }], articles: { 1: article }, settings: { syncMode: "active", esignApprovers: "any", automation: { smpc: false }, ...settings }, assignments: [assignment], ...extra }, env);
  await t.BUCKET.put("evidence/1/parsed.json", JSON.stringify({ sections: [{ path: "Case presentation", title: "Case presentation", paragraphs: [text] }], authors, correspondenceEmails: ["reviewer@example.org"], correspondence: ["Anil Rao"], tables: [], figures: [] }));
  return t;
}
const byRash = cases => ({ p1: cases.find(c => c.data.events.some(e => /rash/i.test(e.verbatim.value))), p2: cases.find(c => c.data.events.some(e => /kidney/i.test(e.verbatim.value))) });

test("automation never takes investigations from another patient's sentences", async () => {
  const t = await scenario(); await t.call(MANAGER, "/api/synchrony", { action: "run" });
  const { p1, p2 } = byRash((await t.state()).cases); assert.ok(p1 && p2);
  assert.ok(p2.data.labs.some(l => /creatinine/i.test(l.test)), "patient 2 has its own test");
  assert.equal(p1.data.labs.length, 0, "patient 1 has none, and does not borrow patient 2's");
  const again = await t.call(MANAGER, "/api/case-automate", { id: p1.id }); assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal((await t.state()).cases.find(c => c.id === p1.id).data.labs.length, 0, "running automation again still does not borrow");
  assert.match(again.body.steps.find(s => s.key === "investigations").detail, /No tests/);
});

test("AI data entry only offers the sentences of the case's own patient, so another patient's quote cannot fill the field", async () => {
  const t = await scenario({ ai: { enabled: true, monthlyTokens: 20000, perCaseTokens: 20000 } }, { OPENAI_API_KEY: "synthetic-test-key-1234567890" }); await t.call(MANAGER, "/api/synchrony", { action: "run" });
  const { p1 } = byRash((await t.state()).cases); let sent = "";
  const model = async (url, init) => { sent = JSON.parse(init.body).messages[1].content; const lines = sent.split("\n"), n = lines.findIndex(l => /73 kg/.test(l)) + 1;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ f: [{ i: "p.weight", v: "73 kg", s: n || 1 }] }) } }], usage: { total_tokens: 120 } }); };
  const r = await withFetch(model, () => t.call(SCREENER, "/api/case-ai-fill", { id: p1.id })); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!/73 kg|creatinine/.test(sent), "patient 2's sentences were never sent for patient 1: " + sent.slice(0, 200)); assert.ok(!r.body.proposals.some(p => p.id === "p.weight"), "an unsupported or foreign quote is rejected");
});

test("automation does not overwrite an edit a reviewer saves while it is running", async () => {
  const t = await scenario(); await t.call(MANAGER, "/api/synchrony", { action: "run" });
  const { p1 } = byRash((await t.state()).cases); await t.call(MANAGER, "/api/settings", { autoSmpc: "on" });
  let edited = false;
  const net = async url => { if (String(url).includes("api.fda.gov") && !edited) { edited = true; const mine = JSON.parse(JSON.stringify((await t.state()).cases.find(c => c.id === p1.id).data)); mine.events[0].outcome = field("Recovered/resolved"); mine.patient.weight = field("70");
      const saved = await t.call(SCREENER, "/api/case-save", { id: p1.id, status: "Draft", data: mine }); assert.equal(saved.status, 200, JSON.stringify(saved.body)); }
    return new Response(JSON.stringify({ results: [{ set_id: "s", version: "1", effective_time: "20240101", openfda: { generic_name: ["aciclovir"] }, adverse_reactions: ["Rash has been reported."] }] }), { status: 200 }); };
  const run = await withFetch(net, () => t.call(MANAGER, "/api/case-automate", { id: p1.id })); assert.equal(run.status, 200, JSON.stringify(run.body)); assert.ok(edited, "the lookup happened and the reviewer saved during it");
  const after = (await t.state()).cases.find(c => c.id === p1.id);
  assert.equal(after.data.events[0].outcome.value, "Recovered/resolved", "the reviewer's outcome survives"); assert.equal(after.data.patient.weight.value, "70");
  assert.equal(after.data.events[0].listedness.value, "Listed", "and the automation's own result is still applied");
});

test("QC can return a case that reached QC by routing, to the screener on the assignment", async () => {
  const t = await scenario(); await t.call(MANAGER, "/api/synchrony", { action: "run" });
  const { p1 } = byRash((await t.state()).cases);
  const routed = await t.call(MANAGER, "/api/route", { kind: "case", ids: [p1.id], stage: "qc", to: QC, reason: "Check before medical review" }); assert.equal(routed.status, 200, JSON.stringify(routed.body));
  const back = await t.call(QC, "/api/case-qc", { id: p1.id, decision: "return", note: "Dose is missing" }); assert.equal(back.status, 200, JSON.stringify(back.body)); assert.equal(back.body.to, SCREENER);
});

test("a job that was interrupted mid-run is picked up again and creates each draft once", async () => {
  const t = await scenario(); const s = await t.state(); s.assignments[0].synchrony = { status: "running", lease: "dead", until: Date.now() - 1000, attempts: 1, fingerprint: "stale" }; await t.BUCKET.put("bench.json", JSON.stringify(s));
  assert.equal((await t.call(MANAGER, "/api/synchrony", { action: "run" })).body.processed, 1); assert.equal((await t.state()).cases.length, 2);
  assert.equal((await t.call(MANAGER, "/api/synchrony", { action: "run" })).body.created, 0); assert.equal((await t.state()).cases.length, 2);
});

test("Active mode is scoped to the pilot portfolio: other portfolios stay in Shadow and create no cases", async () => {
  const t = await scenario({ syncMode: "active", syncActivePortfolios: ["Some other portfolio"] }); await t.call(MANAGER, "/api/synchrony", { action: "run" });
  const s = await t.state(); assert.equal(s.cases.length, 0, "Antivirals is not in the pilot list"); assert.equal(s.assignments[0].synchrony.mode, "shadow"); assert.equal(s.assignments[0].synchrony.patients.length, 2, "it still prepared and compared");
  await t.call(MANAGER, "/api/settings", { syncActivePortfolios: "Antivirals" }); await t.call(MANAGER, "/api/synchrony", { action: "run" });
  const s2 = await t.state(); assert.equal(s2.cases.length, 2, "listing the portfolio activates it"); assert.equal(s2.assignments[0].synchrony.mode, "active");
  assert.deepEqual((await (await t.get(MANAGER, "/api/state")).json()).config.syncActivePortfolios, ["Antivirals"]);
});

test("background OpenAI: a quote from the other patient or one that is not in the source is never accepted for the field", async () => {
  const abstract = "Patient 1 was a 54-year-old man who received aciclovir for herpes zoster. He developed a rash on day 4. Patient 2 was a 61-year-old woman who received aciclovir for herpes zoster. She weighed 73 kg and developed acute kidney injury on day 5.";
  const text = abstract + " The authors discuss both cases.";
  const t = await scenario({ syncAiPortfolios: ["Antivirals"], ai: { enabled: true, monthlyTokens: 20000, perCaseTokens: 20000 } }, { OPENAI_API_KEY: "synthetic-test-key-1234567890" }, text, { articles: { 1: { ...article, abstract } } });
  let calls = 0, asked = [];
  const model = async (url, init) => { calls++; const lines = JSON.parse(JSON.parse(init.body).messages[1].content).lines; asked.push(lines.map(l => l.text));
    const every = Array.from({ length: 14 }, (_, i) => "u" + (i + 1));   // the model cites any unit id it likes, including the other patient's
    return Response.json({ choices: [{ message: { content: JSON.stringify({ fields: [...every.map(unit => ({ id: "p.weight", value: "73 kg", unit })), { id: "p.country", value: "Neverland", unit: lines[0]?.id }] }) } }], usage: { total_tokens: 120 } }); };
  await withFetch(model, () => t.call(MANAGER, "/api/synchrony", { action: "run" })); assert.ok(calls >= 1, "the allowed portfolio used the key");
  const cases = (await t.state()).cases, p1 = cases.find(c => /rash/i.test(c.data.events.map(e => e.verbatim.value).join())), p2 = cases.find(c => c !== p1);
  assert.ok(asked.some(l => l.length && !l.join(" ").includes("73 kg")), "patient 1 was only sent patient 1's lines");
  assert.ok(!(p1.preparation.ai.proposals || []).some(x => /73 kg|Neverland/.test(x.value)), "no foreign or unsupported quote is accepted for patient 1");
  assert.ok(!(p2.preparation.ai.proposals || []).some(x => /Neverland/.test(x.value)), "an unsupported quote is rejected for patient 2 as well");
  assert.ok(!p1.data.patient.weight.value, "patient 2's weight never reaches patient 1"); assert.ok(!p2.data.patient.weight.value || p2.data.patient.weight.value === "73", "patient 2 may carry the weight their own sentence states (read by rules), never the AI quote");
});

test("AI data entry respects source permissions: restricted-licence full text and automation send only the public abstract", async () => {
  const abstract = "A 54-year-old man received aciclovir for herpes zoster. He developed a rash on day 4.", body = "A 54-year-old man received aciclovir for herpes zoster. He developed a rash on day 4. He weighed 73 kg and was seen in the hospital in Pune.";
  const mk = async restricted => { const t = await scenario({ ai: { enabled: true, monthlyTokens: 20000, perCaseTokens: 20000 }, syncMode: "off" }, { OPENAI_API_KEY: "synthetic-test-key-1234567890" }, body, { articles: { 1: { ...article, abstract, fullTextRestricted: restricted } } });
    const s = await t.state(); s.cases = [{ id: "c1", number: "LS-1", pmid: "1", portfolio: "Antivirals", molecule: "aciclovir", status: "Draft", stage: "screening", assignee: SCREENER, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01", history: [], versions: [], data: { patient: {}, reporter: {}, dates: {}, confounders: [], treatment_given: [], products: [{ role: "suspect", name: field("aciclovir") }], events: [{ verbatim: field("rash") }] } }];
    await t.BUCKET.put("bench.json", JSON.stringify(s)); return t; };
  const sentTo = async t => { let sent = ""; await withFetch(async (u, init) => { sent = JSON.parse(init.body).messages[1].content; return Response.json({ choices: [{ message: { content: "{}" } }], usage: { total_tokens: 50 } }); }, () => t.call(SCREENER, "/api/case-ai-fill", { id: "c1" })); return sent; };
  assert.match(await sentTo(await mk(false)), /73 kg/, "a person pressing the button on permissive full text may send redacted body sentences");
  const restricted = await sentTo(await mk(true)); assert.ok(restricted && !/73 kg/.test(restricted), "restricted-licence text is never sent beyond the public abstract: " + restricted.slice(0, 160));
});

import worker from "../worker/index.js";
test("a scanned PDF falls back to OCR text: the evidence records the method, and events and tests come from that text", async () => {
  const t = await scenario({ syncMode: "off" }); const bytes = new TextEncoder().encode("%PDF-1.4 scanned image only");
  await t.BUCKET.put("evidence/9/scan.pdf", bytes);
  t.env.PDF_TEXT_FN = async (b, info) => { info.method = "ocr"; info.parser = "tesseract + pdftoppm"; info.textLayerUsable = false; return "Case presentation\nA 54-year-old man received aciclovir. He developed a rash on day 4. Serum creatinine was 2.4 mg/dL on day 3."; };
  const text = await worker.pdfToText(t.env, bytes.buffer); assert.match(text, /rash on day 4/);
  const ev = await worker.buildFullTextEvidence(t.env, "9", { fullTextKey: "evidence/9/scan.pdf", fullTextStatus: "Captured", fullTextOrigin: "Unpaywall", fullTextLicense: "cc-by" }, true);
  const rec = ev.patch.fulltext; assert.equal((rec.extraction || {}).method, "ocr"); assert.equal(rec.extraction.textLayerUsable, false); assert.ok(rec.sha256 && rec.format === "pdf", "checksum and format are recorded");
  const rows = worker.extractInvestigations(text.split(/(?<=[.!?])\s+/).map((x, i) => ({ id: "u" + i, text: x }))); assert.ok(rows.some(r => /creatinine/i.test(r.test) && r.result === "2.4"), "tests are read from OCR text");
});
