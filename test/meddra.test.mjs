// MedDRA loading from a customer's licensed release. The fixture below is a tiny SYNTHETIC release in the MedAscii format (made-up codes and a made-up version);
// it contains no licensed MedDRA content.
import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, SCREENER, MEDICAL, makeEnv } from "./helpers.mjs";
import worker from "../worker/index.js";

const enc = s => new TextEncoder().encode(s);
const LLT = ["91000001$Status epilepticus$92000001$$$$$$$Y$$", "91000002$Epileptic status$92000001$$$$$$$N$$", "91000003$Confusion$92000002$$$$$$$Y$$", "91000004$Confusional state$92000002$$$$$$$Y$$", "91000005$Myoclonus$92000003$$$$$$$Y$$", "91000006$Rash$92000004$$$$$$$Y$$", "91000007$Acute kidney injury$92000005$$$$$$$Y$$", "91000008$Renal failure acute$92000005$$$$$$$Y$$", "91000009$Orphan term$99999999$$$$$$$Y$$"].join("\r\n") + "\r\n";
const HIER = ["92000001$93000001$94000001$95000001$Status epilepticus$Seizures and seizure disorders NEC$Seizures (incl subtypes)$Nervous system disorders$Nerv$$95000001$Y$", "92000002$93000002$94000002$95000001$Confusional state$Confusion and disorientation$Neurological disorders NEC$Nervous system disorders$Nerv$$95000001$Y$", "92000003$93000003$94000002$95000001$Myoclonus$Movement disorders$Neurological disorders NEC$Nervous system disorders$Nerv$$95000001$Y$",
  "92000004$93000004$94000003$95000002$Rash$Rashes$Skin conditions$Skin and subcutaneous tissue disorders$Skin$$95000002$Y$", "92000005$93000005$94000004$95000003$Acute kidney injury$Renal failure and impairment$Renal disorders (excl nephropathies)$Renal and urinary disorders$Renal$$95000003$Y$"].join("\r\n") + "\r\n";
function release(version = "99.1", extra = {}) {
  const files = [{ name: "MedAscii/llt.asc", data: enc(extra.llt ?? LLT) }, { name: "MedAscii/mdhier.asc", data: enc(extra.hier ?? HIER) }, { name: "MedAscii/meddra_release.asc", data: enc(extra.rel ?? version + "$English$\r\n") }, { name: "MedAscii/readme.txt", data: enc("ignored") }];
  return Buffer.from(worker.zipFiles(files)).toString("base64");
}
const upload = (t, who, body) => t.call(who, "/api/meddra-upload", { filename: "MedDRA_99_1_English.zip", licence: true, ...body });
const TWO = ["Case presentation", "Patient 1 was a 54-year-old man with chronic kidney disease who received aciclovir 800 mg orally for herpes zoster. On day 3 he developed confusion and myoclonus. Aciclovir was stopped and he recovered by day 6.", "Patient 2 was a 31-year-old woman who received aciclovir intravenously for herpes simplex encephalitis. She developed a rash on day 2 and acute kidney injury on day 4."];
async function setup() {
  const t = await makeEnv({ profiles: [{ email: MANAGER, name: "Boss", role: "manager", active: true }, { email: SCREENER, name: "Asha", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }, { email: MEDICAL, name: "Meera", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }], memberships: [{ email: MEDICAL, portfolio: "Antivirals", role: "medical_reviewer" }],
    watches: [{ portfolio: "Antivirals", molecule: "aciclovir", query: "q" }], articles: { 1: { id: "1", title: "Aciclovir in two patients", abstract: "Two cases.", authors: ["Rao A"], journal: "J Test", date: "2021", pubTypes: ["Case Reports"], evidence: { parsed: { key: "evidence/1/parsed.json" } } } },
    assignments: [{ id: "a1", pmid: "1", portfolio: "Antivirals", molecules: ["aciclovir"], reviewer: SCREENER, status: "Complete", disposition: { value: "potential_icsr", by: SCREENER } }] });
  await t.BUCKET.put("evidence/1/parsed.json", JSON.stringify({ sections: [{ path: "Case presentation", title: "Case presentation", paragraphs: TWO.slice(1) }], tables: [], figures: [], authors: [{ name: "Anil Rao", affiliations: ["Test Hospital, Pune, India"], email: "anil.rao@test-hospital.example", corresponding: true }], correspondenceEmails: ["anil.rao@test-hospital.example"], correspondence: ["Anil Rao"] })); return t;
}

