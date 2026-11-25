// Search, tags, folders, archive and deletion of cases. Synthetic fixtures only.
import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, SCREENER, SCREENER2, MEDICAL, makeEnv } from "./helpers.mjs";

const ev = (verbatim, ser = {}, listed = "") => ({ verbatim: { value: verbatim }, pt: { value: "" }, listedness: { value: listed }, expectedness: { value: listed }, seriousness: ser });
const mkCase = (id, number, pmid, events, extra = {}) => ({ id, number, pmid, portfolio: "Antivirals", molecule: "aciclovir", status: "Draft", assignee: SCREENER, createdBy: SCREENER, createdAt: "2026-01-01", updatedAt: "2026-01-01", history: [], versions: [], data: { patient: { identifier: { value: "P" + id }, age: { value: "54" }, sex: { value: "Male" }, medical_history: [] }, products: [{ name: { value: "aciclovir" }, role: "suspect" }], events }, ...extra });
async function setup() {
  const t = await makeEnv({
    profiles: [{ email: MANAGER, name: "Boss", role: "manager", active: true }, { email: SCREENER, name: "Asha", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }, { email: SCREENER2, name: "Ravi", role: "reviewer", portfolio: "Cardio", active: true, capacity: 50 }, { email: MEDICAL, name: "Meera", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }],
    memberships: [{ email: MEDICAL, portfolio: "Antivirals", role: "medical_reviewer" }],
    articles: { 1: { id: "1", title: "Aciclovir neurotoxicity", abstract: "status epilepticus in renal failure", authors: ["Rao A"], journal: "J Test" }, 2: { id: "2", title: "Aciclovir rash", abstract: "mild rash", authors: ["Iyer S"], journal: "J Derm" }, 3: { id: "3", title: "Statin myopathy", abstract: "muscle pain", authors: ["Khan Z"], journal: "J Cardio" } },
    assignments: [{ id: "a1", pmid: "1", portfolio: "Antivirals", molecules: ["aciclovir"], reviewer: SCREENER, status: "Complete" }, { id: "a2", pmid: "2", portfolio: "Antivirals", molecules: ["aciclovir"], reviewer: SCREENER, status: "Pending" }, { id: "a3", pmid: "3", portfolio: "Cardio", molecules: ["statin"], reviewer: SCREENER2, status: "Pending" }] });
  const s = await t.state();
  s.cases = [mkCase("c1", "LS-1", "1", [ev("status epilepticus", { serious: true, hospitalization: true }, "Unlisted")]), mkCase("c2", "LS-2", "2", [ev("rash", {}, "Listed")]), mkCase("c3", "LS-3", "3", [ev("myopathy", { serious: true, other_medically_important: true }, "Listed")], { portfolio: "Cardio", assignee: SCREENER2, createdBy: SCREENER2 })];
  await t.BUCKET.put("bench.json", JSON.stringify(s)); return t;
}
const auditActions = async t => (await (await t.BUCKET.get("audit2/" + new Date().toISOString().slice(0, 7) + ".ndjson")).text()).trim().split("\n").map(JSON.parse).map(e => e.action);

test("universal search finds citations and cases across fields, honours operators and filters, and respects who may see what", async () => {
  const t = await setup(), q = (who, body) => t.call(who, "/api/search", body).then(r => r.body);
  let r = await q(SCREENER, { q: "epilepticus" }); assert.deepEqual(r.cases.map(c => c.number), ["LS-1"]); assert.deepEqual(r.articles.map(a => a.pmid), ["1"], "abstract text is searched");
  assert.deepEqual((await q(SCREENER, { q: "pmid:2" })).articles.map(a => a.pmid), ["2"]); assert.deepEqual((await q(SCREENER, { q: "aciclovir -rash" })).articles.map(a => a.pmid), ["1"]);
  assert.deepEqual((await q(SCREENER, { q: '"renal failure"' })).articles.map(a => a.pmid), ["1"]); assert.deepEqual((await q(SCREENER, { q: "case:LS-2" })).cases.map(c => c.number), ["LS-2"]);
  assert.equal((await q(SCREENER, { q: "statin" })).counts.articles, 0, "other portfolio is not visible"); assert.equal((await q(MANAGER, { q: "statin" })).counts.articles, 1);
  // filters: serious / non-serious / listed / unlisted
  const nums = async f => (await q(MANAGER, { q: "", filters: f })).cases.map(c => c.number).sort();
  assert.deepEqual(await nums({ serious: "serious" }), ["LS-1", "LS-3"]); assert.deepEqual(await nums({ serious: "nonserious" }), ["LS-2"]);
  assert.deepEqual(await nums({ listed: "unlisted" }), ["LS-1"]); assert.deepEqual(await nums({ listed: "listed" }), ["LS-2", "LS-3"]); assert.deepEqual(await nums({ serious: "serious", listed: "listed" }), ["LS-3"]);
  assert.deepEqual(await nums({ portfolio: "Antivirals" }), ["LS-1", "LS-2"]);
  const log = await auditActions(t); assert.ok(log.filter(a => a === "search.run").length >= 8, "every search is in the audit trail");
});

