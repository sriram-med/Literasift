// Reliable unattended batches: window ledger, heartbeat, missed windows, concurrency, scheduled run without a UI, and compatibility with the earlier deployed build. Synthetic fixtures only.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { MANAGER, SCREENER, fakeNcbi, withFetch, makeEnv, readZip } from "./helpers.mjs";
import worker from "../worker/index.js";

const WATCH = { portfolio: "Antivirals", molecule: "aciclovir", query: '"aciclovir"[tiab]' };
const dAgo = n => new Date(Date.now() + 5.5 * 3600000 - n * 86400000).toISOString().slice(0, 10);
const status = t => t.call(MANAGER, "/api/scheduler-status", {}).then(r => r.body);

test("a failed day stays visible after a later successful monitor window and a later backfill, and only a real retry clears it", async () => {
  const t = await makeEnv({ watches: [WATCH] }), D4 = dAgo(4), D3 = dAgo(3), recs = [{ pmid: "11", date: D4 }, { pmid: "12", date: D3 }];
  const down = fakeNcbi(recs, { failWindows: { [D4.replaceAll("-", "-")]: 99 } }), up = fakeNcbi(recs);
  await withFetch(down.handler, async () => {
    const bad = await worker.execute(t.env, WATCH, D4, D4, { mode: "monitor" }); assert.equal(bad.coverage, "failed");
    const later = await worker.execute(t.env, WATCH, D3, D3, { mode: "monitor" }); assert.equal(later.coverage, "reconciled", "a later day succeeds");
    await worker.execute(t.env, WATCH, dAgo(10), dAgo(1), { mode: "backfill" });   // a backfill on Publication Date covers every day but must not count as monitoring coverage
  });
  let s = await status(t); const failed = s.missed.find(m => m.state === "failed");
  assert.ok(failed, JSON.stringify(s.missed)); assert.deepEqual([failed.from, failed.to], [D4, D4]); assert.ok(failed.attempts >= 1); assert.match(failed.error, /HTTP 500/);
  assert.ok(!s.missed.some(m => m.from <= D3 && m.to >= D3), "the day that succeeded is not listed");
  assert.deepEqual(s.missed.filter(m => m.state === "missing").map(m => [m.from, m.to]), [[dAgo(2), dAgo(1)]], "days never attempted are listed too");
  // the scheduler fills the never-attempted days but must not pretend the failed day is done
  await withFetch(down.handler, () => t.call(MANAGER, "/api/scheduled", {}));
  s = await status(t); assert.deepEqual(s.missed.map(m => m.state), ["failed"]); assert.equal(s.missed[0].from, D4);
  // retry with the source back up
  const r = await withFetch(up.handler, () => t.call(MANAGER, "/api/missed-retry", { portfolio: "Antivirals", molecule: "aciclovir", from: D4, to: D4 })); assert.equal(r.status, 200, JSON.stringify(r.body));
  s = await status(t); assert.deepEqual(s.missed, []); const st = await t.state(); assert.ok(st.articles["11"] && st.assignments.filter(a => a.pmid === "11").length === 1);
});

test("windows are retried a bounded number of times with a pause, then stay visible as exhausted until a manager retries", async () => {
  const t = await makeEnv({ watches: [WATCH] }), D2 = dAgo(2), down = fakeNcbi([{ pmid: "21", date: D2 }], { failWindows: { [D2]: 999 } });
  await withFetch(down.handler, async () => { await worker.execute(t.env, WATCH, D2, D2, { mode: "monitor" }); });
  let run = (await t.state()).runs[0], w = run.windows[0]; assert.equal(w.state, "failed"); assert.ok(w.attempts >= 1 && w.attempts <= 2, "at most two tries per call, with the source's own retries inside each");
  const before = w.attempts; await withFetch(down.handler, () => t.call(MANAGER, "/api/scheduled", {}));
  assert.equal((await t.state()).runs.find(r => r.from === D2).windows[0].attempts, before, "the scheduler respects the pause after a failure");
  const s = await t.state(); s.runs.find(r => r.from === D2).windows[0].attempts = 8; await t.BUCKET.put("bench.json", JSON.stringify(s));
  const st = await status(t); assert.equal(st.missed.find(m => m.from === D2).exhausted, true);
});