test("a release is loaded only by a manager who confirms the licence; bad files are refused with a reason; the audit trail records it without the content", async () => {
  const t = await setup();
  assert.equal((await upload(t, SCREENER, { base64: release() })).status, 403);
  assert.equal((await upload(t, MANAGER, { base64: release(), licence: false })).status, 400);
  assert.match((await upload(t, MANAGER, { base64: Buffer.from("not a zip").toString("base64") })).body.error, /Could not read/);
  assert.match((await upload(t, MANAGER, { base64: release("99.1", { rel: "garbage$English$" }) })).body.error, /version/);
  assert.match((await upload(t, MANAGER, { base64: release("99.1", { llt: "" }) })).body.error, /llt\.asc and mdhier\.asc/);
  const r = await upload(t, MANAGER, { base64: release() }); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual([r.body.info.version, r.body.info.language, r.body.info.counts.llt, r.body.info.counts.pt, r.body.info.counts.soc, r.body.info.counts.orphanLlt], ["99.1", "English", 8, 5, 3, 1]);
  const st = await (await t.get(MANAGER, "/api/state")).json(); assert.equal(st.meddraInfo.version, "99.1"); assert.equal(st.meddraInfo.licenceConfirmedBy, MANAGER);
  const raw = await (await t.BUCKET.get("bench.json")).text(); assert.ok(!/Status epilepticus|Seizures and seizure/.test(raw), "dictionary content is not in the state document");
  const audit = (await (await t.BUCKET.get("audit2/" + new Date().toISOString().slice(0, 7) + ".ndjson")).text()); assert.ok(/meddra\.loaded/.test(audit) && !/epilepticus/i.test(audit));
});

test("search and coding suggestions return the full hierarchy from the loaded release, prefer current terms, and never guess", async () => {
  const t = await setup(); assert.equal((await t.call(SCREENER, "/api/meddra-search", { q: "confusion" })).status, 404); await upload(t, MANAGER, { base64: release() });
  assert.equal((await t.call(SCREENER, "/api/meddra-search", { q: "ab" })).status, 400);
  const ex = (await t.call(SCREENER, "/api/meddra-search", { q: "status epilepticus" })).body, top = ex.results[0];
  assert.deepEqual([top.match, top.llt.code, top.pt.name, top.hlt.name, top.hlgt.name, top.soc.name, top.soc.abbrev, top.version], ["exact term", "91000001", "Status epilepticus", "Seizures and seizure disorders NEC", "Seizures (incl subtypes)", "Nervous system disorders", "Nerv", "99.1"]);
  const sim = (await t.call(SCREENER, "/api/meddra-search", { q: "epileptic status" })).body.results; assert.equal(sim[0].llt.name, "Epileptic status"); assert.equal(sim[0].llt.current, false); assert.ok(sim.some(r => r.llt.name === "Status epilepticus"), "the current term is offered with the non-current one");
  assert.deepEqual((await t.call(SCREENER, "/api/meddra-search", { q: "zzzz qqqq" })).body.results, [], "no match, no guess");
  const c = (await t.call(SCREENER, "/api/meddra-search", { q: "renal failure acute" })).body.results[0]; assert.equal(c.pt.name, "Acute kidney injury");
});