test("tags and folders: users tag cases with seriousness and listedness labels, tags drive filters, everything is audited, and permissions hold", async () => {
  const t = await setup();
  assert.equal((await t.call(SCREENER, "/api/case-tag", { ids: ["c2"], tag: "Serious:Hospitalization" })).body.changed, 1);
  assert.equal((await t.call(SCREENER, "/api/case-tag", { ids: ["c3"], tag: "x" })).status, 400); assert.equal((await t.call(SCREENER, "/api/case-tag", { ids: ["c3"], tag: "listed" })).status, 403, "not their case");
  const found = (await t.call(MANAGER, "/api/search", { q: "", filters: { serious: "serious" } })).body.cases.map(c => c.number).sort(); assert.deepEqual(found, ["LS-1", "LS-2", "LS-3"], "a seriousness tag marks the case serious");
  assert.deepEqual((await t.call(MANAGER, "/api/search", { q: "tag:serious:hospitalization" })).body.cases.map(c => c.number), ["LS-2"]);
  await t.call(SCREENER, "/api/case-tag", { ids: ["c2"], tag: "serious:hospitalization", remove: true }); assert.equal((await t.state()).cases[1].tags.length, 0);
  const f = (await t.call(MEDICAL, "/api/folder-save", { name: "Neurotoxicity review" })).body; assert.ok(f.id); assert.equal((await t.call(SCREENER, "/api/folder-save", { name: "Mine" })).status, 403); assert.equal((await t.call(MEDICAL, "/api/folder-save", { name: "neurotoxicity REVIEW" })).status, 409);
  assert.equal((await t.call(MEDICAL, "/api/case-folder", { ids: ["c1", "c2"], folderId: f.id })).body.moved, 2);
  assert.deepEqual((await t.call(MANAGER, "/api/search", { q: "", filters: { folder: f.id } })).body.cases.map(c => c.number).sort(), ["LS-1", "LS-2"]);
  assert.equal((await t.call(MEDICAL, "/api/folder-delete", { id: f.id })).status, 403); assert.equal((await t.call(MANAGER, "/api/folder-delete", { id: f.id })).body.unfiled, 2);
  const log = await auditActions(t); for (const a of ["case.tag_added", "case.tag_removed", "folder.created", "case.folder_set", "folder.deleted"]) assert.ok(log.includes(a), a);
});

test("archive hides a case from working lists and editing until restored; the archive is searchable", async () => {
  const t = await setup();
  assert.equal((await t.call(SCREENER, "/api/case-archive", { ids: ["c1"], reason: "Closed out" })).status, 403);
  assert.equal((await t.call(MEDICAL, "/api/case-archive", { ids: ["c1"], reason: "no" })).status, 400);
  assert.equal((await t.call(MEDICAL, "/api/case-archive", { ids: ["c1"], reason: "Follow-up closed, case complete" })).body.changed, 1);
  assert.equal((await t.call(SCREENER, "/api/case-save", { id: "c1", status: "Draft", data: (await t.state()).cases[0].data })).status, 409);
  assert.deepEqual((await t.call(MANAGER, "/api/search", { q: "" })).body.cases.map(c => c.number).sort(), ["LS-2", "LS-3"], "archived cases are out of normal search");
  assert.deepEqual((await t.call(MANAGER, "/api/search", { q: "", filters: { archived: "yes" } })).body.cases.map(c => c.number), ["LS-1"]);
  assert.equal((await t.call(MEDICAL, "/api/case-restore", { ids: ["c1"] })).body.changed, 1); assert.equal((await t.state()).cases[0].archived, undefined);
  const log = await auditActions(t); assert.ok(log.includes("case.archived") && log.includes("case.restored"));
});