test("every scheduler tick leaves a heartbeat; a silent scheduler is reported as stale and the last good batch is shown", async () => {
  const t = await makeEnv({ watches: [WATCH] }), D1 = dAgo(1), ncbi = fakeNcbi([{ pmid: "31", date: D1 }, { pmid: "32", date: D1 }]);
  let s = await status(t); assert.equal(s.stale, true); assert.equal(s.heartbeat.lastBeatAt, null);
  const tick = await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/scheduled", {})); assert.equal(tick.status, 200);
  s = await status(t); assert.equal(s.stale, false); assert.equal(s.heartbeat.running, false); assert.ok(s.heartbeat.lastSuccessAt); assert.equal(s.heartbeat.recent[0].batches, 1);
  assert.deepEqual([s.lastBatch.from, s.lastBatch.to, s.lastBatch.coverage, s.lastBatch.retrieved], [D1, D1, "reconciled", 2]); assert.deepEqual(s.missed, []);
  const old = await t.state(); old.scheduler.lastBeatAt = new Date(Date.now() - 5 * 3600000).toISOString(); await t.BUCKET.put("bench.json", JSON.stringify(old));
  s = await status(t); assert.equal(s.stale, true); assert.ok(s.heartbeat.ageMinutes >= 290);
  const ro = await t.call(SCREENER, "/api/scheduler-status", {}); assert.equal(ro.status, 200); assert.equal(ro.body.readOnly, true, "a screener sees the automatic pull read-only"); assert.equal(ro.body.missed, undefined);
  assert.equal((await t.call(SCREENER, "/api/missed-retry", {})).status, 403, "and cannot retry or change it");
});

test("overlapping runs share one run per window, and give one assignment per portfolio and PMID", async () => {
  const D = dAgo(1), recs = [{ pmid: "41", date: D }, { pmid: "42", date: D }, { pmid: "43", date: D }], ncbi = fakeNcbi(recs);
  const t = await makeEnv({ watches: [WATCH, { portfolio: "Antivirals", molecule: "acyclovir", query: '"acyclovir"[tiab]' }, { portfolio: "Generics", molecule: "aciclovir", query: '"aciclovir"[tiab]' }] });
  await withFetch(ncbi.handler, async () => { await Promise.all([worker.execute(t.env, WATCH, D, D), worker.execute(t.env, WATCH, D, D), worker.execute(t.env, WATCH, D, D),
    worker.execute(t.env, { portfolio: "Antivirals", molecule: "acyclovir", query: '"acyclovir"[tiab]' }, D, D), worker.execute(t.env, { portfolio: "Generics", molecule: "aciclovir", query: '"aciclovir"[tiab]' }, D, D)]); });
  const s = await t.state(), key = a => a.portfolio + "|" + a.pmid;
  assert.equal(s.runs.filter(r => r.portfolio === "Antivirals" && r.molecule === "aciclovir").length, 1, "identical runs are one run");
  assert.equal(new Set(s.assignments.map(key)).size, s.assignments.length, "no duplicate assignment"); assert.equal(s.assignments.length, 6, "3 PMIDs x 2 portfolios");
  assert.deepEqual(s.assignments.find(a => a.pmid === "41" && a.portfolio === "Antivirals").molecules.sort(), ["aciclovir", "acyclovir"]);
  assert.equal(Object.keys(s.articles).length, 3);
  // two scheduler ticks at once
  await withFetch(ncbi.handler, () => Promise.all([t.call(MANAGER, "/api/scheduled", {}), t.call(MANAGER, "/api/scheduled", {})]));
  const s2 = await t.state(); assert.equal(new Set(s2.assignments.map(key)).size, s2.assignments.length);
});

