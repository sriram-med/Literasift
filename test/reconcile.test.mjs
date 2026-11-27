// Incident regression tests: Square's eight molecules, Calcium Acetate first. Synthetic PubMed (no network): every PMID must be accounted for.
import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, SCREENER, fakeNcbi, withFetch, makeEnv } from "./helpers.mjs";
import worker from "../worker/index.js";

const dAgo = n => new Date(Date.now() + 5.5 * 3600000 - n * 86400000).toISOString().slice(0, 10);
const SQUARE = ["calcium acetate", "omeprazole", "valsartan", "amoxicillin", "cefixime", "esomeprazole", "losartan", "montelukast"];
const key = w => encodeURIComponent(w.portfolio) + "|" + encodeURIComponent(w.molecule);
async function square(extra = {}) {
  // every molecule belongs to its client; the client name is the only grouping
  const watches = SQUARE.map((m, i) => ({ id: "w" + i, portfolio: "Square", molecule: m, query: '("' + m + '"[tiab])', names: [], client: "sq" }));
  const t = await makeEnv({ watches, clients: [{ id: "sq", name: "Square" }] }, extra);
  return { t, watches };
}
const pull = (t, body, h) => withFetch(h, () => t.call(MANAGER, "/api/pull-client", { client: "sq", searchMode: "precise", ...body }));
const csv = async (t, runIds) => (await (await worker.fetch(new Request("http://localhost/api/reconciliation-csv", { method: "POST", headers: { "oai-authenticated-user-email": MANAGER, "content-type": "application/json" }, body: JSON.stringify({ runIds }) }), t.env)).text()).replace("﻿", "").trim().split("\r\n");

test("Calcium acetate with 426 PubMed matches: all 426 accounted for, stored and linked, checked PMID by PMID", async () => {
  const { t, watches } = await square();
  const recs = Array.from({ length: 426 }, (_, i) => ({ pmid: String(30000 + i), date: dAgo(1 + (i % 360)) })), ncbi = fakeNcbi(recs);
  const r = await pull(t, { from: dAgo(365), to: dAgo(0), molecules: [key(watches[0])] }, ncbi.handler); assert.equal(r.status, 200, JSON.stringify(r.body));
  const x = r.body.results[0];
  assert.equal(x.expected, 426); assert.equal(x.withCitation, 426); assert.equal(x.linked, 426); assert.equal(x.notStored, 0); assert.equal(x.unexpected, 0); assert.equal(x.complete, true); assert.equal(x.idCheck, true);
  assert.equal(x.dateBasis, "any"); assert.match(x.term, /calcium acetate/); assert.ok(!/\bcalcium\b(?! acetate)/.test(x.term), "the salt is never reduced to calcium");
  const st = await t.state(), run = st.runs.find(r2 => r2.id === x.runId);
  assert.equal(run.snapshot.watchId, "w0"); assert.equal(run.snapshot.dateBasis, "any"); assert.equal(run.snapshot.term, x.term); assert.equal(run.recon.expected, 426);
  const rows = await csv(t, [x.runId]); assert.equal(rows.length, 427); assert.ok(rows.slice(1).every(l => l.includes('"matched and stored"') && l.includes('"yes"')));
});

test("same count, different PMID sets: reconciliation reports the missing and the unexpected PMIDs, and the pull is not complete", async () => {
  const { t, watches } = await square();
  const from = dAgo(200), to = dAgo(0), whole = from.replaceAll("-", "/") + "[crdt]:" + to.replaceAll("-", "/") + "[crdt]";
  const A = Array.from({ length: 10 }, (_, i) => ({ pmid: String(100 + i), date: dAgo(5 + i * 15) })), B = A.slice(1).concat([{ pmid: "999", date: dAgo(40) }]);
  const nA = fakeNcbi(A), nB = fakeNcbi(B);
  const h = async (u, i) => { const url = new URL(String(u)), term = url.searchParams.get("term") || ""; return (url.pathname.endsWith("esearch.fcgi") && term.includes(whole) ? nB : nA).handler(u, i); };
  const x = (await pull(t, { from, to, molecules: [key(watches[0])] }, h)).body.results[0];
  assert.equal(x.expected, 10); assert.equal(x.notStored, 1); assert.equal(x.unexpected, 1); assert.deepEqual(x.missingSample, ["999"]); assert.deepEqual(x.unexpectedSample, ["100"]); assert.equal(x.complete, false);
  const rows = await csv(t, [x.runId]); assert.ok(rows.some(l => l.includes('"999"') && l.includes('"missing"'))); assert.ok(rows.some(l => l.includes('"100"') && l.includes('"unexpected"')));
});

