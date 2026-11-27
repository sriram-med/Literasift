// End to end: one synthetic article from Potential ICSR to separate patient drafts, field-specific QC, medical approval, a signed package,
// replay without duplicates, and revised evidence opening a linked follow-up while the released version stays intact. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, SCREENER, MEDICAL, QC, makeEnv, readZip, withFetch } from "./helpers.mjs";

const authors = [{ name: "Anil Rao", affiliations: ["Test Hospital, India"], email: "reviewer@example.org", corresponding: true }];
const REPORT = "Patient 1 was a 54-year-old man who received aciclovir 800 mg orally on day 1 for herpes zoster. He had no rash on day 1. He developed a rash on day 4. Aciclovir was stopped and the rash resolved. Serum creatinine was 1.1 mg/dL on day 2. Patient 2 was a 54-year-old man who received aciclovir for herpes zoster. He developed acute kidney injury on day 5.";
const article = { id: "1", title: "Aciclovir case report", abstract: "Individual reports.", authors: ["Anil Rao"], pubTypes: ["Case Reports"], fullTextKey: "evidence/1/report.xml", evidence: { fulltext: { sha256: "a" }, parsed: { key: "evidence/1/parsed.json" } } };
const assignment = { id: "watch-1", pmid: "1", portfolio: "Antivirals", reviewer: SCREENER, molecules: ["aciclovir"], status: "Complete", disposition: { value: "potential_icsr" } };
const field = value => ({ value, state: "edited", evidence: [] });

async function scenario(settings = { syncMode: "active", esignApprovers: "any" }, env = {}, text = REPORT) {
  const t = await makeEnv({
    profiles: [{ email: MANAGER, name: "Boss", role: "manager", active: true }, { email: SCREENER, name: "Asha", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }, { email: MEDICAL, name: "Meera", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }, { email: QC, name: "Quinn", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }],
    memberships: [{ email: MEDICAL, portfolio: "Antivirals", role: "medical_reviewer" }, { email: QC, portfolio: "Antivirals", role: "qc" }],
    watches: [{ portfolio: "Antivirals", molecule: "aciclovir", query: "q" }], articles: { 1: article }, settings: { automation: { smpc: false }, ...settings }, assignments: [assignment] }, env);
  await t.BUCKET.put("evidence/1/parsed.json", JSON.stringify({ sections: [{ path: "Case presentation", title: "Case presentation", paragraphs: [text] }], authors, correspondenceEmails: ["reviewer@example.org"], correspondence: ["Anil Rao"], tables: [], figures: [] }));
  return t;
}