test("a scheduled run works with no user signed in: the bundled runner script calls the Site with the run token only", async () => {
  const D = dAgo(1), ncbi = fakeNcbi([{ pmid: "51", date: D }, { pmid: "52", date: D }]), t = await makeEnv({ watches: [WATCH] });
  const seen = [];
  const server = createServer(async (req, res) => { const body = await new Promise(r => { let b = ""; req.on("data", c => b += c); req.on("end", () => r(b)); });
    seen.push({ path: req.url, auth: req.headers.authorization, user: req.headers["oai-authenticated-user-email"] || null, sites: req.headers["oai-sites-authorization"] });
    const out = await withFetch(ncbi.handler, () => worker.fetch(new Request("http://localhost" + req.url, { method: req.method, headers: { authorization: req.headers.authorization || "", "content-type": "application/json" }, body: req.method === "GET" ? undefined : body }), t.env));
    res.writeHead(out.status, { "content-type": "application/json" }); res.end(await out.text()); });
  await new Promise(r => server.listen(0, "127.0.0.1", r)); const port = server.address().port;
  const child = spawn(process.execPath, ["scripts/run-watchlists.mjs"], { env: { PATH: process.env.PATH, BENCH_URL: "http://127.0.0.1:" + port, BENCH_ALLOW_LOOPBACK: "1", SITES_ACCESS_TOKEN: "x".repeat(24), RUN_TOKEN: t.env.RUN_TOKEN } });
  let out = ""; child.stdout.on("data", d => out += d); const code = await new Promise(r => child.on("exit", r)); server.close();
  assert.equal(code, 0, out); const line = JSON.parse(out.trim().split("\n").pop()); assert.equal(line.completedBatches, 1); assert.equal(line.failedBatches, 0);
  assert.deepEqual([...new Set(seen.map(x => x.user))], [null], "no signed-in user took part"); assert.equal(seen[0].auth, "Bearer " + t.env.RUN_TOKEN);
  const s = await t.state(); assert.equal(s.assignments.length, 2); assert.ok(s.scheduler.lastSuccessAt); assert.equal(s.runs[0].coverage, "reconciled");
});

test("records from the earlier deployed build keep working: legacy citation XML counts as evidence, is adopted with a hash, downloads, and is packaged", async () => {
  const t = await makeEnv({ watches: [WATCH], articles: { 61: { id: "61", title: "Old record", authors: [], url: "https://pubmed.ncbi.nlm.nih.gov/61/", citationXmlKey: "evidence/61/pubmed.xml", citationXmlStatus: "Captured", pullAt: "2026-01-01" } },
    assignments: [{ id: "a1", pmid: "61", portfolio: "Antivirals", molecules: ["aciclovir"], reviewer: SCREENER, status: "Pending" }], runs: [{ id: "r1", portfolio: "Antivirals", molecule: "aciclovir", from: "2026-01-01", to: "2026-01-01", status: "Imported", ids: ["61"], count: 1, time: "2026-01-02" }] });
  await t.BUCKET.put("evidence/61/pubmed.xml", "<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>61</PMID></MedlineCitation></PubmedArticle></PubmedArticleSet>");
  const dl = await t.get(SCREENER, "/api/citation-xml/61"); assert.equal(dl.status, 200); assert.match(await dl.text(), /<PMID>61<\/PMID>/);
  const ready = (await t.call(MANAGER, "/api/batch-readiness", {})).body.batches[0]; assert.equal(ready.counts.citation.available, 1);
  await withFetch(fakeNcbi([]).handler, () => t.call(MANAGER, "/api/scheduled", {}));
  const adopted = (await t.state()).articles["61"].evidence.efetch; assert.match(adopted.sha256, /^[0-9a-f]{64}$/); assert.equal(adopted.key, "evidence/61/pubmed.xml");
  const zip = await t.raw(MANAGER, "/api/batch-zip", { runId: "r1" }); const files = readZip(await zip.arrayBuffer()); assert.ok([...files.keys()].some(n => /61\/efetch\.xml$/.test(n)));
});