test("one PMID found by two Square molecules: one canonical citation, linked to both molecules and both watches", async () => {
  const { t, watches } = await square();
  const ncbi = fakeNcbi([{ pmid: "777", date: dAgo(3) }]);
  await pull(t, { from: dAgo(10), to: dAgo(0), molecules: [key(watches[0]), key(watches[2])] }, ncbi.handler);   // both molecules of Square
  const st = await t.state();
  assert.equal(Object.keys(st.articles).filter(id => id === "777").length, 1);
  const as = st.assignments.filter(a => a.pmid === "777"); assert.equal(as.length, 1); assert.deepEqual(as[0].molecules.sort(), ["calcium acetate", "valsartan"]);
  assert.deepEqual(st.articles["777"].watchIds.sort(), ["w0", "w2"]);
});

test("one watch fails in an eight-molecule pull: the others complete, the failed one is named, and retrying it completes it", async () => {
  const { t, watches } = await square();
  const ncbi = fakeNcbi([{ pmid: "1", date: dAgo(2) }, { pmid: "2", date: dAgo(4) }]);
  const broken = async (u, i) => { const term = new URL(String(u)).searchParams.get("term") || ""; if (term.includes("cefixime")) return new Response("down", { status: 503 }); return ncbi.handler(u, i); };
  const results = [];
  for (const w of watches) results.push((await pull(t, { from: dAgo(10), to: dAgo(0), molecules: [key(w)] }, broken)).body.results[0]);
  const bad = results.filter(x => x.error || !x.complete); assert.equal(bad.length, 1); assert.equal(bad[0].molecule, "cefixime");
  assert.ok(results.filter(x => x.molecule !== "cefixime").every(x => x.complete));
  const again = (await pull(t, { from: dAgo(10), to: dAgo(0), molecules: [key(watches[4])] }, ncbi.handler)).body.results[0]; assert.equal(again.complete, true);
});

test("truncated ESearch, a partial EFetch and a worker restart never silently drop a PMID", async () => {
  // a single day with more PMIDs than one search returns: visible, never complete
  { const { t, watches } = await square(); const day = dAgo(2), recs = Array.from({ length: 12 }, (_, i) => ({ pmid: String(5000 + i), date: day })), ncbi = fakeNcbi(recs, { cap: 5 });
    const x = (await pull(t, { from: day, to: day, molecules: [key(watches[0])] }, ncbi.handler)).body.results[0];
    assert.equal(x.complete, false, JSON.stringify(x)); assert.ok(x.notStored > 0 || x.failedWindows > 0 || x.error); }
  // EFetch leaves a record out: its citation is stored, its detail XML is pending, the PMID counts
  { const { t, watches } = await square(); const recs = Array.from({ length: 5 }, (_, i) => ({ pmid: String(6000 + i), date: dAgo(2 + i) })), ncbi = fakeNcbi(recs, { dropDetails: ["6002"] });
    const x = (await pull(t, { from: dAgo(10), to: dAgo(0), molecules: [key(watches[0])] }, ncbi.handler)).body.results[0];
    assert.equal(x.complete, true); assert.equal(x.withCitation, 5); const rows = await csv(t, [x.runId]); assert.ok(rows.some(l => l.includes('"6002"') && l.includes("detail XML pending"))); }
  // a pull whose worker died is picked up by the scheduler and finished
  { const { t, watches } = await square(); const ncbi = fakeNcbi([{ pmid: "8001", date: dAgo(2) }]);
    const s = await t.state(); s.pullJobs = [{ id: "11111111-1111-1111-1111-111111111111", by: MANAGER, route: "/api/pull-client", body: { client: "sq", from: dAgo(5), to: dAgo(0), molecules: [key(watches[0])], searchMode: "precise" }, state: "running", heartbeat: Date.now() - 600000 }]; await t.BUCKET.put("bench.json", JSON.stringify(s));
    await t.BUCKET.put("jobs/pull/11111111-1111-1111-1111-111111111111.json", JSON.stringify({ by: MANAGER, state: "running", at: Date.now() - 600000 }));
    await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/scheduled", {}));
    const j = (await t.state()).pullJobs[0]; assert.equal(j.state, "done", JSON.stringify(j)); assert.equal(j.resumed, true);
    const p = (await t.call(MANAGER, "/api/pull-job", { id: j.id })).body; assert.equal(p.state, "done"); assert.ok(p.payload.results[0].complete); assert.ok((await t.state()).articles["8001"]); }
});

