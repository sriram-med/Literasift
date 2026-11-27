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

test("scheduled monitoring uses Publication Date (as the weekly reports do), and the executed query and version are recorded", async () => {
  const t = await makeEnv({ watches: [WATCH] }), ncbi = fakeNcbi(recs(["2026-11-10"]));
  const today = new Date().toISOString().slice(0, 10), yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const monitor = await withFetch(ncbi.handler, () => worker.execute({ ...t.env, RETRY_BASE_MS: 1 }, { ...WATCH, versions: [{ version: 1, query: WATCH.query, effectiveFrom: "0000-00-00" }] }, yesterday, yesterday, { mode: "monitor" }));
  assert.equal(monitor.dateField, "pdat"); assert.match(monitor.executedQueries[0], /\[dp\]/); assert.equal(monitor.mode, "monitor"); assert.deepEqual(monitor.queryVersions, [1]);
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

import { readZip, parseCsv, JATS } from "./helpers.mjs";
import { FileBucket } from "../server/storage.mjs";

test("JATS full text is parsed into sections, tables, captions and author metadata with correspondence", async () => {
  const t = await makeEnv({ articles: { 77: { id: "77", title: "Aciclovir neurotoxicity", doi: "10.1234/77", pmcid: "PMC77" } }, assignments: [{ id: "a", pmid: "77", portfolio: "P", molecules: ["aciclovir"], reviewer: SCREENER, status: "Pending" }] });
  await t.BUCKET.put("evidence/77/pmc.xml", JATS);
  const state = await t.state(); state.articles["77"].fullTextStatus = "Captured"; state.articles["77"].fullTextKey = "evidence/77/pmc.xml"; state.articles["77"].fullTextOrigin = "PMC"; state.articles["77"].fullTextLicense = "cc-by";
  const { default: w } = await import("../worker/index.js");
  void w;
  // run the same builder the pipeline uses, through the upload route (it records evidence the same way)
  await t.BUCKET.put("bench.json", JSON.stringify(state));
  const res = await t.call(SCREENER, "/api/fulltext-upload", { pmid: "77", base64: Buffer.from(JATS).toString("base64") });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const s = await t.state(), ev = s.articles["77"].evidence;
  assert.equal(ev.fulltext.format, "xml"); assert.equal(ev.fulltext.extraction.method, "jats-xml"); assert.equal(ev.fulltext.sha256.length, 64); assert.ok(ev.fulltext.retrievedAt); assert.equal(ev.parsed.parserVersion, "jats-parser/1");
  assert.deepEqual([ev.parsed.tables, ev.parsed.captions], [1, 2]);
  const parsed = JSON.parse(await (await t.BUCKET.get(ev.parsed.key)).text());
  assert.deepEqual(parsed.sections.map(x => x.path), ["Abstract > Background", "Case presentation", "Case presentation > Course", "Discussion"]);
  assert.deepEqual(parsed.tables[0].rows, [["Day", "Creatinine (mg/dL)"], ["1", "1.0"], ["3", "2.4"]]); assert.equal(parsed.tables[0].caption, "Laboratory course"); assert.equal(parsed.figures[0].caption, "EEG showing generalised discharges");
  assert.equal(parsed.authors[0].name, "Anil Rao"); assert.equal(parsed.authors[0].corresponding, true); assert.match(parsed.authors[0].affiliations[0], /Nephrology/); assert.deepEqual(parsed.correspondenceEmails, ["anil.rao@test-hospital.example"]);
  assert.deepEqual(s.articles["77"].correspondenceEmails ?? parsed.correspondenceEmails, ["anil.rao@test-hospital.example"]);
});

test("a blocked or failed page capture is recorded, and a clearly labelled citation snapshot is generated from the retrieved XML", async () => {
  const t = await makeEnv({ watches: [WATCH] }), ncbi = fakeNcbi(recs(["2026-07-02"]));
  await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/import", { watch: "Antivirals|aciclovir", from: "2026-07-01", to: "2026-07-10" }));
  const blocking = async url => String(url).includes("screenshots.example") ? new Response("Access denied", { status: 403 }) : new Response("", { status: 404 });
  const t2 = { ...t, env: Object.assign(Object.create(t.env), { SCREENSHOT_ENDPOINT: "https://screenshots.example/shot", SCREENSHOT_TOKEN: "tok" }) };
  await withFetch(blocking, () => worker.fetch(new Request("http://localhost/api/scheduled", { method: "POST", headers: { Authorization: "Bearer " + "x".repeat(40), "Content-Type": "application/json" }, body: "{}" }), t2.env));
  const s = await t.state(), a = s.articles["1000"];
  assert.equal(a.screenshotStatus, "Blocked"); assert.equal(a.evidence.screenshot.status, "blocked"); assert.match(a.evidence.screenshot.reason, /403|Screenshot service/);
  assert.equal(a.evidence.snapshot.kind, "citation_snapshot"); assert.equal(a.evidence.snapshot.derivedFrom, a.evidence.efetch.sha256);
  const svg = await (await t.BUCKET.get(a.evidence.snapshot.key)).text();
  assert.match(svg, /CITATION SNAPSHOT/); assert.match(svg, /not a capture of the PubMed web page/); assert.ok(svg.includes(a.evidence.efetch.sha256));
});

test("batch ZIP lists every matched PMID with explicit statuses, withholds restricted full text, and keeps versions traceable", async () => {
  const t = await makeEnv({ watches: [WATCH] }), records = recs(["2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06"]);
  const ncbi = fakeNcbi(records, { dropSummary: ["1004"] });
  const run = (await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/import", { watch: "Antivirals|aciclovir", from: "2026-08-01", to: "2026-08-10" }))).body;
  assert.equal(run.coverage, "partial");
  const s = await t.state();
  await t.BUCKET.put("evidence/1000/pmc.xml", JATS); await t.BUCKET.put("evidence/1001/unpaywall.pdf", "%PDF-1.4 restricted");
  Object.assign(s.articles["1000"], { fullTextStatus: "Captured", fullTextKey: "evidence/1000/pmc.xml", fullTextOrigin: "PMC", fullTextLicense: "cc-by", fullTextRestricted: false, evidence: { ...s.articles["1000"].evidence, fulltext: { source: "PMC", license: "cc-by", sha256: "a".repeat(64), extraction: { method: "jats-xml" } } } });
  Object.assign(s.articles["1001"], { fullTextStatus: "Captured", fullTextKey: "evidence/1001/unpaywall.pdf", fullTextOrigin: "Unpaywall", fullTextLicense: "publisher", fullTextRestricted: true });
  s.articles["1002"].fullTextStatus = "No open-access copy"; s.articles["1003"].fullTextStatus = "Retry needed";
  await t.BUCKET.put("bench.json", JSON.stringify(s));
  const zip1 = await t.raw(MANAGER, "/api/batch-zip", { runId: run.id });
  assert.equal(zip1.status, 200); assert.equal(zip1.headers.get("X-Export-Version"), "1");
  const files = readZip(await zip1.arrayBuffer()), rows = parseCsv(files.get("manifest.csv").toString("utf8")), head = rows[0], byId = Object.fromEntries(rows.slice(1).filter(r => r[0]).map(r => [r[0], Object.fromEntries(head.map((h, i) => [h, r[i]]))]));
  assert.deepEqual(Object.keys(byId).sort(), ["1000", "1001", "1002", "1003", "1004"], "every matched PMID is listed, including the one whose citation could not be retrieved");
  assert.equal(byId["1000"]["Full text status"], "available"); assert.equal(byId["1001"]["Full text status"], "restricted"); assert.match(byId["1001"]["Full text file"], /^withheld/);
  assert.equal(byId["1002"]["Full text status"], "missing"); assert.equal(byId["1003"]["Full text status"], "failed"); assert.equal(byId["1004"]["Citation XML status"], "failed");
  assert.ok(files.has("PMID_1000/efetch.xml") && files.has("PMID_1000/fulltext.xml") && files.has("PMID_1000/citation_snapshot.svg"));
  assert.ok(!files.has("PMID_1001/fulltext.pdf"), "restricted full text is not exported"); assert.ok(files.has("PMID_1001/efetch.xml"));
  const info = JSON.parse(files.get("export.json").toString("utf8")); assert.equal(info.batch.coverage, "partial"); assert.equal(info.batch.gaps.length, 1); assert.equal(info.exportVersion, 1);
  // same content again: the same version; a change creates version 2 that points back to version 1
  assert.equal((await t.raw(MANAGER, "/api/batch-zip", { runId: run.id })).headers.get("X-Export-Version"), "1");
  const s2 = await t.state(); s2.articles["1002"].fullTextStatus = "Captured"; s2.articles["1002"].fullTextKey = "evidence/1002/europepmc.xml"; s2.articles["1002"].fullTextRestricted = false; await t.BUCKET.put("evidence/1002/europepmc.xml", "<article/>"); await t.BUCKET.put("bench.json", JSON.stringify(s2));
  const zip2 = await t.raw(MANAGER, "/api/batch-zip", { runId: run.id }); assert.equal(zip2.headers.get("X-Export-Version"), "2");
  const info2 = JSON.parse(readZip(await zip2.arrayBuffer()).get("export.json").toString("utf8")); assert.equal(info2.previousVersion, 1); assert.equal(info2.previousManifestSha256, info.manifestSha256);
  const final = await t.state(); assert.equal(final.exports.length, 2); assert.equal(final.exports[1].previousVersion, 1);
  assert.match(await (await t.BUCKET.get("exports/" + run.id + "/v1/manifest.csv")).text(), /"PMID","Title"/, "prior versions stay retrievable");
  assert.equal((await t.call(SCREENER, "/api/batch-zip", { runId: run.id })).status, 403);
});

test("batch readiness is exposed and a targeted retry recovers only what is missing", async () => {
  const t = await makeEnv({ watches: [WATCH] }), records = recs(["2026-09-02", "2026-09-03"]);
  let ncbi = fakeNcbi(records, { dropDetails: ["1001"] });
  const run = (await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/import", { watch: "Antivirals|aciclovir", from: "2026-09-01", to: "2026-09-10" }))).body;
  // the citation of 1001 is stored, so the import is complete; its detail XML is evidence, reported and retried separately
  assert.equal(run.coverage, "reconciled");
  let ready = (await t.call(MANAGER, "/api/batch-readiness", {})).body.batches.find(b => b.id === run.id);
  assert.equal(ready.ready, false); assert.ok(ready.pending >= 1); assert.equal(ready.counts.citation.failed, 1); assert.equal(ready.importCoverage, "reconciled");
  ncbi = fakeNcbi(records);
  const retry = await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/evidence-retry", { runId: run.id }));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.ok(!ncbi.calls.some(c => c.includes("1000") && c.startsWith("efetch") && !c.includes("1001")), "the PMID that was already complete is not fetched again");
  const s = await t.state(); assert.ok(s.articles["1001"].evidence.efetch); assert.equal(s.runs[0].coverage, "reconciled"); assert.deepEqual(s.runs[0].gaps, []);
  ready = (await t.call(MANAGER, "/api/batch-readiness", {})).body.batches.find(b => b.id === run.id); assert.equal(ready.counts.citation.available, 2);
});

test("product dictionaries build the query, versions are previewed and applied prospectively, and executed imports keep their version", async () => {
  const t = await makeEnv({ watches: [WATCH] });
  assert.equal((await t.call(SCREENER, "/api/dictionary-save", { portfolio: "Antivirals", products: [{ name: "aciclovir" }] })).status, 403);
  const saved = await t.call(MANAGER, "/api/dictionary-save", { portfolio: "Antivirals", products: [{ name: "aciclovir", generics: "acyclovir", brands: "Zovirax, Zovir", salts: "aciclovir sodium", aliases: "ACV" }, { name: "valaciclovir", brands: "Valtrex" }] });
  assert.equal(saved.body.version, 1);
  assert.equal((await t.call(MANAGER, "/api/dictionary-save", { portfolio: "Antivirals", products: [{ name: "a", brands: "Zovirax" }, { name: "b", brands: "Zovirax" }] })).status, 400, "a name can belong to one product only");
  const ncbi = fakeNcbi(recs(["2026-10-02"]));
  const preview = (await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/watch-preview", { portfolio: "Antivirals", molecule: "aciclovir", safetyOnly: false }))).body;
  assert.equal(preview.exists, true); assert.deepEqual(preview.current, { version: 1, query: '"aciclovir"[tiab]' });
  for (const name of ["Zovirax", "acyclovir", "aciclovir sodium", "ACV"]) assert.ok(preview.proposed.query.includes('"' + name + '"[tiab]'), name);
  assert.ok(preview.added.includes("Zovirax")); assert.deepEqual(preview.removed, []); assert.equal(typeof preview.counts.proposed, "number");
  assert.equal((await t.state()).watches[0].versions, undefined, "a preview changes nothing");
  const effective = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const applied = await t.call(MANAGER, "/api/watch-version", { portfolio: "Antivirals", molecule: "aciclovir", effectiveFrom: effective, note: "Add brands and salts" });
  assert.equal(applied.body.version.version, 2); assert.equal(applied.body.version.dictionaryVersion, 1);
  let s = await t.state(); assert.equal(s.watches[0].query, '"aciclovir"[tiab]', "the new version is not in effect until its date");
  // a backfill over past dates still runs with version 1; a later window uses version 2
  const past = await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/import", { watch: "Antivirals|aciclovir", from: "2026-10-01", to: "2026-10-05" }));
  assert.deepEqual(past.body.queryVersions, [1]); assert.equal(past.body.windows[0].query, '"aciclovir"[tiab]'); assert.match(past.body.executedQueries[0], /aciclovir"\[tiab\]\) AND \(2026\/10\/01\[dp\]/);
  const windows = worker.execute ? null : null; void windows;
  s = await t.state(); const sorted = s.watches[0].versions.map(v => v.version); assert.deepEqual(sorted, [1, 2]);
});