test("the screenshot service is called with a bearer token for the bundled Playwright service, and with a query token for Browserless", async () => {
  const calls = [], handler = async (url, init = {}) => { const u = new URL(String(url)); if (u.host === "capture.example.org") { calls.push({ url: String(url), auth: init.headers?.Authorization || null }); return new Response("no", { status: 502 }); } return new Response("", { status: 404 }); };
  for (const [mode, expectAuth, expectQuery] of [["bearer", "Bearer " + "t".repeat(30), false], [undefined, null, true]]) {
    calls.length = 0; const t = await makeEnv({ watches: [], articles: { 71: { id: "71", title: "x", authors: [], url: "https://pubmed.ncbi.nlm.nih.gov/71/", pullAt: "2026-01-01", fullTextStatus: "Not covered by PMC" } } }, { SCREENSHOT_ENDPOINT: "https://capture.example.org/screenshot", SCREENSHOT_TOKEN: "t".repeat(30), SCREENSHOT_AUTH: mode });
    await withFetch(handler, () => t.call(MANAGER, "/api/scheduled", {})); const c = calls[0]; assert.ok(c, "the capture service was called");
    assert.equal(c.auth, expectAuth); assert.equal(c.url.includes("token="), expectQuery);
    assert.equal((await t.state()).articles["71"].screenshotStatus, "Retry needed", "a failed capture is recorded, not hidden");
  }
});

const TWO = ["Case presentation", "Patient 1 was a 54-year-old man with chronic kidney disease who received aciclovir 800 mg orally for herpes zoster. On day 3 he developed confusion and myoclonus. Aciclovir was stopped and he recovered by day 6.", "Patient 2 was a 31-year-old woman who received aciclovir intravenously for herpes simplex encephalitis. She developed a rash on day 2 and acute kidney injury on day 4."];
async function twoPatient(extra = {}) {
  const t = await makeEnv({ profiles: [{ email: MANAGER, name: "Boss", role: "manager", active: true }, { email: SCREENER, name: "Asha", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }],
    watches: [WATCH], articles: { 1: { id: "1", title: "Aciclovir neurotoxicity in two patients: a case series", abstract: "Two cases.", authors: ["Rao A", "Iyer S"], journal: "J Test", date: "2021", pubTypes: ["Case Reports"], evidence: { parsed: { key: "evidence/1/parsed.json" }, fulltext: { sha256: "f".repeat(64) } }, ...extra.a1 },
      2: { id: "2", title: "Aciclovir neurotoxicity in two patients", abstract: "Conference abstract.", authors: ["Rao A"], journal: "Annual Meeting Abstracts", date: "2021", pubTypes: ["Congress"] }, 3: { id: "3", title: "Statin myopathy", authors: ["Khan Z"], date: "2020" } },
    assignments: [{ id: "a1", pmid: "1", portfolio: "Antivirals", molecules: ["aciclovir"], reviewer: SCREENER, status: "Complete", disposition: { value: "potential_icsr", by: SCREENER }, ...extra.item }, { id: "a2", pmid: "2", portfolio: "Antivirals", molecules: ["aciclovir"], reviewer: SCREENER, status: "Pending" }] });
  await t.BUCKET.put("evidence/1/parsed.json", JSON.stringify({ sections: [{ path: "Case presentation", title: "Case presentation", paragraphs: TWO.slice(1) }], tables: [], figures: [], authors: [{ name: "Anil Rao", affiliations: ["Dept of Nephrology, Test Hospital, Pune, India"], email: "anil.rao@test-hospital.example", corresponding: true }], correspondenceEmails: ["anil.rao@test-hospital.example"], correspondence: ["Anil Rao"] }));
  return t;
}