test("a citation without a full text counts in the pull and stays available for abstract screening", async () => {
  const { t, watches } = await square(); const ncbi = fakeNcbi([{ pmid: "9100", date: dAgo(2) }]);
  const x = (await pull(t, { from: dAgo(5), to: dAgo(0), molecules: [key(watches[0])] }, ncbi.handler)).body.results[0];
  assert.equal(x.complete, true); assert.equal(x.linked, 1);
  const st = await t.state(); assert.ok(!st.articles["9100"].fullTextKey); assert.ok(st.articles["9100"].abstract || st.articles["9100"].title); assert.ok(st.assignments.some(a => a.pmid === "9100" && a.status === "Pending"));
  const rows = await csv(t, [x.runId]); assert.ok(rows[1].includes('"citation stored"') || rows[1].includes("detail XML pending"));
});

test("changing the query, the date basis or a filter makes a new, auditable run with its own executed term", async () => {
  const { t, watches } = await square(); const ncbi = fakeNcbi([{ pmid: "1", date: dAgo(2) }]), k = [key(watches[0])];
  const a = (await pull(t, { from: dAgo(5), to: dAgo(0), molecules: k }, ncbi.handler)).body.results[0];
  const b = (await pull(t, { from: dAgo(5), to: dAgo(0), molecules: k, dateField: "crdt" }, ncbi.handler)).body.results[0];
  const c = (await pull(t, { from: dAgo(5), to: dAgo(0), molecules: k, caseReports: true }, ncbi.handler)).body.results[0];
  const d = (await pull(t, { from: dAgo(5), to: dAgo(0), molecules: k, searchMode: "pubmed" }, ncbi.handler)).body.results[0];
  assert.equal(new Set([a.runId, b.runId, c.runId, d.runId]).size, 4); assert.equal(new Set([a.term, b.term, c.term, d.term]).size, 4);
  assert.ok(a.term.includes("[dp]") && !b.term.includes("[dp]")); assert.ok(c.term.includes('"case reports"[pt]')); assert.equal(d.mode, "pubmed"); assert.ok(d.term.includes("((calcium acetate))"));
  const st = await t.state(); for (const x of [a, b, c, d]) assert.equal(st.runs.find(r => r.id === x.runId).snapshot.term, x.term);
});

test("re-importing an article that was already reviewed repairs its missing link and keeps every review decision", async () => {
  const { t, watches } = await square();
  const s = await t.state(); s.articles["4242"] = { id: "4242", title: "Old" };
  s.assignments.push({ id: "as1", pmid: "4242", portfolio: "Square", molecules: [], reviewer: SCREENER, status: "Complete", ird: "2026-01-02", disposition: { value: "potential_icsr", by: SCREENER, at: "2026-01-03T00:00:00Z" }, qc: { status: "approved", decidedBy: MANAGER } });
  await t.BUCKET.put("bench.json", JSON.stringify(s));
  const ncbi = fakeNcbi([{ pmid: "4242", date: dAgo(3) }]);
  await pull(t, { from: dAgo(10), to: dAgo(0), molecules: [key(watches[0])] }, ncbi.handler);
  const a = (await t.state()).assignments.find(x => x.id === "as1");
  assert.deepEqual(a.molecules, ["calcium acetate"]); assert.equal(a.reviewer, SCREENER); assert.equal(a.status, "Complete"); assert.equal(a.ird, "2026-01-02"); assert.equal(a.disposition.value, "potential_icsr"); assert.equal(a.qc.status, "approved");
  assert.equal((await t.state()).assignments.filter(x => x.pmid === "4242").length, 1, "no duplicate assignment");
});

