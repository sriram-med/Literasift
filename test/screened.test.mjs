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

test("QC sees every safety present article of their clients, and one comment can be added to many articles as DE or QC", async () => {
  const t = await makeEnv(team());
  await t.call(MANAGER, "/api/membership-save", { email: QC, portfolio: "Navinta", role: "qc" });
  await t.call(SCREENER, "/api/disposition", { id: "a1", value: "excluded", reason: "No adverse event" });
  await t.call(SCREENER, "/api/disposition", { id: "a2", value: "aggregate_safety", note: "Cohort" });
  await t.call(SCREENER2, "/api/disposition", { id: "a3", value: "excluded", reason: "No adverse event" });
  const saf = (await t.call(QC, "/api/screened", { kind: "safety" })).body.rows;
  assert.deepEqual(saf.map(r => [r.pmid, r.qc, r.canQcComment]), [["2", "", true]], "not routed to QC, still visible to QC");
  assert.equal((await t.call(QC, "/api/screened", { kind: "rejected" })).body.rows.length, 1, "other clients stay hidden");
  // DE bulk comment on their own articles; someone else's is skipped
  const de = (await t.call(SCREENER, "/api/screened-comment", { ids: ["a1", "a2", "a3"], as: "de", note: "Checked against the full text" })).body;
  assert.equal(de.done, 2); assert.equal(de.skipped.length, 1);
  assert.equal((await t.call(SCREENER, "/api/screened-comment", { ids: ["a1"], as: "qc", note: "Self check" })).body.skipped[0].why, "you cannot QC your own article");
  // QC bulk: comment on the safety article, agree the waiting rejection
  assert.equal((await t.call(QC, "/api/screened-comment", { ids: ["a2"], as: "qc", note: "Agree, aggregate only" })).body.done, 1);
  assert.equal((await t.call(QC, "/api/screened-comment", { ids: ["a1"], as: "qc", decision: "return", note: "no" })).status, 400);
  assert.equal((await t.call(QC, "/api/screened-comment", { ids: ["a1", "a2"], as: "qc", decision: "approve", note: "Agreed in bulk" })).body.done, 1, "only items waiting for QC take a decision");
  const s = await t.state(), a1 = s.assignments.find(a => a.id === "a1"), a2 = s.assignments.find(a => a.id === "a2");
  assert.equal(a1.disposition.note, "Checked against the full text"); assert.equal(a1.disposition.reason, "No adverse event"); assert.equal(a1.qc.status, "approved"); assert.equal(a1.status, "Complete");
  assert.equal(a2.qcComment.note, "Agree, aggregate only"); assert.equal(a2.qcComment.by, QC);
  const doc = readZip(await (await t.raw(QC, "/api/screened-docx", { kind: "safety" })).arrayBuffer()).get("word/document.xml").toString("utf8");
  assert.match(doc, /Agree, aggregate only/); assert.match(doc, /Checked against the full text/);
});

test("DE sends the rejected list to QC as a Word document; QC comments under each DE comment and downloads it with both", async () => {
  const t = await makeEnv(team());
  await t.call(MANAGER, "/api/membership-save", { email: QC, portfolio: "Navinta", role: "qc" });
  await t.call(SCREENER, "/api/disposition", { id: "a1", value: "excluded", reason: "No adverse event", note: "PK only" });
  await t.call(SCREENER2, "/api/disposition", { id: "a3", value: "excluded", reason: "No adverse event" });
  assert.equal((await t.call(QC, "/api/screened-send", { kind: "rejected" })).status, 400, "QC has no DE articles of their own to send");
  const sent = (await t.call(SCREENER, "/api/screened-send", { kind: "rejected", note: "Week 47 rejections" })).body;
  assert.equal(sent.doc.count, 1); assert.equal(sent.doc.status, "sent"); assert.equal(sent.doc.byName, "Asha");
  const qdocs = (await t.call(QC, "/api/screened-docs", {})).body.docs;
  assert.deepEqual(qdocs.map(d => [d.id, d.mine, d.note]), [[sent.doc.id, false, "Week 47 rejections"]]);
  assert.deepEqual((await t.call(SCREENER2, "/api/screened-docs", {})).body.docs, [], "other DEs and clients do not see it");
  const view = (await t.call(QC, "/api/screened", { doc: sent.doc.id })).body;
  assert.deepEqual(view.rows.map(r => r.pmid), ["1"]); assert.equal(view.doc.id, sent.doc.id);
  await t.call(QC, "/api/qc-decision", { id: "a1", decision: "approve", note: "Agree, PK study with no AE" });
  assert.equal((await t.call(SCREENER, "/api/screened-doc-done", { id: sent.doc.id })).status, 409, "the DE cannot close their own document");
  assert.equal((await t.call(QC, "/api/screened-doc-done", { id: sent.doc.id })).status, 200);
  const r = await t.raw(SCREENER, "/api/screened-docx", { doc: sent.doc.id });
  const doc = readZip(await r.arrayBuffer()).get("word/document.xml").toString("utf8");
  assert.match(doc, /Sent to QC by Asha/); assert.match(doc, /QC done by Quinn/);
  const de = doc.indexOf("No adverse event - PK only"), qc = doc.indexOf("Agree, PK study with no AE");
  assert.ok(de > 0 && qc > de, "QC comment comes right after the DE comment"); assert.doesNotMatch(doc, /Levetiracetam review/);
  assert.equal((await t.call(SCREENER, "/api/screened-docs", {})).body.docs[0].status, "reviewed");
});