test("a two-patient article gives two independently reviewable candidates even when the request is repeated at the same moment, and decisions record the evidence version", async () => {
  const t = await twoPatient();
  const made = await Promise.all([t.call(SCREENER, "/api/drafts-create", { id: "a1" }), t.call(SCREENER, "/api/drafts-create", { id: "a1" }), t.call(SCREENER, "/api/drafts-create", { id: "a1" })]);
  assert.ok(made.every(r => r.status === 200), JSON.stringify(made.map(r => r.body)));
  const cases = (await t.state()).cases; assert.equal(cases.length, 2, "one candidate per patient, however many overlapping requests"); assert.equal(new Set(cases.map(c => c.number)).size, 2); assert.deepEqual(cases.map(c => c.provenance.patientId).sort(), ["P1", "P2"]);
  const terms = id => cases.find(c => c.provenance.patientId === id).data.events.map(e => e.verbatim.value).sort();
  assert.deepEqual(terms("P1"), ["confusion", "myoclonus"]); assert.deepEqual(terms("P2"), ["acute kidney injury", "rash"]);
  assert.equal(cases[0].provenance.evidence.fulltext, "f".repeat(64), "the case records the evidence version it was made from");
  const ex = (await t.call(SCREENER, "/api/extract", { id: "a1" })).body, ev = ex.extraction.patients[0].events.find(e => e.category === "ae");
  assert.equal((await t.call(SCREENER, "/api/extraction-decide", { id: "a1", eventId: ev.id, action: "exclude", reason: "Not an event for this product" })).status, 200); const dec = Object.values((await t.state()).assignments[0].extractionDecisions)[0]; assert.equal(dec.evidence.fulltext, "f".repeat(64));
});

test("the extraction flags a possible duplicate publication of the same report without merging anything", async () => {
  const t = await twoPatient(), ex = (await t.call(SCREENER, "/api/extract", { id: "a1" })).body, d = ex.possibleDuplicatePublications;
  assert.deepEqual(d.map(x => x.pmid), ["2"]); assert.ok(d[0].similarity >= 60); assert.ok(d[0].reasons.some(r => /conference abstract/.test(r)) && d[0].reasons.some(r => /Same first author/.test(r)));
  assert.equal((await t.state()).assignments.length, 2, "nothing is merged or removed");
});

test("overlapping batch ZIP requests produce one export version, and a changed manifest produces the next", async () => {
  const t = await makeEnv({ watches: [WATCH], articles: { 81: { id: "81", title: "A", authors: [], url: "https://pubmed.ncbi.nlm.nih.gov/81/", pullAt: "2026-01-01" } }, assignments: [{ id: "a1", pmid: "81", portfolio: "Antivirals", molecules: ["aciclovir"], reviewer: SCREENER, status: "Pending" }], runs: [{ id: "r1", portfolio: "Antivirals", molecule: "aciclovir", from: "2026-01-01", to: "2026-01-01", status: "Imported", ids: ["81"], count: 1, time: "2026-01-02" }] });
  const rs = await Promise.all([1, 2, 3].map(() => t.raw(MANAGER, "/api/batch-zip", { runId: "r1" }))); assert.deepEqual(rs.map(r => r.headers.get("X-Export-Version")), ["1", "1", "1"]);
  assert.equal(((await t.state()).exports || []).length, 1);
  const s = await t.state(); s.articles["81"].fullTextKey = "evidence/81/pmc.xml"; s.articles["81"].fullTextStatus = "Captured"; await t.BUCKET.put("bench.json", JSON.stringify(s)); await t.BUCKET.put("evidence/81/pmc.xml", "<article/>");
  assert.equal((await t.raw(MANAGER, "/api/batch-zip", { runId: "r1" })).headers.get("X-Export-Version"), "2");
});

test("many writers racing on the state all land: no write is lost and none gives up", async () => {
  const t = await makeEnv({ profiles: [{ email: MANAGER, name: "Boss", role: "manager", active: true }, { email: SCREENER, name: "Asha", role: "reviewer", active: true, capacity: 99 }] });
  // 30 simultaneous profile saves go through the normal route; every one must succeed and every profile must exist afterwards
  const names = Array.from({ length: 30 }, (_, i) => "p" + i + "@example.org");
  const out = await Promise.all(names.map(e => t.call(MANAGER, "/api/profile", { name: "P " + e, email: e, role: "reviewer", capacity: 10 })));
  assert.deepEqual([...new Set(out.map(r => r.status))], [200], JSON.stringify(out.filter(r => r.status !== 200).slice(0, 2).map(r => r.body)));
  const s = await t.state(); for (const e of names) assert.ok(s.profiles.some(p => p.email === e), e + " was saved");
});
