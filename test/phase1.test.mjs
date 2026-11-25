// Phase 1: reliable unattended article dumps. Fixtures are synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, SCREENER, fakeNcbi, withFetch, makeEnv } from "./helpers.mjs";
import worker from "../worker/index.js";

const WATCH = { portfolio: "Antivirals", molecule: "aciclovir", query: '"aciclovir"[tiab]' };
const recs = (dates) => dates.map((date, i) => ({ pmid: String(1000 + i), date }));

test("an import is cut into bounded windows, each reconciled, and counts are reported per window", async () => {
  const t = await makeEnv({ watches: [WATCH] }), ncbi = fakeNcbi(recs(["2026-10-02", "2026-10-03", "2026-10-20"]));
  const run = await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/import", { watch: "Antivirals|aciclovir", from: "2026-10-01", to: "2026-10-28" }));
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const r = run.body;
  assert.equal(r.windows.length, 2, "28 days in 14-day backfill windows");
  assert.deepEqual(r.windows.map(w => [w.expected, w.retrieved, w.state]), [[2, 2, "reconciled"], [1, 1, "reconciled"]]);
  assert.equal(r.coverage, "reconciled"); assert.equal(r.expected, 3); assert.equal(r.retrieved, 3); assert.equal(r.dateField, "pdat"); assert.equal(r.dateFieldLabel, "Publication Date");
  assert.match(r.windows[0].term, /\[dp\]/); assert.ok(r.searchedAt); assert.deepEqual(r.gaps, []);
  const s = await t.state(); assert.equal(Object.keys(s.articles).length, 3); assert.equal(s.assignments.length, 3);
  assert.ok(s.articles["1000"].evidence.efetch.sha256.length === 64, "original EFetch XML is kept with its hash");
  assert.match(await (await t.BUCKET.get("evidence/1000/efetch.xml")).text(), /<PubmedArticle>/);
});

test("scheduled monitoring uses Create Date, a backfill uses Publication Date, and the executed query and version are recorded", async () => {
  const t = await makeEnv({ watches: [WATCH] }), ncbi = fakeNcbi(recs(["2026-11-10"]));
  const today = new Date().toISOString().slice(0, 10), yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const monitor = await withFetch(ncbi.handler, () => worker.execute({ ...t.env, RETRY_BASE_MS: 1 }, { ...WATCH, versions: [{ version: 1, query: WATCH.query, effectiveFrom: "0000-00-00" }] }, yesterday, yesterday, { mode: "monitor" }));
  assert.equal(monitor.dateField, "crdt"); assert.match(monitor.executedQueries[0], /\[crdt\]/); assert.equal(monitor.mode, "monitor"); assert.deepEqual(monitor.queryVersions, [1]);
  void today;
});