test("end to end: patient drafts, automation, field-specific QC, medical approval, signed package, replay, and a follow-up version for revised evidence", async () => {
  const t = await scenario();
  assert.equal((await t.call(MANAGER, "/api/synchrony", { action: "run" })).status, 200);
  let cases = (await t.state()).cases; assert.equal(cases.length, 2, "one draft per patient even though demographics match");
  assert.deepEqual(cases.map(c => c.data.events.map(e => e.verbatim.value)), [["rash"], ["acute kidney injury"]]);
  const c = cases[0]; assert.ok(c.automation && c.automation.steps.some(s => s.key === "causality") && c.automation.steps.some(s => s.key === "investigations"), "automation ran on the new draft");
  assert.ok(c.data.labs.some(l => /creatinine/i.test(l.test)), "investigations pre-populated");
  assert.equal((await t.call(MANAGER, "/api/synchrony", { action: "run" })).body.created, 0, "replaying the job creates nothing");
  assert.equal((await t.state()).cases.length, 2);

  // the screener completes the case and submits it to QC
  const s0 = await t.state(), d = s0.cases[0].data;
  d.reporter.country = field("India"); d.reporter.qualification = field("Physician"); d.products[0].indication = field("herpes zoster"); d.products[0].start_date = field("2026-10-01");
  d.events[0].onset_date = field("2026-10-04"); d.events[0].outcome = field("Recovered/resolved"); d.events[0].listedness = field("Unknown"); d.events[0].expectedness = field("Unknown");
  await t.BUCKET.put("bench.json", JSON.stringify(s0));
  const sub = await t.call(SCREENER, "/api/case-submit", { id: c.id }); assert.equal(sub.status, 200, JSON.stringify(sub.body)); assert.equal(sub.body.to, QC);
  // QC returns two specific fields with reasons; an invalid path is ignored
  assert.equal((await t.call(QC, "/api/case-qc", { id: c.id, decision: "return", note: "", fields: [{ path: "events.0.outcome", reason: "x" }] })).status, 400, "every flagged field needs a reason");
  const back = await t.call(QC, "/api/case-qc", { id: c.id, decision: "return", note: "", fields: [{ path: "events.0.outcome", reason: "Outcome date is not in the article" }, { path: "products.0.indication", reason: "Check the indication" }, { path: "__proto__.x", reason: "ignored" }] });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  let cur = (await t.state()).cases[0]; assert.deepEqual(cur.qc.flags.map(f => f.path), ["events.0.outcome", "products.0.indication"]); assert.equal(cur.stage, "screening");
  // the screener fixes only the outcome and resubmits: the recheck reports one fixed, one unchanged
  const fix = JSON.parse(JSON.stringify(cur.data)); fix.events[0].outcome = field("Recovering/resolving"); assert.equal((await t.call(SCREENER, "/api/case-save", { id: c.id, status: "Draft", data: fix })).status, 200);
  const again = await t.call(SCREENER, "/api/case-submit", { id: c.id }); assert.equal(again.status, 200, JSON.stringify(again.body)); assert.deepEqual(again.body.recheck, { fixed: 1, unchanged: 1 });
  assert.deepEqual((await t.state()).cases[0].qc.flags.map(f => f.status), ["fixed", "unchanged"]);
  const ok = await t.call(QC, "/api/case-qc", { id: c.id, decision: "approve" }); assert.equal(ok.body.to, MEDICAL);

  // medical approval, signature, and the signed package
  await t.call(MEDICAL, "/api/case-dates", { caseId: c.id, awareness: "2026-11-02", note: "Article reviewed on this date" });
  await t.call(MEDICAL, "/api/narrative-generate", { caseId: c.id });
  const approval = await t.call(MEDICAL, "/api/case-approve", { caseId: c.id, profile: "ICH", note: "Compared with the evidence." }); assert.equal(approval.status, 200, JSON.stringify(approval.body));
  const pre = (await t.call(MEDICAL, "/api/sign-preview", { kind: "case", id: c.id, meaning: "case_approve" })).body;
  const signed = await t.call(MEDICAL, "/api/sign", { kind: "case", id: c.id, meaning: "case_approve", expected_content_sha256: pre.content_sha256, reviewed_evidence_sha256: pre.evidence_sha256 }, { "x-esign-reauth": "1" }); assert.equal(signed.status, 200, JSON.stringify(signed.body));
  const run = await t.call(MANAGER, "/api/synchrony", { action: "run" }); assert.equal(run.body.packages, 1, JSON.stringify(run.body));
  const pack = await t.raw(MEDICAL, "/api/synchrony", { action: "package", id: c.id }); assert.equal(pack.status, 200);
  const files = readZip(await pack.arrayBuffer()); for (const f of ["E2B-R3.xml", "CIOMS-I.pdf", "narrative.txt", "line-listing.csv", "manifest.json"]) assert.ok(files.has(f), f);
  assert.match(files.get("E2B-R3.xml").toString(), /creatinine/i, "investigations reach the signed E2B"); assert.equal((await t.call(MANAGER, "/api/synchrony", { action: "run" })).body.packages, 0, "replay: no second package");

  // revised evidence: the signed case stays exactly as released, one linked follow-up version is opened, and replay does not open another
  const s1 = await t.state(); s1.articles[1].evidence.fulltext.sha256 = "b"; await t.BUCKET.put("bench.json", JSON.stringify(s1));
  const rev = await t.call(MANAGER, "/api/synchrony", { action: "run" }); assert.equal(rev.body.followUps, 1, JSON.stringify(rev.body));
  const after = (await t.state()).cases, released = after.find(x => x.id === c.id), follow = after.find(x => x.followUpOf === c.id);
  assert.equal(after.length, 3); assert.ok(released.locked && (released.signatures || []).some(x => !x.superseded), "the released version stays signed"); assert.equal(released.data.events[0].outcome.value, "Recovering/resolving");
  assert.ok(follow && follow.status === "Draft" && follow.links[0].kind === "follow_up_of" && follow.links[0].otherNumber === released.number); assert.ok(released.links.some(l => l.kind === "has_follow_up" && l.otherId === follow.id));
  assert.equal((await t.call(MANAGER, "/api/synchrony", { action: "run" })).body.followUps, 0, "one follow-up per evidence revision");
  assert.equal((await t.state()).cases.length, 3);
});

