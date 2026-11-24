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
  const asReviewer = (await t.call(REVIEWER, "/api/sign-preview", { kind: "case", id: created.id, meaning: "case_invalid" })).status;
  assert.equal(asReviewer, 404, "reviewers cannot see another person's case");
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
