import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/index.js";
import { MANAGER, SCREENER, SCREENER2, makeEnv } from "./helpers.mjs";

const field = value => ({ value, state:"edited", evidence:[] });
const article = { id:"1", title:"Case series", authors:["Listed A"], pubTypes:["Case Reports"], abstract:"Clinical cases.", fullTextTextKey:"evidence/1/full.txt" };
const ass = { id:"a1", pmid:"1", portfolio:"Test", molecules:["aciclovir"], reviewer:SCREENER, status:"Pending" };
const rec = { id:"c1", number:"LS-TEST-1", pmid:"1", portfolio:"Test", assignee:SCREENER, status:"Draft", updatedAt:"2026-11-25T00:00:00Z", provenance:{ evidence:{ fulltext:null } }, data:{ patient:{}, products:[], events:[] } };

test("affirmed onset survives earlier negation and identical demographics do not merge distinct patients", async () => {
  const t = await makeEnv({ articles:{ 1:article }, assignments:[ass] });
  await t.BUCKET.put(article.fullTextTextKey, "Case presentation\nA 54-year-old man received aciclovir on day 1. He had no rash on day 1. He developed a rash on day 4. A different 54-year-old man received aciclovir and developed acute kidney injury.");
  const x = await t.call(SCREENER, "/api/extract", { id:ass.id });
  const [first, second] = x.body.extraction.patients;
  const rash = first.events.find(e => e.term === "rash");
  assert.equal(rash.status, "candidate");
  assert.equal(rash.onset.day, 4);
  assert.deepEqual(rash.mentions.map(m => m.negated), [true, false]);
  assert.deepEqual(second.events.map(e => e.term), ["acute kidney injury"]);
  const moved = await t.call(SCREENER, "/api/patient-passage", { id:ass.id, revision:x.body.extraction.source.articleRevision, unitId:rash.onset.unitId, patientId:"new" });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const revised = (await t.call(SCREENER, "/api/extract", { id:ass.id })).body.extraction;
  assert.equal(revised.patients.find(p => p.id === moved.body.patientId).events[0].term, "rash");
});

test("E2B and the narrative retain separate assessments for two suspects and omit an unassessed pair", () => {
  const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const c = { ...rec, data:{ products:ids.map((pair_id,i) => ({ pair_id, role:"suspect", name:field("Product " + (i+1)) })), events:[{
    verbatim:field("rash"), causality_reviewer:field("Legacy result"), product_causality:{
      [ids[0]]:{ causality_reviewer:field("Possible"), causality_method:field("WHO-UMC") },
      [ids[1]]:{ causality_reviewer:field("Unlikely"), causality_method:field("WHO-UMC") }
    }
  }] } };
  const xml = worker.e2bBatch([c],{1:article});
  const assessments = [...xml.matchAll(/<causalityAssessment[\s\S]*?<\/causalityAssessment>/g)].map(m => m[0]);
  assert.equal(assessments.length,2);
  assert.match(assessments[0], /Reviewer: Possible/);
  assert.match(assessments[1], /Reviewer: Unlikely/);
  assert.doesNotMatch(xml, /Legacy result/);
  const narrative = worker.buildNarrative(c).text;
  assert.match(narrative,/Product 1 \/ rash: Possible/);
  assert.match(narrative,/Product 2 \/ rash: Unlikely/);
});

test("drafts are private and an old editor revision cannot overwrite a newer save", async () => {
  const t = await makeEnv({ articles:{ 1:article }, assignments:[ass], cases:[rec] });
  const state = await t.state();
  state.profiles.push({ email:SCREENER2, name:"Other", role:"reviewer", active:true, capacity:10 });
  await t.BUCKET.put("bench.json",JSON.stringify(state));
  const draft = { revision:rec.updatedAt, data:rec.data, notes:"Working note", status:"Draft" };
  assert.equal((await t.call(SCREENER,"/api/case-work-draft",{id:rec.id,action:"save",draft})).status,200);
  assert.equal((await t.call(SCREENER,"/api/case-work-draft",{id:rec.id,action:"get"})).body.draft.notes,"Working note");
  assert.equal((await t.call(MANAGER,"/api/case-work-draft",{id:rec.id,action:"get"})).body.draft,null);
  assert.ok((await t.call(SCREENER2,"/api/case-work-draft",{id:rec.id,action:"get"})).status>=400);
  const one = await t.call(SCREENER,"/api/case-save",{id:rec.id,notes:"New value",expectedRevision:rec.updatedAt});
  assert.equal(one.status,200,JSON.stringify(one.body));
  assert.equal((await t.call(SCREENER,"/api/case-save",{id:rec.id,notes:"Old value",expectedRevision:rec.updatedAt})).status,409);
  assert.equal((await t.state()).cases[0].notes,"New value");
});

test("replacement evidence surfaces a review difference and acknowledgement records the exact new source", async () => {
  const fresh = { ...article, evidence:{ fulltext:{ sha256:"replacement" } } };
  const t = await makeEnv({ articles:{ 1:fresh }, assignments:[ass], cases:[rec] });
  const before = await t.call(SCREENER,"/api/case-source",{id:rec.id});
  assert.equal(before.status,200,JSON.stringify(before.body));
  assert.equal(before.body.changes.changes[0].title,"Full-text evidence changed");
  assert.equal((await t.call(SCREENER,"/api/case-source-reviewed",{id:rec.id,key:before.body.changes.key,note:"Compared the revised source"})).status,200);
  const after = await t.call(SCREENER,"/api/case-source",{id:rec.id});
  assert.deepEqual(after.body.changes.changes,[]);
  assert.equal((await t.state()).cases[0].sourceReview.note,"Compared the revised source");
});