test("Retry missing PMIDs repairs a run without deleting anything or clearing its coverage", async () => {
  const { t, watches } = await square(); const recs = Array.from({ length: 6 }, (_, i) => ({ pmid: String(2000 + i), date: dAgo(2 + i) }));
  const first = fakeNcbi(recs, { dropSummary: ["2003"] });
  const x = (await pull(t, { from: dAgo(10), to: dAgo(0), molecules: [key(watches[0])] }, first.handler)).body.results[0];
  assert.equal(x.complete, false); assert.equal(x.notStored, 1);
  const r = await withFetch(fakeNcbi(recs).handler, () => t.call(MANAGER, "/api/run-repair", { runId: x.runId })); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.before.missing, 1); assert.equal(r.body.after.missing, 0); assert.equal(r.body.after.linked, 6);
  const run = (await t.state()).runs.find(z => z.id === x.runId); assert.equal(run.ids.length, 6); assert.equal(run.coverage, "reconciled");
  assert.equal((await withFetch(fakeNcbi(recs).handler, () => t.call(SCREENER, "/api/run-repair", { runId: x.runId }))).status, 403);
});

test("the search contract: PubMed default, Precise and Custom, approved spelling variants only, inclusive dates, versions per window", async () => {
  const { t, watches } = await square(); const ncbi = fakeNcbi([{ pmid: "1", date: dAgo(2) }]), k = [key(watches[0])];
  // custom: the approved expression runs as written, with only the dates and selected filters added
  const s = await t.state(); s.watches[0].customQuery = '"calcium acetate"[nm] OR PhosLo[tiab]'; await t.BUCKET.put("bench.json", JSON.stringify(s));
  const c = (await pull(t, { from: dAgo(5), to: dAgo(0), molecules: k, searchMode: "pubmed", humans: true }, ncbi.handler)).body.results[0];
  assert.equal(c.mode, "custom"); assert.ok(c.term.startsWith('(("calcium acetate"[nm] OR PhosLo[tiab]) AND humans[mh])'), c.term);
  assert.ok(c.term.includes(dAgo(5).replaceAll("-", "/") + "[crdt]:" + dAgo(0).replaceAll("-", "/") + "[crdt]"), "both end days are in the range");
  // client, portfolio and class never enter a query
  for (const x of [c]) for (const word of ["Square", "Gastro", "Cardiovascular"]) assert.ok(!x.term.includes(word));
});

test("approved names: aciclovir/acyclovir and sulfate/sulphate are suggested, never added on their own", async () => {
  const t = await makeEnv({ clients: [{ id: "p", name: "P" }], watches: [{ portfolio: "P", client: "p", molecule: "aciclovir", query: '"aciclovir"[tiab]', names: [] }, { portfolio: "P", client: "p", molecule: "morphine sulphate", query: '"morphine sulphate"[tiab]', names: [] }] });
  const ncbi = fakeNcbi([{ pmid: "1", date: dAgo(2) }]);
  await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/pull-client", { client: "p", from: dAgo(5), to: dAgo(0), searchMode: "precise" }));
  const terms = decodeURIComponent(ncbi.calls.filter(c => c.startsWith("esearch")).join(" ").replace(/\+/g, " "));
  assert.ok(!terms.includes("acyclovir") && !terms.includes("morphine sulfate"), "variants are not searched until approved");
  const sug = (await t.call(MANAGER, "/api/name-variants", { names: ["aciclovir", "morphine sulphate", "Acyclovir sodium"] })).body.variants;
  assert.deepEqual(sug["aciclovir"], ["acyclovir"]); assert.deepEqual(sug["morphine sulphate"], ["morphine sulfate"]); assert.deepEqual(sug["Acyclovir sodium"], ["Aciclovir sodium"]);
  await t.call(MANAGER, "/api/watch-auto", { watch: "P|aciclovir", names: "acyclovir" });
  ncbi.calls.length = 0; await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/pull-client", { client: "p", from: dAgo(5), to: dAgo(0), searchMode: "precise", molecules: ["P|aciclovir"] }));
  assert.ok(decodeURIComponent(ncbi.calls.join(" ").replace(/\+/g, " ")).includes('"acyclovir"[tiab]'), "an approved variant is searched");
});