test("zero results, partially imported, failed, and reconciled are different states and unresolved gaps stay visible", async () => {
  const t = await makeEnv({ watches: [WATCH] });
  // zero results
  let ncbi = fakeNcbi([]);
  let r = (await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/import", { watch: "Antivirals|aciclovir", from: "2026-01-01", to: "2026-01-10" }))).body;
  assert.equal(r.coverage, "zero_results"); assert.equal(r.windows[0].state, "zero_results"); assert.equal(r.count, 0);
  // partial: PubMed says 3 but one citation is missing from the summary response
  ncbi = fakeNcbi(recs(["2026-02-02", "2026-02-03", "2026-02-04"]), { dropSummary: ["1001"] });
  r = (await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/import", { watch: "Antivirals|aciclovir", from: "2026-02-01", to: "2026-02-10" }))).body;
  assert.equal(r.coverage, "partial"); assert.equal(r.windows[0].state, "partial"); assert.deepEqual(r.windows[0].missing, ["1001"]); assert.equal(r.gaps.length, 1); assert.equal(r.gaps[0].expected, 3);
  // failed: every attempt errors
  ncbi = fakeNcbi(recs(["2026-03-02"]), { failWindows: { "2026-03-01": 99 } });
  r = (await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/import", { watch: "Antivirals|aciclovir", from: "2026-03-01", to: "2026-03-10" }))).body;
  assert.equal(r.coverage, "failed"); assert.equal(r.status, "Failed"); assert.equal(r.gaps[0].state, "failed"); assert.match(r.gaps[0].error, /HTTP 500/);
  // all of them are listed with distinct coverage
  const s = await t.state(); assert.deepEqual(s.runs.map(x => x.coverage).sort(), ["failed", "partial", "zero_results"]);
});

test("a failed import resumes from its checkpoint without losing counts, and a replay never duplicates assignments or touches decisions", async () => {
  const t = await makeEnv({ watches: [WATCH] }), records = recs(["2026-04-02", "2026-04-05", "2026-04-20", "2026-04-25"]);
  // the second window fails every time at first
  let ncbi = fakeNcbi(records, { failWindows: { "2026-04-15": 99 } });
  let r = (await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/import", { watch: "Antivirals|aciclovir", from: "2026-04-01", to: "2026-04-28" }))).body;
  assert.equal(r.coverage, "partial"); assert.equal(r.windows[0].state, "reconciled"); assert.equal(r.windows[1].state, "failed"); assert.equal(r.count, 2, "the finished window's articles are already imported");
  // a reviewer completes a screening decision in the meantime
  let s = await t.state(); const item = s.assignments.find(a => a.pmid === "1000"); item.status = "Complete"; item.note = "Excluded: not a case"; item.reviewer = SCREENER;
  await t.BUCKET.put("bench.json", JSON.stringify(s));
  // resume after the outage
  ncbi = fakeNcbi(records);
  const resumed = (await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/import-resume", { runId: r.id, retryFailed: true }))).body;
  assert.equal(resumed.coverage, "reconciled"); assert.equal(resumed.count, 4); assert.equal(resumed.expected, 4); assert.equal(resumed.retrieved, 4);
  assert.ok(!ncbi.calls.some(c => c.includes("2026/04/01")), "the finished window was not searched again");
  // an identical import is a replay: no new run, no duplicate assignment, decision intact
  const replay = (await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/import", { watch: "Antivirals|aciclovir", from: "2026-04-01", to: "2026-04-28" }))).body;
  assert.equal(replay.replayed, true);
  const forced = await withFetch(ncbi.handler, () => worker.execute(t.env, WATCH, "2026-04-01", "2026-04-28", { mode: "backfill", force: true }));
  assert.equal(forced.coverage, "reconciled");
  s = await t.state();
  assert.equal(s.assignments.length, 4, "no duplicate assignments after a forced replay"); assert.equal(s.assignments.filter(a => a.pmid === "1000").length, 1);
  const kept = s.assignments.find(a => a.pmid === "1000"); assert.equal(kept.status, "Complete"); assert.equal(kept.note, "Excluded: not a case"); assert.equal(kept.reviewer, SCREENER);
});

test("transient provider errors (HTTP 429/500) are retried with backoff inside a window", async () => {
  const t = await makeEnv({ watches: [WATCH] }), ncbi = fakeNcbi(recs(["2026-05-02"]), { failWindows: { "2026-05-01": 2 }, failStatus: 429 });
  const r = (await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/import", { watch: "Antivirals|aciclovir", from: "2026-05-01", to: "2026-05-10" }))).body;
  assert.equal(r.coverage, "reconciled"); assert.equal(r.windows[0].attempts, 1); assert.equal(ncbi.calls.filter(c => c.startsWith("esearch")).length, 3, "two failed calls and one success");
});

test("a window that returns fewer ids than PubMed counts is split until every part fits", async () => {
  const t = await makeEnv({ watches: [WATCH] }), records = recs(["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"]), ncbi = fakeNcbi(records, { cap: 2 });
  const r = (await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/import", { watch: "Antivirals|aciclovir", from: "2026-06-01", to: "2026-06-05" }))).body;
  assert.equal(r.coverage, "reconciled"); assert.equal(r.count, 5); assert.ok(r.windows.length > 1); assert.equal(r.windows.reduce((n, w) => n + w.retrieved, 0), 5);
});