test("DE sends the safety present list to the medical reviewer, whose comment sits under the DE comment in the Word file", async () => {
  const t = await makeEnv({ ...team(), profiles: [...team().profiles, { email: "meera@example.org", name: "Meera", role: "reviewer", portfolio: "Navinta", active: true, capacity: 20 }] });
  const MR = "meera@example.org";
  await t.call(MANAGER, "/api/membership-save", { email: MR, portfolio: "Navinta", role: "medical_reviewer" });
  await t.call(SCREENER, "/api/disposition", { id: "a2", value: "aggregate_safety", note: "Hepatotoxicity in a cohort" });
  await t.call(SCREENER, "/api/disposition", { id: "a1", value: "excluded", reason: "No adverse event" });
  const mrView = (await t.call(MR, "/api/screened", { kind: "safety" })).body.rows;
  assert.deepEqual(mrView.map(r => [r.pmid, r.canMrComment]), [["2", true]], "the medical reviewer sees safety present articles of their client");
  assert.equal((await t.call(MR, "/api/screened", { kind: "rejected" })).body.rows.length, 0, "but not rejections");
  const sent = (await t.call(SCREENER, "/api/screened-send", { kind: "safety", note: "Please review" })).body.doc;
  assert.equal(sent.sendTo, "medical"); assert.equal(sent.to, "");
  assert.deepEqual((await t.call(MR, "/api/screened-docs", {})).body.docs.map(d => d.id), [sent.id]);
  assert.equal((await t.call(SCREENER, "/api/screened-comment", { ids: ["a2"], as: "mr", note: "self" })).body.skipped.length, 1, "the DE cannot write the medical comment");
  assert.equal((await t.call(MR, "/api/screened-comment", { ids: ["a2"], as: "mr", note: "Aggregate only, no ICSR; include in PSUR" })).body.done, 1);
  assert.equal((await t.call(QC, "/api/screened-doc-done", { id: sent.id })).status, 404);
  assert.equal((await t.call(MR, "/api/screened-doc-done", { id: sent.id })).status, 200);
  const doc = readZip(await (await t.raw(SCREENER, "/api/screened-docx", { doc: sent.id })).arrayBuffer()).get("word/document.xml").toString("utf8");
  assert.match(doc, /Sent to medical review by Asha/); assert.match(doc, /Medical review done by Meera/);
  const de = doc.indexOf("Hepatotoxicity in a cohort"), mr = doc.indexOf("Aggregate only, no ICSR; include in PSUR");
  assert.ok(de > 0 && mr > de && doc.slice(de, mr).includes("Medical reviewer comment (Meera)"), "medical comment right under the DE comment");
  assert.equal((await t.state()).assignments.find(a => a.id === "a2").mrComment.by, MR);
});