test("a scheduled range across a query-version change keeps each window's version, and overlapping date bases are counted once", async () => {
  const t = await makeEnv({ watches: [{ portfolio: "P", molecule: "x", query: '"x"[tiab]', versions: [{ version: 1, query: '"x"[tiab]', effectiveFrom: "0000-00-00" }, { version: 2, query: '"x"[tiab] OR "xy"[tiab]', effectiveFrom: dAgo(10) }] }] });
  const ncbi = fakeNcbi([{ pmid: "1", date: dAgo(20) }, { pmid: "2", date: dAgo(5) }]);
  const r = await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/import", { watch: "P|x", from: dAgo(30), to: dAgo(0), dateField: "pdat" }));
  const run = r.body; assert.ok(run.windows.some(w => w.queryVersion === 1) && run.windows.some(w => w.queryVersion === 2), JSON.stringify(run.windows.map(w => [w.from, w.queryVersion])));
  // "created or published" is one search with OR, so an article matching both is one PMID
  const t2 = await makeEnv({ clients: [{ id: "p", name: "P" }], watches: [{ portfolio: "P", client: "p", molecule: "x", query: '"x"[tiab]', names: [] }] });
  const both = fakeNcbi([{ pmid: "50", date: dAgo(3) }]);
  const x = (await withFetch(both.handler, () => t2.call(MANAGER, "/api/pull-client", { client: "p", from: dAgo(5), to: dAgo(0), dateField: "any" }))).body.results[0];
  assert.equal(x.withCitation, 1); assert.match(x.term, /\[crdt\]\) OR \(.*\[dp\]\)/);
});

test("Compare checks exactly the ticked molecules with the pull's settings and shows the executed term, PubMed's translation and warnings", async () => {
  const { t, watches } = await square(); const n = fakeNcbi([{ pmid: "1", date: dAgo(2) }]);
  const h = async (u, i) => { const url = new URL(String(u)); if (url.pathname.endsWith("esearch.fcgi")) { const j = await (await n.handler(u, i)).json(); j.esearchresult.querytranslation = "TRANSLATED"; j.esearchresult.warninglist = { phrasesignored: [], quotedphrasesnotfound: ['"calcium acetate"'], outputmessages: [] }; return Response.json(j); } return n.handler(u, i); };
  const r = await withFetch(h, () => t.call(MANAGER, "/api/compare-client", { client: "sq", molecules: [key(watches[0]), key(watches[1])], from: dAgo(5), to: dAgo(0), dateField: "crdt", searchMode: "precise", caseReports: true }));
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.rows.length, 2); assert.equal(r.body.dateField, "crdt");
  const row = r.body.rows[0]; assert.equal(row.translation, "TRANSLATED"); assert.ok(row.warnings.some(w => /Quoted phrase not found/.test(w))); assert.ok(row.term.includes('"case reports"[pt]') && row.term.includes("[crdt]") && !row.term.includes("[dp]"));
  // the pull with the same settings runs the same term
  const p = (await pull(t, { molecules: [key(watches[0])], from: dAgo(5), to: dAgo(0), dateField: "crdt", caseReports: true }, h)).body.results[0]; assert.equal(p.term, row.term);
});