test("drafts propose a MedDRA coding only for exact term matches, marked as proposed for the reviewer", async () => {
  const t = await setup(); await upload(t, MANAGER, { base64: release() });
  assert.equal((await t.call(SCREENER, "/api/drafts-create", { id: "a1", force: { P1: "Reporter confirmed by e-mail" } })).status, 200);
  const cases = (await t.state()).cases, ev = id => cases.find(c => c.provenance.patientId === id).data.events, byName = (id, n) => ev(id).find(e => e.verbatim.value === n);
  const conf = byName("P1", "confusion"); assert.deepEqual([conf.llt.value, conf.llt_code.value, conf.pt.value, conf.pt_code.value, conf.soc.value, conf.meddra_version.value, conf.pt_code.state], ["Confusion", "91000003", "Confusional state", "92000002", "Nervous system disorders", "99.1", "proposed"]);
  assert.match(conf.coding_status.value, /Proposed \(MedDRA 99\.1, exact term match/); assert.equal(byName("P1", "myoclonus").pt.value, "Myoclonus");
  assert.equal(byName("P2", "acute kidney injury").pt_code.value, "92000005");
});

test("E2B validation checks codes against the loaded release, reports the LLT as the reaction term, and warns about PT-only codes and version differences", async () => {
  const t = await setup(); await upload(t, MANAGER, { base64: release() }); await t.call(SCREENER, "/api/drafts-create", { id: "a1", force: { P1: "Reporter confirmed by e-mail" } });
  const rec = (await t.state()).cases.find(c => c.provenance.patientId === "P1"), issues = async data => { const s = await t.state(); s.cases.find(c => c.id === rec.id).data = data; await t.BUCKET.put("bench.json", JSON.stringify(s)); return (await t.call(MEDICAL, "/api/e2b-validate", { caseId: rec.id, profile: "EU" })).body.issues.filter(i => /E\.i\.2\.1/.test(i.field)); };
  assert.deepEqual(await issues(rec.data), [], "LLT and PT codes from the release pass");
  const bad = JSON.parse(JSON.stringify(rec.data)); bad.events[0].llt_code.value = "99999999"; const e1 = await issues(bad); assert.ok(e1.some(i => i.severity === "error" && /not in the loaded MedDRA 99\.1/.test(i.message)));
  const ptOnly = JSON.parse(JSON.stringify(rec.data)); ptOnly.events[0].llt_code = { value: null }; const e2 = await issues(ptOnly); assert.ok(e2.some(i => i.severity === "warning" && /LLT/.test(i.message)));
  const old = JSON.parse(JSON.stringify(rec.data)); old.events[0].meddra_version.value = "98.0"; assert.ok((await issues(old)).some(i => i.field === "E.i.2.1a" && /loaded release is 99\.1/.test(i.message)));
  const xml = worker.e2bBatch([{ ...rec, data: rec.data }], {}, { profile: "EU" }); assert.ok(xml.includes('code="91000003"'), "the LLT code is the reaction code in the XML"); assert.ok(!xml.includes('code="92000002"'));
});

test("a new release shows which coded events need attention: codes missing, terms no longer current, PT changes and older versions", async () => {
  const t = await setup(); await upload(t, MANAGER, { base64: release("99.1") }); await t.call(SCREENER, "/api/drafts-create", { id: "a1", force: { P1: "Reporter confirmed by e-mail" } });
  assert.deepEqual((await t.call(MANAGER, "/api/meddra-recheck", {})).body.problems, [], "nothing to fix in the release the events were coded with");
  const next = HIER.replace("92000002$93000002$94000002$95000001$Confusional state", "92000002$93000002$94000002$95000001$Confusional state"), llt2 = LLT.replace("91000003$Confusion$92000002$$$$$$$Y$$", () => "91000003$Confusion$92000002$$$$$$$N$$").replace("91000005$Myoclonus$92000003$$$$$$$Y$$\r\n", "");
  await upload(t, MANAGER, { base64: release("99.2", { llt: llt2, hier: next }) });
  const r = (await t.call(MANAGER, "/api/meddra-recheck", {})).body; assert.equal(r.version, "99.2"); const by = n => r.problems.find(p => p.verbatim === n);
  assert.ok(by("confusion").issues.includes("LLT is no longer current")); assert.ok(by("myoclonus").issues.some(i => /not in release 99\.2/.test(i))); assert.ok(by("confusion").issues.some(i => /coded with 99\.1/.test(i)));
  assert.equal((await t.call(SCREENER, "/api/meddra-recheck", {})).status, 403); assert.equal((await t.call(MEDICAL, "/api/meddra-recheck", {})).status, 200);
});

test("removing the release removes the dictionary and leaves case codes untouched", async () => {
  const t = await setup(); await upload(t, MANAGER, { base64: release() }); await t.call(SCREENER, "/api/drafts-create", { id: "a1", force: { P1: "Reporter confirmed by e-mail" } });
  assert.equal((await t.call(SCREENER, "/api/meddra-clear", {})).status, 403); assert.equal((await t.call(MANAGER, "/api/meddra-clear", {})).status, 200);
  assert.equal((await t.call(SCREENER, "/api/meddra-search", { q: "confusion" })).status, 404); assert.equal((await t.state()).meddra, undefined);
  assert.equal((await t.state()).cases.find(c => c.provenance.patientId === "P1").data.events[0].pt_code.value, "92000002");
});