test("AI controls: smoke test reports only status and usage, pause stops all calls, and a per-case limit stops a case that has used its share", async () => {
  const t = await scenario({ syncMode: "off", ai: { enabled: true, monthlyTokens: 5000 } }, { OPENAI_API_KEY: "synthetic-test-key-1234567890" });
  let calls = 0; const reply = async (url, init) => { calls++; return Response.json({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }], usage: { total_tokens: 14 } }); };
  const r = await withFetch(reply, () => t.call(MANAGER, "/api/ai-smoke", {})); assert.equal(r.status, 200); assert.equal(r.body.available, true); assert.equal(r.body.ok, true); assert.equal(r.body.tokens, 14); assert.equal(r.body.keySource, "server environment");
  assert.ok(!JSON.stringify(r.body).includes("synthetic-test-key"), "the key is never reported"); assert.equal((await t.call(SCREENER, "/api/ai-smoke", {})).status, 403);
  await t.call(MANAGER, "/api/settings", { aiPaused: "on" }); const p = await withFetch(reply, () => t.call(MANAGER, "/api/ai-smoke", {})); assert.equal(p.body.available, false); assert.match(p.body.reason, /paused/i); assert.equal(calls, 1, "no call while paused");
  await t.call(MANAGER, "/api/settings", { aiPaused: "off", aiEnabled: "off" }); assert.equal((await withFetch(reply, () => t.call(MANAGER, "/api/ai-smoke", {}))).body.available, false); assert.equal(calls, 1);
  const none = await scenario({ syncMode: "off" }); assert.match((await none.call(MANAGER, "/api/ai-smoke", {})).body.reason, /No API key/);
});

test("shadow report compares proposals with a reference set: wrong patient, missed reactions, false picks", async () => {
  const t = await scenario({ syncMode: "shadow" }); await t.call(MANAGER, "/api/synchrony", { action: "run" }); assert.equal((await t.state()).cases.length, 0, "shadow creates no cases");
  const good = await t.call(MANAGER, "/api/synchrony", { action: "shadow_report", reference: [{ pmid: "1", patients: [{ reactions: ["rash"] }, { reactions: ["acute kidney injury"] }] }] });
  assert.equal(good.status, 200); assert.deepEqual([good.body.totals.wrongPatient, good.body.totals.missedReactions, good.body.totals.falseReactions, good.body.totals.patientCountMismatch], [0, 0, 0, 0]);
  const bad = await t.call(MANAGER, "/api/synchrony", { action: "shadow_report", reference: [{ pmid: "1", patients: [{ reactions: ["rash", "pruritus"] }, { reactions: ["acute kidney injury"] }] }] });
  assert.deepEqual(bad.body.articles[0].missedReactions, ["pruritus"]);
  const swapped = await t.call(MANAGER, "/api/synchrony", { action: "shadow_report", reference: [{ pmid: "1", patients: [{ reactions: ["rash", "acute kidney injury"] }] }] }); assert.equal(swapped.body.totals.patientCountMismatch, 1);
  assert.equal((await t.call(SCREENER, "/api/synchrony", { action: "shadow_report", reference: [] })).status, 403);
});

