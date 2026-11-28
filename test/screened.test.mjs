// Screened articles: every rejection goes to QC, the DE and QC see Rejected and Safety present lists by client,
// QC agrees or sends back with a comment, and both can download a Word file with the title, IRD, the DE comment (yellow) and the QC comment.
import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, SCREENER, SCREENER2, QC, makeEnv, readZip } from "./helpers.mjs";

const team = () => ({
  profiles: [{ email: MANAGER, name: "Boss", role: "manager", active: true }, { email: SCREENER, name: "Asha", role: "reviewer", portfolio: "Navinta", active: true, capacity: 20 },
    { email: SCREENER2, name: "Ravi", role: "reviewer", portfolio: "Laurus", active: true, capacity: 20 }, { email: QC, name: "Quinn", role: "reviewer", portfolio: "Navinta", active: true, capacity: 20 }],
  clients: [{ id: "c1", name: "Navinta" }, { id: "c2", name: "Laurus" }],
  watches: [{ portfolio: "Navinta", molecule: "aciclovir", query: "q", client: "c1" }, { portfolio: "Laurus", molecule: "levetiracetam", query: "q2", client: "c2" }],
  articles: { 1: { id: "1", title: "Aciclovir & renal <failure>", abstract: "A case.", authors: ["Rao A"] }, 2: { id: "2", title: "Aciclovir cohort study", abstract: "Cohort.", authors: ["Li B"] }, 3: { id: "3", title: "Levetiracetam review", abstract: "Review.", authors: ["Ko C"] } },
  assignments: [{ id: "a1", pmid: "1", portfolio: "Navinta", molecules: ["aciclovir"], reviewer: SCREENER, status: "In review", ird: "2026-11-22" },
    { id: "a2", pmid: "2", portfolio: "Navinta", molecules: ["aciclovir"], reviewer: SCREENER, status: "In review", ird: "2026-11-22" },
    { id: "a3", pmid: "3", portfolio: "Laurus", molecules: ["levetiracetam"], reviewer: SCREENER2, status: "In review", ird: "2026-11-15" }] });

test("every rejection goes to QC; Rejected and Safety present lists are separate and grouped by client", async () => {
  const t = await makeEnv(team());
  await t.call(MANAGER, "/api/membership-save", { email: QC, portfolio: "Navinta", role: "qc" });
  assert.equal((await t.call(SCREENER, "/api/disposition", { id: "a1", value: "excluded", reason: "No adverse event", note: "Only pharmacokinetics" })).status, 200);
  assert.equal((await t.call(SCREENER, "/api/disposition", { id: "a2", value: "aggregate_safety", note: "Cohort with hepatotoxicity" })).status, 200);
  assert.equal((await t.call(SCREENER2, "/api/disposition", { id: "a3", value: "excluded", reason: "Not a drug safety report (review, background, or editorial)" })).status, 200);
  const s = await t.state();
  assert.equal(s.assignments.find(a => a.id === "a1").qc.status, "pending"); assert.equal(s.assignments.find(a => a.id === "a1").qc.reviewer, QC);
  assert.match(s.assignments.find(a => a.id === "a1").qc.reason, /every rejection/);
  const mgr = (await t.call(MANAGER, "/api/screened", { kind: "rejected" })).body;
  assert.deepEqual(mgr.rows.map(r => [r.client, r.pmid]), [["Laurus", "3"], ["Navinta", "1"]], "sorted and grouped by client");
  assert.equal(mgr.rows[1].reason, "No adverse event"); assert.equal(mgr.rows[1].note, "Only pharmacokinetics"); assert.equal(mgr.rows[1].ird, "2026-11-22"); assert.equal(mgr.rows[1].deName, "Asha");
  assert.equal(mgr.counts.pending, 2); assert.equal(mgr.other, 1, "one safety-present article on the other tab");
  const safety = (await t.call(MANAGER, "/api/screened", { kind: "safety" })).body;
  assert.deepEqual(safety.rows.map(r => r.pmid), ["2"]);
  // the screener sees only their own; the QC reviewer sees the QC items of their client and can act on them
  assert.deepEqual((await t.call(SCREENER2, "/api/screened", { kind: "rejected" })).body.rows.map(r => r.pmid), ["3"]);
  const q = (await t.call(QC, "/api/screened", { kind: "rejected", qc: "pending" })).body;
  assert.deepEqual(q.rows.map(r => [r.pmid, r.canQc]), [["1", true]]);
  assert.equal((await t.call(SCREENER, "/api/screened", { kind: "rejected" })).body.rows[0].canQc, false, "the DE cannot QC their own rejection");
  // filters: client and IRD range
  assert.deepEqual((await t.call(MANAGER, "/api/screened", { kind: "rejected", client: "Laurus" })).body.rows.map(r => r.pmid), ["3"]);
  assert.deepEqual((await t.call(MANAGER, "/api/screened", { kind: "rejected", from: "2026-11-20", to: "2026-11-28" })).body.rows.map(r => r.pmid), ["1"]);
  // QC comments: agree, or send back with a reason
  assert.equal((await t.call(QC, "/api/qc-decision", { id: "a1", decision: "approve", note: "Agree, no AE reported" })).status, 200);
  const after = (await t.call(QC, "/api/screened", { kind: "rejected" })).body.rows.find(r => r.pmid === "1");
  assert.equal(after.qc, "approved"); assert.equal(after.qcNote, "Agree, no AE reported"); assert.equal(after.qcName, "Quinn"); assert.equal(after.canQc, false);
});