test("only a manager deletes cases, with a reason and the case number typed; approved cases must be archived first; a tombstone and audit entry remain", async () => {
  const t = await setup();
  assert.equal((await t.call(MEDICAL, "/api/cases-delete", { ids: ["c2"], reason: "Pulled in error", confirm: "LS-2" })).status, 403);
  assert.equal((await t.call(MANAGER, "/api/cases-delete", { ids: ["c2"], reason: "Pulled in error", confirm: "wrong" })).status, 400);
  assert.equal((await t.call(MANAGER, "/api/cases-delete", { ids: ["c2"], reason: "x", confirm: "LS-2" })).status, 400);
  const r = (await t.call(MANAGER, "/api/cases-delete", { ids: ["c2"], reason: "Pulled in error, wrong product", confirm: "LS-2" })).body; assert.equal(r.deleted, 1); assert.deepEqual(r.pmids, ["2"]);
  let s = await t.state(); assert.deepEqual(s.cases.map(c => c.number), ["LS-1", "LS-3"]); assert.equal(s.deletedCases[0].number, "LS-2"); assert.equal(s.deletedCases[0].deletedBy, MANAGER);
  s.cases[0].versions = [{ n: 1, action: "approved", hash: "h" }]; await t.BUCKET.put("bench.json", JSON.stringify(s));
  assert.equal((await t.call(MANAGER, "/api/cases-delete", { ids: ["c1"], reason: "Pulled in error", confirm: "LS-1" })).status, 409);
  await t.call(MANAGER, "/api/case-archive", { ids: ["c1"], reason: "Archive before deletion" });
  assert.equal((await t.call(MANAGER, "/api/cases-delete", { ids: ["c1"], reason: "Pulled in error", confirm: "LS-1" })).status, 200);
  assert.ok((await auditActions(t)).filter(a => a === "case.deleted").length === 2);
  assert.equal((await t.call(MANAGER, "/api/library-delete", { pmids: ["2"], reason: "Remove the pulled citation" })).body.deleted, 1, "after the case is gone the pulled citation can be deleted");
});

test("per-case dropdowns: seriousness and listedness are set directly, override data and tags, can be cleared, and are audited; archive takes a category", async () => {
  const t = await setup(), cl = (who, body) => t.call(who, "/api/case-classify", body);
  assert.equal((await cl(SCREENER, { ids: ["c3"], serious: "nonserious" })).status, 403);
  assert.equal((await cl(SCREENER, { ids: ["c2"], serious: "maybe" })).status, 400);
  assert.equal((await cl(SCREENER, { ids: ["c2"], serious: "serious", listedness: "unlisted" })).body.changed, 1);
  const f = async x => (await t.call(MANAGER, "/api/search", { q: "", filters: x })).body.cases.map(c => c.number).sort();
  assert.deepEqual(await f({ serious: "serious", listed: "unlisted" }), ["LS-1", "LS-2"]);
  assert.equal((await cl(SCREENER, { ids: ["c1"], serious: "nonserious" })).body.changed, 1); assert.deepEqual(await f({ serious: "nonserious" }), ["LS-1"], "the dropdown overrides the event data");
  await cl(SCREENER, { ids: ["c1"], serious: "" }); assert.equal((await t.state()).cases[0].manual, undefined); assert.deepEqual(await f({ serious: "nonserious" }), []);
  assert.equal((await cl(SCREENER, { ids: ["c1"], serious: "" })).body.changed, 0, "no change, no entry");
  assert.ok((await auditActions(t)).includes("case.classified"));
  assert.equal((await t.call(MEDICAL, "/api/case-archive", { ids: ["c1"], category: "Duplicate", note: "Same patient as LS-9" })).body.changed, 1);
  assert.deepEqual([(await t.state()).cases[0].archived.category, (await t.state()).cases[0].archived.reason], ["Duplicate", "Duplicate: Same patient as LS-9"]);
  assert.equal((await t.call(MEDICAL, "/api/case-archive", { ids: ["c2"], category: "Nonsense" })).status, 400);
});