test("mass rejection: one reason and comment for many articles, each routed to QC; QC agrees them together", async () => {
  const t = await makeEnv(team());
  await t.call(MANAGER, "/api/membership-save", { email: QC, portfolio: "Navinta", role: "qc" });
  assert.equal((await t.call(SCREENER, "/api/disposition-bulk", { ids: ["a1", "a2"] })).status, 400, "a reason is needed");
  assert.equal((await t.call(SCREENER, "/api/disposition-bulk", { ids: ["a1", "a2"], reason: "Other (explain in the note)" })).status, 400, "Other needs a comment");
  const r = (await t.call(SCREENER, "/api/disposition-bulk", { ids: ["a1", "a2", "a3"], reason: "No adverse event", note: "Bulk: PK and cohort papers" })).body;
  assert.equal(r.done, 2); assert.equal(r.skipped.length, 1, "another DE's article is skipped"); assert.equal(r.skipped[0].pmid, "3");
  const s = await t.state();
  for (const id of ["a1", "a2"]) { const a = s.assignments.find(x => x.id === id); assert.equal(a.disposition.reason, "No adverse event"); assert.equal(a.disposition.note, "Bulk: PK and cohort papers"); assert.equal(a.status, "Awaiting QC"); }
  assert.equal(s.assignments.find(x => x.id === "a3").disposition, undefined);
  const q = (await t.call(QC, "/api/screened-comment", { ids: ["a1", "a2"], as: "qc", decision: "approve", note: "Agreed" })).body;
  assert.equal(q.done, 2);
  assert.deepEqual((await t.state()).assignments.filter(a => ["a1", "a2"].includes(a.id)).map(a => a.qc.status), ["approved", "approved"]);
});

test("counts per client: QC sees every article of their clients, with the screening and QC state of each", async () => {
  const t = await makeEnv(team());
  await t.call(MANAGER, "/api/membership-save", { email: QC, portfolio: "Navinta", role: "qc" });
  await t.call(SCREENER, "/api/disposition", { id: "a1", value: "excluded", reason: "No adverse event" });
  const q = (await t.call(QC, "/api/pulled-articles", {})).body;
  assert.deepEqual(q.rows.map(r => [r.pmid, r.dispo, r.qc]).sort(), [["1", "excluded", "pending"], ["2", "", ""]], "both Navinta articles, not Laurus");
  assert.deepEqual(q.clients.map(c => c.name), ["Navinta"]);
});

test("an article waiting for QC needs Agree or Send back: a comment alone does not leave it waiting, and the document cannot be closed while one waits", async () => {
  const t = await makeEnv(team());
  await t.call(MANAGER, "/api/membership-save", { email: QC, portfolio: "Navinta", role: "qc" });
  await t.call(SCREENER, "/api/disposition", { id: "a1", value: "excluded", reason: "Other (explain in the note)", note: "this article is rejected" });
  const row = (await t.call(QC, "/api/screened", { kind: "rejected" })).body.rows[0];
  assert.equal(row.deText, "Other: this article is rejected", "Other shows only the explanation");
  const c = (await t.call(QC, "/api/screened-comment", { ids: ["a1"], as: "qc", note: "this article is rejected" })).body;
  assert.equal(c.done, 0); assert.match(c.skipped[0].why, /Agree or Send back/);
  const doc = (await t.call(SCREENER, "/api/screened-send", { kind: "rejected" })).body.doc;
  const blocked = await t.call(QC, "/api/screened-doc-done", { id: doc.id });
  assert.equal(blocked.status, 409); assert.match(blocked.body.error, /still waiting for QC/);
  await t.call(QC, "/api/screened-comment", { ids: ["a1"], as: "qc", decision: "approve", note: "this article is rejected" });
  assert.equal((await t.call(QC, "/api/screened-doc-done", { id: doc.id })).status, 200);
  const xml = readZip(await (await t.raw(QC, "/api/screened-docx", { doc: doc.id })).arrayBuffer()).get("word/document.xml").toString("utf8");
  assert.match(xml, /Other: this article is rejected/); assert.doesNotMatch(xml, /Waiting for QC\]/); assert.match(xml, /QC agreed/);
});

test("the Word documents list is fresh every week: earlier weeks are hidden unless asked for", async () => {
  const t = await makeEnv(team());
  await t.call(MANAGER, "/api/membership-save", { email: QC, portfolio: "Navinta", role: "qc" });
  await t.call(SCREENER, "/api/disposition", { id: "a1", value: "excluded", reason: "No adverse event" });
  const now = (await t.call(SCREENER, "/api/screened-send", { kind: "rejected" })).body.doc;
  const s = await t.state(); s.screenedDocs.push({ ...s.screenedDocs[0], id: "old", at: "2026-01-05T06:00:00.000Z" }); await t.BUCKET.put("bench.json", JSON.stringify(s));
  const wk = (await t.call(QC, "/api/screened-docs", {})).body;
  assert.deepEqual(wk.docs.map(d => d.id), [now.id]); assert.equal(wk.earlier, 1);
  assert.deepEqual((await t.call(QC, "/api/screened-docs", { all: true })).body.docs.map(d => d.id).sort(), [now.id, "old"].sort());
});
