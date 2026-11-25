// Tests for the hash-chained audit trail and the electronic signatures. Run with: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import worker from "../worker/index.js";
import { FileBucket } from "../server/storage.mjs";

const MANAGER = "boss@example.org", REVIEWER = "asha@example.org";
async function setup(extraEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ls-test-")), BUCKET = new FileBucket(dir + "/objects");
  const env = { BUCKET, RUN_TOKEN: "x".repeat(40), HOST_ACCOUNTS: true, AUDIT_ANCHOR_KEY: "k".repeat(32), ...extraEnv };
  const state = { profiles: [{ email: MANAGER, name: "Boss", role: "manager", active: true }, { email: REVIEWER, name: "Asha", role: "reviewer", active: true, capacity: 9 }],
    watches: [{ portfolio: "Antivirals", molecule: "aciclovir", query: "q" }], settings: {}, runs: [],
    articles: { 1: { id: "1", title: "Aciclovir neurotoxicity", abstract: "A 54-year-old man developed confusion after aciclovir.", authors: ["A B"], doi: "10.1/1", events: [] } },
    assignments: [{ id: "a1", pmid: "1", portfolio: "Antivirals", molecules: ["aciclovir"], reviewer: REVIEWER, status: "In review" }] };
  await BUCKET.put("bench.json", JSON.stringify(state));
  const call = async (who, path, body = {}, headers = {}) => {
    const r = await worker.fetch(new Request("http://localhost" + path, { method: "POST", headers: { "oai-authenticated-user-email": who, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }), env);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  return { dir, env, BUCKET, call };
}
// FileBucket stores each key under the SHA-256 of its name.
const rawPath = (dir, key) => `${dir}/objects/${createHash("sha256").update(key).digest("hex")}`;
const monthFile = (dir) => rawPath(dir, "audit2/" + new Date().toISOString().slice(0, 7) + ".ndjson");
const benchFile = (dir) => rawPath(dir, "bench.json");
const REAUTH = { "x-esign-reauth": "1" };

async function sign(t, who, kind, id, extra = {}, headers = REAUTH) {
  const pre = (await t.call(who, "/api/sign-preview", { kind, id, ...extra })).body;
  return t.call(who, "/api/sign", { kind, id, ...extra, expected_content_sha256: pre.content_sha256, reviewed_evidence_sha256: pre.evidence_sha256 }, headers);
}

test("audit entries form a contiguous, verifiable hash chain", async () => {
  const t = await setup();
  for (let i = 0; i < 5; i++) await worker.audit(t.env, { by: MANAGER, action: "settings.change", target: "s" + i, detail: "n" + i });
  const chain = await worker.verifyAuditChain(t.env);
  assert.equal(chain.ok, true); assert.equal(chain.entries_checked, 5);
  const lines = (await readFile(monthFile(t.dir), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(lines.map(l => l.sequence), [0, 1, 2, 3, 4]);
  assert.equal(lines[0].prev_hash, "0".repeat(64));
  assert.equal(lines[3].prev_hash, lines[2].hash);
});

test("parallel appends stay contiguous", async () => {
  const t = await setup();
  await Promise.all(Array.from({ length: 12 }, (_, i) => worker.audit(t.env, { by: "system", action: "pull.run", target: "p" + i })));
  const chain = await worker.verifyAuditChain(t.env);
  assert.equal(chain.ok, true); assert.equal(chain.entries_checked, 12);
});

for (const [name, tamper] of Object.entries({
  "editing an entry": lines => { lines[2] = lines[2].replace(/"action":"[^"]+"/, '"action":"x.edited"'); return lines; },
  "deleting an entry": lines => lines.filter((_, i) => i !== 2),
  "reordering entries": lines => [lines[0], lines[2], lines[1], ...lines.slice(3)],
  "truncating the tail": lines => lines.slice(0, -1),
})) {
  test(`verification detects ${name}`, async () => {
    const t = await setup();
    for (let i = 0; i < 5; i++) await worker.audit(t.env, { by: MANAGER, action: "settings.change", target: "s" + i });
    const file = monthFile(t.dir), lines = (await readFile(file, "utf8")).trim().split("\n");
    await writeFile(file, tamper(lines).join("\n") + "\n");   // written directly, bypassing the storage guard, as a database administrator could
    const chain = await worker.verifyAuditChain(t.env);
    assert.equal(chain.ok, false, name); assert.ok(chain.reason);
  });
}

test("storage refuses to rewrite or shrink the audit log, and the head cannot move backwards", async () => {
  const t = await setup();
  for (let i = 0; i < 3; i++) await worker.audit(t.env, { by: MANAGER, action: "settings.change", target: "s" + i });
  const key = "audit2/" + new Date().toISOString().slice(0, 7) + ".ndjson", current = await (await t.BUCKET.get(key)).text();
  await assert.rejects(() => t.BUCKET.put(key, current.split("\n").slice(1).join("\n")), /append-only/);
  await assert.rejects(() => t.BUCKET.put(key, "{}\n"), /append-only/);
  await assert.rejects(() => t.BUCKET.put("audit2/head.json", JSON.stringify({ sequence: 0, hash: "0".repeat(64) })), /append-only|backwards/);
});

test("an anchor taken earlier detects a later rewrite of history", async () => {
  const t = await setup();
  for (let i = 0; i < 4; i++) await worker.audit(t.env, { by: MANAGER, action: "settings.change", target: "s" + i });
  const anchor = await worker.auditAnchor(t.env);
  assert.equal((await t.call(MANAGER, "/api/audit-anchor-check", { anchor })).body.ok, true);
  const file = monthFile(t.dir), lines = (await readFile(file, "utf8")).trim().split("\n");
  lines[1] = lines[1].replace(/"action":"[^"]+"/, '"action":"x.edited"');
  await writeFile(file, lines.join("\n") + "\n");
  assert.equal((await t.call(MANAGER, "/api/audit-anchor-check", { anchor })).body.ok, false);
});

test("audit routes are manager-only", async () => {
  const t = await setup();
  for (const path of ["/api/audit", "/api/audit-verify", "/api/audit-anchor"]) assert.equal((await t.call(REVIEWER, path)).status, 403, path);
  assert.equal((await t.call(MANAGER, "/api/audit-verify")).body.ok, true);
});

test("a screening decision can be signed; the signature binds to the exact content", async () => {
  const t = await setup();
  const pre = (await t.call(REVIEWER, "/api/sign-preview", { kind: "screening", id: "a1" })).body;
  assert.match(pre.content_sha256, /^[0-9a-f]{64}$/); assert.equal(pre.problems.length, 0);
  const res = await sign(t, REVIEWER, "screening", "a1");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const sig = res.body.signature;
  assert.equal(sig.signer_id, REVIEWER); assert.equal(sig.signer_name, "Asha"); assert.equal(sig.meaning, "screening"); assert.match(sig.signed_at, /Z$/);
  const stored = JSON.parse(await readFile(benchFile(t.dir), "utf8")).assignments[0];
  assert.equal(stored.status, "Complete"); assert.equal(stored.signatures.length, 1);
  const log = (await readFile(monthFile(t.dir), "utf8")).trim().split("\n").map(JSON.parse).find(e => e.action === "sign.signed");
  assert.equal(log.detail.content_sha256, sig.content_sha256);
});

test("signing needs password re-entry when the host manages accounts", async () => {
  const t = await setup();
  const res = await sign(t, REVIEWER, "screening", "a1", {}, {});
  assert.equal(res.status, 401);
});

test("review binding: a stale content or evidence hash is refused", async () => {
  const t = await setup();
  const pre = (await t.call(REVIEWER, "/api/sign-preview", { kind: "screening", id: "a1" })).body;
  const stale = await t.call(REVIEWER, "/api/sign", { kind: "screening", id: "a1", expected_content_sha256: "0".repeat(64), reviewed_evidence_sha256: pre.evidence_sha256 }, REAUTH);
  assert.equal(stale.status, 409);
  const wrongEvidence = await t.call(REVIEWER, "/api/sign", { kind: "screening", id: "a1", expected_content_sha256: pre.content_sha256, reviewed_evidence_sha256: "f".repeat(64) }, REAUTH);
  assert.equal(wrongEvidence.status, 409);
  // The article changes after the reviewer opened it: their hash no longer matches.
  const bench = JSON.parse(await readFile(benchFile(t.dir), "utf8")); bench.articles["1"].abstract += " New sentence.";
  await t.BUCKET.put("bench.json", JSON.stringify(bench));
  const changed = await t.call(REVIEWER, "/api/sign", { kind: "screening", id: "a1", expected_content_sha256: pre.content_sha256, reviewed_evidence_sha256: pre.evidence_sha256 }, REAUTH);
  assert.equal(changed.status, 409);
});

test("a signed record is locked, and only a manager can supersede with a reason", async () => {
  const t = await setup();
  assert.equal((await sign(t, REVIEWER, "screening", "a1")).status, 200);
  assert.equal((await sign(t, REVIEWER, "screening", "a1")).status, 409);                                   // cannot sign twice
  assert.notEqual((await t.call(REVIEWER, "/api/review", { id: "a1", status: "Pending", note: "x" })).status, 200);   // cannot change a signed decision
  assert.equal((await t.call(REVIEWER, "/api/supersede", { kind: "screening", id: "a1", reason: "long enough reason" })).status, 403);
  assert.equal((await t.call(MANAGER, "/api/supersede", { kind: "screening", id: "a1", reason: "short" })).status, 400);
  assert.equal((await t.call(MANAGER, "/api/supersede", { kind: "screening", id: "a1", reason: "Reviewer asked for a correction" })).status, 200);
  const stored = JSON.parse(await readFile(benchFile(t.dir), "utf8")).assignments[0];
  assert.equal(stored.signatures.length, 1, "superseded signatures are kept, never deleted");
  assert.ok(stored.signatures[0].superseded.reason);
  assert.equal((await t.call(REVIEWER, "/api/review", { id: "a1", status: "Pending", note: "fixed" })).status, 200);
  assert.equal((await sign(t, REVIEWER, "screening", "a1")).status, 200);                                   // can be signed again
  const actions = (await readFile(monthFile(t.dir), "utf8")).trim().split("\n").map(JSON.parse).map(e => e.action);
  assert.ok(actions.includes("sign.signed") && actions.includes("sign.superseded"));
  assert.equal((await worker.verifyAuditChain(t.env)).ok, true);
});

test("case approvals follow the signer policy, four-eyes rule and readiness checks", async () => {
  const t = await setup();
  const created = (await t.call(MANAGER, "/api/case-create", { pmid: "1" })).body.case;
  // Not a valid ICSR needs a reason in the notes.
  assert.equal((await sign(t, MANAGER, "case", created.id, { meaning: "case_invalid" })).status, 409);
  await t.call(MANAGER, "/api/case-save", { id: created.id, status: "Draft", data: created.data, notes: "No identifiable patient." });
  // Reviewers cannot sign approvals by default.
  const asReviewer = await t.call(REVIEWER, "/api/sign-preview", { kind: "case", id: created.id, meaning: "case_invalid" });
  assert.equal(asReviewer.status, 200, "the reviewer the case was assigned to can open it");
  assert.ok(asReviewer.body.problems.some(p => /Only managers may sign approvals/.test(p)), "but cannot sign an approval");
  const ok = await sign(t, MANAGER, "case", created.id, { meaning: "case_invalid" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.record.locked, true);
  assert.equal((await t.call(MANAGER, "/api/case-save", { id: created.id, status: "Draft", data: created.data, notes: "edit" })).status, 409);
  assert.equal((await t.call(MANAGER, "/api/case-delete", { id: created.id })).status, 409);
  // Four-eyes: the creator cannot approve their own case when the policy is on.
  await t.call(MANAGER, "/api/supersede", { kind: "case", id: created.id, reason: "Reopening to test four-eyes" });
  await t.call(MANAGER, "/api/settings", { esignFourEyes: true });
  const four = (await t.call(MANAGER, "/api/sign-preview", { kind: "case", id: created.id, meaning: "case_invalid" })).body;
  assert.ok(four.problems.some(p => /Four-eyes/.test(p)));
});

test("changing a signed case outside the app is reported as changed after signing", async () => {
  const t = await setup();
  const created = (await t.call(MANAGER, "/api/case-create", { pmid: "1" })).body.case;
  await t.call(MANAGER, "/api/case-save", { id: created.id, status: "Draft", data: created.data, notes: "No identifiable patient." });
  assert.equal((await sign(t, MANAGER, "case", created.id, { meaning: "case_invalid" })).status, 200);
  const bench = JSON.parse(await readFile(benchFile(t.dir), "utf8")); bench.cases[0].notes = "silently changed";
  await t.BUCKET.put("bench.json", JSON.stringify(bench));
  const pre = (await t.call(MANAGER, "/api/sign-preview", { kind: "case", id: created.id })).body;
  assert.equal(pre.intact, false);
});

const FULL_TEXT = [
  "Introduction", "Hepatic failure has been described with many drugs.",
  "Case presentation", "A 54-year-old man with type 2 diabetes was admitted with jaundice. He had started aciclovir 10 days earlier.",
  "Liver function tests showed Hepatic Failure and he was hospitalised. Aciclovir was stopped and the jaundice resolved within a week.",
  "Discussion", "Seizures were not observed in this patient.",
].join("\n");

test("verbatim phraser reads events from the case section and keeps the exact wording and sentence", () => {
  const article = { id: "1", title: "Aciclovir and the liver", abstract: "A case report.", entities: { diseases: ["hepatic failure", "jaundice"] }, pubTypes: ["Case Reports"] };
  const r = worker.applyDetection(article, ["aciclovir"], null, [], FULL_TEXT);
  assert.equal(r.detectedFrom, "Full text and abstract");
  const event = r.events.find(e => /hepatic failure/i.test(e.term));
  assert.ok(event, "event found");
  assert.equal(event.verbatim.reported, "Hepatic Failure");               // exact wording, original casing
  assert.equal(event.verbatim.section, "Case presentation");              // not the Introduction mention
  assert.match(event.verbatim.quote, /^Liver function tests showed Hepatic Failure/);
  assert.equal(event.serious.hospitalization, true);
  assert.ok(r.caseFacts, "case facts are extracted from the same text");
});

test("full-text articles go to the ICSR workbench with verbatim evidence; each article once", async () => {
  const t = await setup();
  const bench = JSON.parse(await readFile(benchFile(t.dir), "utf8"));
  Object.assign(bench.articles["1"], { entities: { diseases: ["hepatic failure"] }, fullTextStatus: "Captured", fullTextKey: "evidence/1/x.pdf", ...worker.applyDetection({ ...bench.articles["1"], entities: { diseases: ["hepatic failure"] } }, ["aciclovir"], null, [], FULL_TEXT) });
  await t.BUCKET.put("bench.json", JSON.stringify(bench));
  const first = (await t.call(REVIEWER, "/api/icsr-intake")).body;
  assert.equal(first.created.length, 1);
  const again = (await t.call(REVIEWER, "/api/icsr-intake")).body;
  assert.equal(again.created.length, 0); assert.equal(again.existing, 1);
  const stored = JSON.parse(await readFile(benchFile(t.dir), "utf8")).cases[0];
  assert.equal(stored.intake, "manual");
  const ev = stored.data.events[0];
  assert.equal(ev.verbatim.value, "Hepatic Failure");
  assert.match(ev.verbatim.evidence[0].excerpt, /^\[Case presentation\] Liver function tests/);
});

test("articles without detected events or full text are not added", async () => {
  const t = await setup();
  const bench = JSON.parse(await readFile(benchFile(t.dir), "utf8"));
  Object.assign(bench.articles["1"], { fullTextStatus: "Captured", fullTextKey: "evidence/1/x.pdf", events: [] });
  await t.BUCKET.put("bench.json", JSON.stringify(bench));
  const r = (await t.call(REVIEWER, "/api/icsr-intake")).body;
  assert.equal(r.created.length, 0); assert.equal(r.noEvents, 1);
});

const ageOf = abstract => worker.applyDetection({ id: "9", title: "Case", abstract, entities: {}, pubTypes: ["Case Reports"] }, ["aciclovir"], null, []).caseFacts.patient;
test("patient age is picked from the usual ways articles write it", () => {
  assert.equal(ageOf("A 54-year-old man took aciclovir.").age, "54");
  assert.equal(ageOf("A 54 year old woman took aciclovir.").age, "54");
  assert.equal(ageOf("A 54-yr-old man took aciclovir.").age, "54");
  assert.equal(ageOf("A 54 y/o man took aciclovir.").age, "54");
  assert.equal(ageOf("A man aged 54 years took aciclovir.").age, "54");
  assert.equal(ageOf("A 54 years of age man took aciclovir.").age, "54");
  const baby = ageOf("A 3-month-old girl received aciclovir.");
  assert.equal(baby.age, "3"); assert.equal(baby.age_unit, "months");
  assert.equal(ageOf("A man in his 60s took aciclovir.").age_group, "60s");
});

test("a case from an article identifies the patient by age and sex and is valid without a name", async () => {
  const t = await setup();
  const bench = JSON.parse(await readFile(benchFile(t.dir), "utf8"));
  Object.assign(bench.articles["1"], { fullTextStatus: "Captured", fullTextKey: "k", entities: { diseases: ["hepatic failure"] }, journal: "J", ...worker.applyDetection({ ...bench.articles["1"], entities: { diseases: ["hepatic failure"] } }, ["aciclovir"], null, [], FULL_TEXT) });
  await t.BUCKET.put("bench.json", JSON.stringify(bench));
  const made = (await t.call(MANAGER, "/api/case-create", { pmid: "1" })).body;
  assert.match(made.case.data.patient.identifier.value, /54-year-old male \(name withheld in the publication\)/);
  assert.equal(made.assessment.validity.identifiable_patient, true);
});

test("a date the article does not give can be confirmed as not reported", async () => {
  const t = await setup();
  const bench = JSON.parse(await readFile(benchFile(t.dir), "utf8"));
  Object.assign(bench.articles["1"], { fullTextStatus: "Captured", fullTextKey: "k", journal: "J", ...worker.applyDetection({ ...bench.articles["1"], entities: { diseases: ["hepatic failure"] } }, ["aciclovir"], null, [], FULL_TEXT) });
  await t.BUCKET.put("bench.json", JSON.stringify(bench));
  const made = (await t.call(MANAGER, "/api/case-create", { pmid: "1" })).body;
  const before = made.assessment;
  assert.ok(before.qc.findings.some(f => f.severity === "major" && /start date/i.test(f.title)));
  assert.ok(before.follow_up.questions.some(q => /start date/i.test(q.question)));
  const data = made.case.data;
  data.products[0].start_not_reported = true; data.events[0].onset_not_reported = true;
  data.events[0].time_to_onset = { value: "10 days after starting", state: "edited", evidence: [], normalized_value: null };
  const after = (await t.call(MANAGER, "/api/case-assess", { id: made.case.id, data })).body.assessment;
  assert.ok(!after.qc.findings.some(f => f.severity === "major" && /start date|onset date/i.test(f.title)));
  assert.ok(after.qc.findings.some(f => f.severity === "info" && /not reported in the article/.test(f.title)));
  assert.ok(!after.follow_up.questions.some(q => /start date|onset date/i.test(q.question)));
  assert.notEqual(after.causality.category, "Unassessable / Unclassifiable");
  assert.ok(after.qc.score > before.qc.score);
});

test("event coding picker offers the IME list and earlier reviewed codings", async () => {
  const t = await setup();
  const made = (await t.call(MANAGER, "/api/case-create", { pmid: "1" })).body;
  const c = made.case; c.data.events[0] = { ...c.data.events[0], verbatim: { value: "Liver failure", state: "edited", evidence: [] }, pt: { value: "Hepatic failure", state: "edited", evidence: [] }, soc: { value: "Hepatobiliary disorders", state: "edited", evidence: [] }, coding_status: { value: "Reviewed", state: "edited", evidence: [] } };
  await t.call(MANAGER, "/api/case-save", { id: c.id, status: "Draft", data: c.data, notes: "" });
  const second = (await t.call(MANAGER, "/api/case-create", { pmid: "1" })).body.case;
  const r = (await t.call(MANAGER, "/api/case-coding", { id: second.id, verbatim: "liver failure" })).body;
  assert.equal(r.memory[0].pt, "Hepatic failure"); assert.equal(r.memory[0].score, 1);
  assert.deepEqual(r.ime, []);
});

const evTerms = (abstract, diseases) => worker.applyDetection({ id: "7", title: "T", abstract, entities: { diseases }, pubTypes: [] }, ["aciclovir"], null, []).events.map(e => e.term);
test("negated events are not picked (NegEx rules from negspacy)", () => {
  assert.deepEqual(evTerms("The patient had no seizures after aciclovir.", ["seizures"]), []);
  assert.deepEqual(evTerms("Seizures were not observed after aciclovir.", ["seizures"]), []);
  assert.deepEqual(evTerms("Aciclovir was started. Hepatic failure was ruled out.", ["hepatic failure"]), []);
  assert.deepEqual(evTerms("He was seizure free on aciclovir.", ["seizure"]), []);
  assert.deepEqual(evTerms("Aciclovir was given, but he developed seizures.", ["seizures"]), ["seizures"]);   // scope ends at "but"
  assert.deepEqual(evTerms("He developed seizures after aciclovir.", ["seizures"]), ["seizures"]);
  assert.deepEqual(evTerms("Tests did not rule out seizures after aciclovir.", ["seizures"]), ["seizures"]);   // pseudo-negation
});

test("therapy start and onset dates are picked when the article gives full dates", () => {
  const f = worker.applyDetection({ id: "8", title: "Case", abstract: "A 54-year-old man started aciclovir on 3 March 2021. On March 9, 2021 he developed seizures. Dates like 03/04/2021 are not guessed.", entities: { diseases: ["seizures"] }, pubTypes: ["Case Reports"] }, ["aciclovir"], null, []).caseFacts;
  assert.equal(f.startDate.value, "2021-03-03");
  assert.equal(f.onsetDate.value, "2021-03-09");
  const none = worker.applyDetection({ id: "8", title: "Case", abstract: "A man started aciclovir on 03/04/2021 and developed seizures.", entities: {}, pubTypes: [] }, ["aciclovir"], null, []).caseFacts;
  assert.equal(none.startDate, undefined);
  const bad = worker.applyDetection({ id: "8", title: "Case", abstract: "A man started aciclovir on 31 February 2021.", entities: {}, pubTypes: [] }, ["aciclovir"], null, []).caseFacts;
  assert.equal(bad.startDate, undefined);
});

// Minimal one-page PDF with the given lines of text (no external tools needed).
function tinyPdf(lines) {
  const stream = "BT /F1 12 Tf 14 TL 50 700 Td " + lines.map(l => "(" + l.replace(/[()\\]/g, "") + ") Tj T*").join(" ") + " ET";
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let out = "%PDF-1.4\n"; const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("") + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}
test("PDF full texts are read with pdf.js when it is installed, and the events come from that text", async (t) => {
  const { makePdfTextFn } = await import("../server/pdftext.mjs");
  const read = await makePdfTextFn();
  if (!read) return t.skip("pdfjs-dist is not installed (optional: deploy/enable-pdf-text.sh)");
  const text = await read(tinyPdf(["Case presentation", "A 54-year-old man was admitted with jaundice.", "Hepatic failure developed after aciclovir."]));
  assert.match(text, /Case presentation/); assert.match(text, /Hepatic failure developed after aciclovir\./);
  const r = worker.applyDetection({ id: "5", title: "Aciclovir", abstract: "", entities: { diseases: ["hepatic failure"] }, pubTypes: [] }, ["aciclovir"], null, [], text);
  assert.ok(r.events.some(e => /hepatic failure/i.test(e.term)));
});

import { existsSync } from "node:fs";
const IME_XLSX = process.env.IME_XLSX || "/root/.claude/uploads/c16e0d7d-3406-5934-b74c-eb48327a969d/1ea6802d-meddra-important-medical-event-terms-list-ime-version-291_en.xlsx";
test("the EMA IME workbook (.xlsx) is read: terms, SOC, version, reference, demoted terms", async (t) => {
  if (!existsSync(IME_XLSX)) return t.skip("IME workbook not available here (licensed content is not stored in the repository)");
  const parsed = worker.parseImeWorkbook(await worker.readXlsx((await readFile(IME_XLSX)).buffer));
  assert.equal(parsed.version, "29.1"); assert.equal(parsed.reference, "EMA/211097/2026");
  assert.ok(parsed.terms.length > 7000);
  assert.deepEqual(parsed.terms.find(x => x[1] === "Double aortic arch"), ["10093479", "Double aortic arch", "Congenital, familial and genetic disorders", 1]);
  assert.ok(parsed.demoted.some(d => d[1] === "Iridocyclitis" && d[3] === "Anterior uveitis"));
});

import { spawnSync } from "node:child_process";
async function seedWithEvents(t) {
  const bench = JSON.parse(await readFile(benchFile(t.dir), "utf8"));
  Object.assign(bench.articles["1"], { fullTextStatus: "Captured", fullTextKey: "k", journal: "J", ...worker.applyDetection({ ...bench.articles["1"], entities: { diseases: ["hepatic failure"] } }, ["aciclovir"], null, [], FULL_TEXT) });
  bench.profiles.push({ email: "ravi@example.org", name: "Ravi", role: "reviewer", active: true, capacity: 9 });
  await t.BUCKET.put("bench.json", JSON.stringify(bench));
}
test("Synchrony assigns cases automatically to the least-loaded reviewer and managers can reassign", async () => {
  const t = await setup(); await seedWithEvents(t);
  const first = (await t.call(MANAGER, "/api/case-create", { pmid: "1" })).body.case;
  assert.ok([REVIEWER, "ravi@example.org"].includes(first.assignee));
  assert.ok(first.dueAt, "a reporting due date is set"); assert.match(first.history.at(-1).action, /assigned to .* \(automatic\)/);
  const other = first.assignee === REVIEWER ? "ravi@example.org" : REVIEWER;
  assert.equal((await t.call(REVIEWER, "/api/case-assign", { ids: [first.id], assignee: other })).status, 403);
  assert.equal((await t.call(MANAGER, "/api/case-assign", { ids: [first.id], assignee: "nobody@example.org" })).status, 400);
  assert.equal((await t.call(MANAGER, "/api/case-assign", { ids: [first.id], assignee: other })).body.moved, 1);
  const state = await (await worker.fetch(new Request("http://localhost/api/state", { headers: { "oai-authenticated-user-email": other } }), t.env)).json();
  assert.ok(state.cases.some(c => c.id === first.id), "the new assignee can see the case");
  const bench = JSON.parse(await readFile(benchFile(t.dir), "utf8")); bench.cases[0].assignee = undefined; await t.BUCKET.put("bench.json", JSON.stringify(bench));
  assert.equal((await t.call(MANAGER, "/api/cases-autoassign")).body.moved, 1);
});

test("exports: narrative, CIOMS I PDF, FHIR bundle, line listing, E2B(R3) XML", async () => {
  const t = await setup(); await seedWithEvents(t);
  const made = (await t.call(MANAGER, "/api/case-create", { pmid: "1" })).body.case;
  const get = async format => { const r = await worker.fetch(new Request("http://localhost/api/case-export", { method: "POST", headers: { "oai-authenticated-user-email": MANAGER, "Content-Type": "application/json" }, body: JSON.stringify({ id: made.id, format }) }), t.env); assert.equal(r.status, 200, format); return r; };
  assert.equal(new TextDecoder().decode((await (await get("cioms")).arrayBuffer()).slice(0, 5)), "%PDF-");
  const fhir = await (await get("fhir")).json(); assert.equal(fhir.resourceType, "Bundle"); assert.ok(fhir.entry.some(e => e.resource.resourceType === "AdverseEvent"));
  const csv = await (await get("csv")).text(); assert.match(csv, /^"Case","PMID"/); assert.match(csv, /LS-/);
  const xml = await (await get("e2b")).text(); assert.match(xml, /<MCCI_IN200100UV01/); assert.match(xml, /<PORR_IN049016UV>/); assert.match(xml, /literatureReference/);
  const batch = await worker.fetch(new Request("http://localhost/api/cases-export", { method: "POST", headers: { "oai-authenticated-user-email": MANAGER, "Content-Type": "application/json" }, body: JSON.stringify({ format: "e2b" }) }), t.env);
  assert.equal(batch.status, 200);
  assert.match(worker.caseNarrativeText(worker.normalizeCase(made.data), "ref"), /^This case was reported in the published literature \(ref\)\./);
});

const ICH_DIR = process.env.ICH_SCHEMA_DIR || "/home/user/oss-clones/icsrmaker/schemas/multicacheschemas";
test("E2B(R3) XML validates against the ICH ICSR schema when it is available", async (t) => {
  if (!existsSync(ICH_DIR + "/MCCI_IN200100UV01.xsd") || spawnSync("xmllint", ["--version"]).error) return t.skip("ICH schema files or xmllint not available");
  const tmp = await mkdtemp(join(tmpdir(), "e2b-"));
  const rec = { id: "x", number: "LS-2026-0001", pmid: "1", createdAt: "2026-11-25T00:00:00Z", data: worker.normalizeCase({ receipt_date: "2026-11-25", patient: { identifier: { value: "54-year-old male" }, age: { value: "54" }, sex: { value: "Male" }, weight: { value: "70" }, medical_history: [{ value: "CKD" }] },
    products: [{ role: "suspect", name: { value: "aciclovir" }, start_date: { value: "2021-03-03" }, action_taken: { value: "Drug withdrawn" } }, { role: "concomitant", name: { value: "metformin" } }],
    events: [{ verbatim: { value: "confusion" }, pt: { value: "Confusional state" }, pt_code: { value: "10010305" }, onset_date: { value: "2021-03-09" }, outcome: { value: "Recovered/resolved" }, seriousness: { serious: true, hospitalization: true } }], source_summary: "A B. Case. J. 2021." }) };
  await writeFile(tmp + "/case.xml", worker.e2bBatch([rec], {}));
  const r = spawnSync("xmllint", ["--noout", "--schema", ICH_DIR + "/MCCI_IN200100UV01.xsd", tmp + "/case.xml"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("case series summary counts from the case fields and flags months above the median + MAD limit", () => {
  assert.deepEqual(worker.robustHikes([10, 12, 11, 13, 50].map((count, i) => ({ month: "m" + i, count }))).hikes.map(h => h.count), [50]);   // the case that breaks mean +/- 2 SD
  assert.deepEqual(worker.robustHikes([3, 3, 3, 3, 4].map((count, i) => ({ month: "m" + i, count }))).hikes, []);                              // flat series: one more case is not a hike
  const mk = (n, pt, country, date, serious) => ({ number: n, status: "Draft", createdAt: date, data: worker.normalizeCase({ receipt_date: date, patient: { country: { value: country }, age: { value: "70" }, sex: { value: "Female" } }, products: [{ role: "suspect", name: { value: "aciclovir" } }], events: [{ verbatim: { value: pt }, seriousness: { serious, hospitalization: serious } }] }) });
  const s = worker.seriesSummary([mk("A", "Confusion", "India", "2026-01-05", true), mk("B", "Confusion", "India", "2026-02-05", false), mk("C", "Rash", "Spain", "2026-02-09", false)]);
  assert.equal(s.total, 3); assert.deepEqual(s.serious, ["A"]);
  assert.deepEqual(s.events[0], { key: "Confusion", count: 2, cases: ["A", "B"] });
  assert.equal(s.countries[0].key, "India"); assert.equal(s.ages[0].key, "65 and over");
});
