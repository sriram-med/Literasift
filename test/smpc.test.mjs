import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, SCREENER, makeEnv, withFetch } from "./helpers.mjs";

const f = x => ({ value: x });
async function setup() {
  const t = await makeEnv({ watches: [{ portfolio: "Antivirals", molecule: "aciclovir", query: "a" }] }), s = await t.state();
  s.cases = [{ id: "c1", number: "LS-1", pmid: "1", portfolio: "Antivirals", molecule: "aciclovir", status: "Draft", assignee: MANAGER, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01", history: [], versions: [], stage: "medical_review",
    data: { patient: {}, reporter: {}, dates: {}, confounders: [], treatment_given: [], products: [{ role: "suspect", name: f("aciclovir") }],
      events: [{ verbatim: { value: "status epilepticus", evidence: [{ excerpt: "He developed status epilepticus on day 5 and was admitted to intensive care." }] } }, { verbatim: f("renal toxicity") }, { verbatim: f("hair colour change") }] } }];
  s.articles["1"] = { id: "1", title: "T", authors: ["Rao A"] }; await t.BUCKET.put("bench.json", JSON.stringify(s)); return t;
}
const LABEL = { results: [{ set_id: "abc-123", version: "7", effective_time: "20240101", openfda: { brand_name: ["Zovirax"], generic_name: ["acyclovir"] },
  adverse_reactions: ["The most common adverse reactions were nausea and headache. Neurotoxicity including status epilepticus has been reported. Renal toxicity was reported in patients with renal impairment."], warnings: ["Renal failure may occur."] }] };

test("SmPC lookup: reads the label online once (cached), finds events in the safety sections, and says so when it cannot", async () => {
  const t = await setup(); let calls = 0;
  const api = async url => { calls++; assert.match(String(url), /api\.fda\.gov\/drug\/label\.json/); return new Response(JSON.stringify(LABEL), { status: 200 }); };
  const body = { id: "c1", product: "aciclovir", events: [{ index: 0, verbatim: "status epilepticus" }, { index: 1, verbatim: "renal toxicity" }, { index: 2, verbatim: "hair colour change" }] };
  const r = await withFetch(api, () => t.call(MANAGER, "/api/smpc-check", body)); assert.equal(r.status, 200, JSON.stringify(r.body));
  const [a, b, c] = r.body.results;
  assert.equal(a.listedness, "listed"); assert.equal(a.sectionLabel, "Adverse reactions"); assert.match(a.quote, /status epilepticus has been reported/);
  assert.equal(b.listedness, "listed"); assert.equal(c.listedness, "not_found");
  assert.match(r.body.source.url, /dailymed\.nlm\.nih\.gov.*abc-123/); assert.match(r.body.source.region, /proxy for the EU SmPC/); assert.ok(r.body.links.ema && r.body.links.emc);
  await withFetch(api, () => t.call(MANAGER, "/api/smpc-check", body)); assert.equal(calls, 1, "the label is cached");
  const down = await withFetch(async () => { throw new Error("offline"); }, () => t.call(MANAGER, "/api/smpc-check", { ...body, product: "otherdrug" }));
  assert.equal(down.body.found, false); assert.ok(down.body.results.every(x => x.listedness === "unknown"), "no label means unknown, never 'unlisted'"); assert.match(down.body.error, /could not be reached/);
});

test("SmPC lookup: pasted SmPC section 4.8 text is checked instead, with no network call", async () => {
  const t = await setup(); let calls = 0;
  const r = await withFetch(async () => { calls++; return new Response("", { status: 500 }); }, () => t.call(MANAGER, "/api/smpc-check", { id: "c1", text: "4.8 Undesirable effects. Nervous system disorders: convulsions, encephalopathy. Renal and urinary disorders: renal toxicity (rare).", events: [{ index: 0, verbatim: "renal toxicity" }, { index: 1, verbatim: "hair colour change" }] }));
  assert.equal(calls, 0); assert.equal(r.body.results[0].listedness, "listed"); assert.equal(r.body.results[0].sectionLabel, "Pasted SmPC text"); assert.equal(r.body.results[1].listedness, "not_found");
  assert.equal((await t.raw(SCREENER, "/api/smpc-check", { id: "c1", text: "x", events: [{ verbatim: "y" }] })).status, 404, "only people who can see the case");
});

test("case assist: seriousness is detected from the case's own sentences, with its basis", async () => {
  const t = await setup(), r = await t.call(MANAGER, "/api/case-assist", { id: "c1" });
  assert.equal(r.status, 200); const e0 = r.body.events[0];
  assert.equal(e0.seriousness.flags.life_threatening, true, "intensive care"); assert.equal(e0.seriousness.flags.other_medically_important, true, "status epilepticus");
  assert.ok(e0.seriousness.basis.length >= 2); assert.equal(r.body.events[2].seriousness.flags.serious, false);
  assert.deepEqual(r.body.suspects, ["aciclovir"]); assert.equal(r.body.textSource, "citation and abstract"); assert.equal(r.body.meddraLoaded, false); assert.ok(r.body.textSource);
});