test("the setting can switch back to sampling rejections", async () => {
  const t = await makeEnv(team());
  assert.equal((await t.call(MANAGER, "/api/settings", { qcAllExcluded: false })).status, 200);
  const st = await t.state(); st.settings.qcRate = 0; await t.BUCKET.put("bench.json", JSON.stringify(st));
  assert.equal((await t.call(SCREENER, "/api/disposition", { id: "a1", value: "excluded", reason: "No adverse event" })).status, 200);
  assert.equal((await t.state()).assignments.find(a => a.id === "a1").status, "Complete");
});

test("Word document: title, IRD and the DE comment highlighted yellow, with the QC comment, by client", async () => {
  const t = await makeEnv(team());
  await t.call(MANAGER, "/api/membership-save", { email: QC, portfolio: "Navinta", role: "qc" });
  await t.call(SCREENER, "/api/disposition", { id: "a1", value: "excluded", reason: "No adverse event", note: "Only pharmacokinetics" });
  await t.call(SCREENER2, "/api/disposition", { id: "a3", value: "excluded", reason: "Not a drug safety report (review, background, or editorial)" });
  await t.call(QC, "/api/qc-decision", { id: "a1", decision: "return", note: "Renal failure is an adverse event, please recheck" });
  for (const who of [QC, SCREENER, MANAGER]) {
    const r = await t.raw(who, "/api/screened-docx", { kind: "rejected" });
    assert.equal(r.status, 200, who); assert.match(r.headers.get("content-type"), /wordprocessingml/);
    const files = readZip(await r.arrayBuffer()), doc = files.get("word/document.xml").toString("utf8");
    assert.ok(files.has("[Content_Types].xml") && files.has("_rels/.rels"));
    assert.match(doc, /Aciclovir &amp; renal &lt;failure&gt;/, "titles are escaped");
    assert.match(doc, /IRD 2026-11-22/); assert.match(doc, /<w:highlight w:val="yellow"\/><\/w:rPr><w:t xml:space="preserve">No adverse event - Only pharmacokinetics/);
    assert.match(doc, /Renal failure is an adverse event, please recheck/);
    if (who === MANAGER) { assert.ok(doc.indexOf("Laurus") < doc.indexOf("Navinta"), "client sections"); assert.match(doc, /Levetiracetam review/); }
    else assert.doesNotMatch(doc, /Levetiracetam review/, "other clients' articles stay out");
  }
});
