import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, SCREENER, MEDICAL, QC, makeEnv, withFetch } from "./helpers.mjs";

const PROFILES = [{ email: MANAGER, name: "Boss", role: "manager", active: true }, { email: SCREENER, name: "Asha", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }, { email: QC, name: "Quinn", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }, { email: MEDICAL, name: "Meera", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }];
const OCR = "Aciclovir rash after treatment of herpes zoster\nAnil Rao1, Meera Das2\n1 Department of Medicine, Test Hospital, India\nCorrespondence: Anil Rao, anil.rao@example.org\n\nCase presentation. A 54-year-old man received aciclovir 800 mg orally on day 1 for herpes zoster. He had no rash on day 1. He developed a rash on day 4. Aciclovir was stopped on day 6 and the rash resolved. The authors, Anil Rao and Meera Das, report this as a possible adverse drug reaction to aciclovir.";
const env = () => makeEnv({ profiles: PROFILES, memberships: [{ email: MEDICAL, portfolio: "Antivirals", role: "medical_reviewer" }, { email: QC, portfolio: "Antivirals", role: "qc" }], watches: [{ portfolio: "Antivirals", molecule: "aciclovir", query: "q" }], settings: { syncMode: "active", automation: { smpc: false } } });

test("pasted OCR text becomes an article, a potential-ICSR assignment, stored full text and a prepared draft; replay adds nothing", async () => {
  const t = await env(), body = { title: "Aciclovir rash, scanned report", portfolio: "Antivirals", molecule: "aciclovir", text: OCR };
  const a = await t.call(SCREENER, "/api/synchrony-import", body); assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.match(a.body.pmid, /^DOC-/); assert.equal(a.body.textRead, true); assert.equal(a.body.drafts.length, 1, JSON.stringify(a.body));
  const s1 = await t.state(); assert.equal(s1.assignments.filter(x => x.pmid === a.body.pmid).length, 1); assert.equal(s1.assignments[0].disposition.value, "potential_icsr"); const ar = s1.articles[a.body.pmid]; assert.deepEqual(ar.authors, ["Anil Rao", "Meera Das"], "two authors read from the pasted header"); assert.equal(ar.authorDetails[0].corresponding, true); assert.equal(ar.authorDetails[0].email, "anil.rao@example.org"); assert.equal(s1.articles[a.body.pmid].fullTextStatus, "Captured");
  console.log("IMPORT", JSON.stringify({ drafts: a.body.drafts.length, mode: a.body.mode, issues: (s1.assignments[0].synchrony?.issues || []).map(i => i.code) }));
  const again = await t.call(SCREENER, "/api/synchrony-import", body); assert.equal(again.status, 200);
  const s2 = await t.state(); assert.equal(s2.assignments.length, 1, "no duplicate assignment"); assert.equal(s2.cases.length, s1.cases.length, "no duplicate draft"); assert.equal(Object.keys(s2.articles).length, 1);
});

test("a Discover record is sent to Synchrony with its abstract; a portfolio is required", async () => {
  const t = await env();
  assert.equal((await t.call(SCREENER, "/api/synchrony-import", { title: "x", text: OCR })).status, 400);
  const r = await t.call(SCREENER, "/api/synchrony-import", { portfolio: "Antivirals", molecule: "aciclovir", record: { title: "Aciclovir neurotoxicity in renal failure", doi: "10.1000/abc", authors: ["A Rao"], journal: "J Test", year: "2026", abstract: "A 70-year-old woman with renal failure received aciclovir and developed confusion on day 3." } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); const s = await t.state(), art = s.articles[r.body.pmid];
  assert.equal(art.doi, "10.1000/abc"); assert.match(art.abstract, /renal failure/); assert.equal(s.assignments[0].disposition.value, "potential_icsr");
});

test("AI review flags a value the patient's own sentence contradicts, and drops anything it cannot quote", async () => {
  const t = await makeEnv({ profiles: PROFILES, watches: [{ portfolio: "Antivirals", molecule: "aciclovir", query: "q" }], settings: { syncMode: "active", automation: { smpc: false }, ai: { enabled: true, monthlyTokens: 20000, perCaseTokens: 20000 } } }, { OPENAI_API_KEY: "synthetic-test-key-1234567890" });
  await t.call(SCREENER, "/api/synchrony-import", { title: "Aciclovir rash, scanned report", portfolio: "Antivirals", molecule: "aciclovir", text: OCR, aiAllowed: true });
  const c = (await t.state()).cases[0], d = JSON.parse(JSON.stringify(c.data)), f = v => ({ value: v, state: "edited", evidence: [] });
  d.events[0].onset_date = f("day 9"); d.products[0].dose = f("800 mg"); await t.call(SCREENER, "/api/case-save", { id: c.id, status: "Draft", data: d });
  let sent = "";
  const model = async (url, init) => { sent = JSON.parse(init.body).messages[1].content; const L = sent.split("\n"), n = L.findIndex(l => /developed a rash on day 4/.test(l)), ids = Object.fromEntries(L.filter(l => /^f\d+ /.test(l)).map(l => [l.split(" ").slice(1, -2).join(" "), l.split(" ")[0]]));
    const onset = Object.entries(ids).find(([k]) => /^onset/.test(k))[1], dose = Object.entries(ids).find(([k]) => /^dose/.test(k))[1];
    return Response.json({ choices: [{ message: { content: JSON.stringify({ x: [{ f: onset, p: "The article says day 4", s: n, v: "day 4" }, { f: dose, p: "Dose differs", s: n, v: "1200 mg" }] }) } }], usage: { total_tokens: 150 } }); };
  const r = await withFetch(model, () => t.call(SCREENER, "/api/case-ai-review", { id: c.id })); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.issues.length, 1, "the quote it cannot support is dropped"); assert.match(r.body.issues[0].path, /onset_date/); assert.equal(r.body.issues[0].suggestion, "day 4"); assert.match(r.body.issues[0].sentence, /day 4/);
  const again = await withFetch(model, () => t.call(SCREENER, "/api/case-ai-review", { id: c.id })); assert.equal(again.body.cached, true, "same case, same text: no tokens");
});
