import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, SCREENER, MEDICAL, QC, makeEnv, withFetch } from "./helpers.mjs";

const PROFILES = [{ email: MANAGER, name: "Boss", role: "manager", active: true }, { email: SCREENER, name: "Asha", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }, { email: QC, name: "Quinn", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }, { email: MEDICAL, name: "Meera", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }];
const OCR = "Aciclovir rash after treatment of herpes zoster\nAnil Rao1, Meera Das2\n1 Department of Medicine, Test Hospital, India\nCorrespondence: Anil Rao, anil.rao@example.org\n\nCase presentation. A 54-year-old man received aciclovir 800 mg orally on day 1 for herpes zoster. He had no rash on day 1. He developed a rash on day 4. Aciclovir was stopped on day 6 and the rash resolved. The authors report this as a possible adverse drug reaction to aciclovir.";
const label = (version, effective) => async url => String(url).includes("api.fda.gov") ? Response.json({ results: [{ set_id: "set-1", version, effective_time: effective, openfda: { generic_name: ["aciclovir"], brand_name: ["Zovirax"] }, adverse_reactions: ["Rash has been reported in patients receiving aciclovir."] }] }) : new Response("{}", { status: 404 });

test("a revised safety label reopens the listedness of open cases, opens one linked follow-up for a released case, and keeps the signed original", async () => {
  const t = await makeEnv({ profiles: PROFILES, memberships: [{ email: MEDICAL, portfolio: "Antivirals", role: "medical_reviewer" }, { email: QC, portfolio: "Antivirals", role: "qc" }], watches: [{ portfolio: "Antivirals", molecule: "aciclovir", query: "q" }], settings: { syncMode: "active", automation: { smpc: true, submit: false } } });
  await withFetch(label("1", "20240101"), async () => { await t.call(SCREENER, "/api/synchrony-import", { title: "Aciclovir rash", portfolio: "Antivirals", molecule: "aciclovir", text: OCR }); });
  const s0 = await t.state(), c = s0.cases[0]; assert.ok(c, "a draft exists");
  await withFetch(label("1", "20240101"), () => t.call(MANAGER, "/api/case-automate", { id: c.id }));
  const c1 = (await t.state()).cases[0]; assert.equal(c1.referenceBasis.version, "1"); assert.ok(c1.referenceBasis.events.length >= 1, "it remembers which reactions relied on the label");
  // the same label again changes nothing
  const same = await withFetch(label("1", "20240101"), () => t.call(MANAGER, "/api/synchrony", { action: "reference_check" })); assert.deepEqual(same.body.changed, []);
  // the label is revised
  const rev = await withFetch(label("2", "20251001"), () => t.call(MANAGER, "/api/synchrony", { action: "reference_check" })); assert.deepEqual(rev.body.changed, [c.number]);
  const open = (await t.state()).cases.find(x => x.id === c.id); assert.equal(open.referenceChange.status, "open"); assert.equal(open.referenceChange.to.version, "2"); assert.ok(open.followups.some(f => f.kind === "reference" && /rash/i.test(f.question)), "a task names the affected reactions");
  const v = (await t.call(MEDICAL, "/api/synchrony", { action: "view", id: c.id })).body; assert.ok(v.checks.some(x => /Reference safety information revised/.test(x.text)), "the review checks show it");
  const again = await withFetch(label("2", "20251001"), () => t.call(MANAGER, "/api/synchrony", { action: "reference_check" })); assert.deepEqual(again.body.changed, [], "replay does not repeat the change");
  const ack = await t.call(SCREENER, "/api/synchrony", { action: "reference_ack", id: c.id, note: "Rash is still listed in the revised label" }); assert.equal(ack.status, 200, JSON.stringify(ack.body));
  const done = (await t.state()).cases.find(x => x.id === c.id); assert.equal(done.referenceChange.status, "acknowledged"); assert.equal(done.referenceBasis.version, "2"); assert.ok(!done.followups.some(f => f.status === "open" && f.kind === "reference"));
  // a released case: the same change opens a linked follow-up version and leaves the original
  const st = await t.state(), orig = st.cases.find(x => x.id === c.id); orig.locked = true; orig.signatures = [{ id: "sig-1", meaning: "case_approve", superseded: null, signer_id: MEDICAL }]; orig.referenceBasis = { ...orig.referenceBasis, version: "1", effective: "20240101" }; orig.referenceChange = null;
  await t.BUCKET.put("bench.json", JSON.stringify(st));
  const rel = await withFetch(label("3", "20260101"), () => t.call(MANAGER, "/api/synchrony", { action: "reference_check" })); assert.deepEqual(rel.body.changed, [c.number]);
  const s2 = await t.state(), original = s2.cases.find(x => x.id === c.id), fu = s2.cases.filter(x => x.followUpOf === c.id || x.provenance?.followUpOfNumber === c.number);
  assert.equal(fu.length, 1, "one follow-up version"); assert.equal(original.locked, true); assert.equal(original.signatures.length, 1, "the signed original is untouched"); assert.equal(fu[0].referenceBasis.version, "3");
  assert.ok(original.links.some(l => l.kind === "has_follow_up"), "the original points to the follow-up");
  const fuEvent = fu[0].data.events[0]; assert.ok(!fuEvent.listedness?.value, "the dependent listedness field is blank for the new version");
  await withFetch(label("3", "20260101"), () => t.call(MANAGER, "/api/synchrony", { action: "reference_check" })); assert.equal((await t.state()).cases.filter(x => x.provenance?.followUpOfNumber === c.number).length, 1, "replay opens no second follow-up");
});