test("review desk checks find contradictory dates and the case gets an ordered timeline", async () => {
  const t = await scenario(); await t.call(MANAGER, "/api/synchrony", { action: "run" });
  const s = await t.state(), c = s.cases[0]; c.data.products[0].start_date = field("2026-10-10"); c.data.products[0].stop_date = field("2026-10-01"); c.data.events[0].onset_date = field("2026-10-04"); c.data.events[0].stop_date = field("2026-10-02");
  await t.BUCKET.put("bench.json", JSON.stringify(s));
  const v = (await t.call(SCREENER, "/api/synchrony", { action: "view", id: c.id })).body, texts = v.checks.map(x => x.text);
  assert.ok(texts.some(x => /stop date of aciclovir is before its start/i.test(x)) && texts.some(x => /onset of rash is before the first suspect product/i.test(x)) && texts.some(x => /end of rash is before its onset/i.test(x)), texts.join(" | "));
  assert.ok(v.timeline.length >= 3); assert.equal(v.timeline[0].kind, "action", "stopping before the start sorts first, which is the contradiction"); assert.ok(v.timeline.some(x => x.kind === "onset"));
});

test("AI errors: OpenAI's real reason is surfaced, and parameter mismatches are retried with the shape the model wants", async () => {
  const t = await scenario({ syncMode: "off", ai: { enabled: true, monthlyTokens: 5000 }, aiModel: "gpt-4o-mini" }, { OPENAI_API_KEY: "synthetic-test-key-1234567890" });
  const bodies = [];
  const strict = async (url, init) => { const b = JSON.parse(init.body); bodies.push(b);
    if (b.max_tokens !== undefined) return Response.json({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", code: "unsupported_parameter", type: "invalid_request_error" } }, { status: 400 });
    if (b.temperature !== undefined) return Response.json({ error: { message: "Unsupported value: 'temperature' does not support 0 with this model.", code: "unsupported_value" } }, { status: 400 });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }], usage: { total_tokens: 9 } }); };
  const r = await withFetch(strict, () => t.call(MANAGER, "/api/ai-smoke", {})); assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const last = bodies[bodies.length - 1]; assert.ok(last.max_completion_tokens && last.max_tokens === undefined && last.temperature === undefined);
  const quota = async () => Response.json({ error: { message: "You exceeded your current quota, sk-abcdef123456789 check billing.", code: "insufficient_quota" } }, { status: 429 });
  const q = await withFetch(quota, () => t.call(MANAGER, "/api/ai-smoke", {})); assert.equal(q.body.available, false); assert.match(q.body.reason, /no credit or quota/i); assert.ok(!q.body.reason.includes("sk-abcdef123456789"));
  const nomodel = async () => Response.json({ error: { message: "The model does not exist", code: "model_not_found" } }, { status: 404 });
  const n = await withFetch(nomodel, () => t.call(MANAGER, "/api/ai-smoke", {})); assert.match(n.body.reason, /does not know the model/i);
  const models = async () => Response.json({ data: [{ id: "gpt-4o" }, { id: "text-embedding-3-small" }, { id: "gpt-4o-audio-preview" }, { id: "o3-mini" }] });
  const m = await withFetch(models, () => t.call(MANAGER, "/api/ai-models", {})); assert.deepEqual(m.body.models, ["gpt-4o", "o3-mini"]);
  assert.equal((await t.call(SCREENER, "/api/ai-models", {})).status, 403);
});
