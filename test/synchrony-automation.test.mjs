import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, SCREENER, MEDICAL, makeEnv, readZip, withFetch } from "./helpers.mjs";

const authors = [{ name:"Anil Rao", affiliations:["Test Hospital, India"], email:"reviewer@example.org", corresponding:true }];
const report = "Patient 1 was a 54-year-old man who received aciclovir on day 1 for herpes zoster. He had no rash on day 1. He developed a rash on day 4. Patient 2 was a 54-year-old man who received aciclovir for herpes zoster. He developed acute kidney injury on day 5.";
const article = { id:"1", title:"Aciclovir case report", abstract:"Individual reports.", authors:["Anil Rao"], pubTypes:["Case Reports"], fullTextKey:"evidence/1/report.xml", evidence:{ fulltext:{sha256:"a"}, parsed:{key:"evidence/1/parsed.json"} } };
const assignment = { id:"watch-1", pmid:"1", portfolio:"Antivirals", reviewer:SCREENER, molecules:["aciclovir"], status:"Complete", disposition:{value:"potential_icsr"} };

async function scenario(settings={ syncMode:"active" }, src=article, options={}, reportText=report) {
  const t = await makeEnv({ articles:{1:src}, settings, assignments:[assignment] }, options);
  await t.BUCKET.put("evidence/1/parsed.json", JSON.stringify({
    sections:[{path:"Case presentation", title:"Case presentation", paragraphs:[reportText]}],
    authors, correspondenceEmails:["reviewer@example.org"], correspondence:["Anil Rao"], tables:[], figures:[]
  }));
  return t;
}
test("the bounded scheduler prepares patient-specific drafts once, while shadow mode creates none", async()=>{
  const shadow = await scenario({syncMode:"shadow"});
  assert.equal((await shadow.call(MANAGER,"/api/synchrony",{action:"run"})).body.processed,1);
  assert.equal((await shadow.state()).cases.length,0);
  const t = await scenario();
  const [a,b] = await Promise.all([t.call(MANAGER,"/api/synchrony",{action:"run"}),t.call(MANAGER,"/api/synchrony",{action:"run"})]);
  assert.equal(a.status,200,JSON.stringify(a.body));
  assert.equal(b.status,200,JSON.stringify(b.body));
  const cases=(await t.state()).cases;
  assert.equal(cases.length,2,JSON.stringify((await t.state()).assignments[0].synchrony));
  assert.deepEqual(cases.map(c=>c.data.events.map(e=>e.verbatim.value)),[["rash"],["acute kidney injury"]]);
  assert.ok(cases.every(c=>c.assignee===SCREENER && c.data.minimum_criteria.overall==="supported"));
  assert.equal(cases[0].data.events[0].onset_day,4);
  assert.equal((await t.call(MANAGER,"/api/synchrony",{action:"run"})).body.created,0);
  const checks = await t.call(SCREENER,"/api/synchrony",{action:"view",id:cases[0].id});
  assert.equal(checks.status,200,JSON.stringify(checks.body));
  const first = await t.call(SCREENER,"/api/synchrony",{action:"followup_add",id:cases[0].id,note:"Confirm whether the rash resolved."});
  assert.equal(first.status,200);
  const second = await t.call(SCREENER,"/api/synchrony",{action:"followup_add",id:cases[0].id,note:"Confirm whether the rash resolved."});
  assert.equal(first.body.id,second.body.id);
  assert.equal((await t.call(SCREENER,"/api/synchrony",{action:"followup_resolve",id:cases[0].id,taskId:first.body.id,note:"The author supplied an outcome."})).status,200);
  assert.equal((await t.call(SCREENER,"/api/synchrony",{action:"package",id:cases[0].id})).status,409);
});

test("evidence revisions create a review exception without overwriting a clinician edit or duplicating drafts", async()=>{
  const t=await scenario();
  await t.call(MANAGER,"/api/synchrony",{action:"run"});
  const state=await t.state(), c=state.cases[0];
  c.notes="Reviewer notes"; state.articles[1].evidence.fulltext.sha256="b";
  await t.BUCKET.put("bench.json",JSON.stringify(state));
  await t.call(MANAGER,"/api/synchrony",{action:"run"});
  const final=await t.state();
  assert.equal(final.cases.length,2);
  assert.equal(final.cases[0].notes,"Reviewer notes");
  const response=await t.call(SCREENER,"/api/synchrony",{action:"view",id:c.id});
  assert.ok(response.body.checks.some(i=>i.text==="Full-text evidence changed"),JSON.stringify(response.body));
});

test("a current approval and signature produce one reusable package with an auditable handoff",async()=>{
  const t=await scenario();
  await t.call(MANAGER,"/api/synchrony",{action:"run"});
  const state=await t.state(), c=state.cases[0], field=value=>({value,state:"edited",evidence:[]});
  c.stage="medical_review";
  c.assignee=MANAGER;
  c.data.reporter.country=field("India");
  c.data.reporter.qualification=field("Physician");
  c.data.products[0].indication=field("herpes zoster");
  c.data.products[0].start_date=field("2026-10-01");
  c.data.events[0].onset_date=field("2026-10-04");
  c.data.events[0].outcome=field("Recovered/resolved");
  c.data.events[0].expectedness=field("Unknown");
  await t.BUCKET.put("bench.json",JSON.stringify(state));
  await t.call(MANAGER,"/api/case-dates",{caseId:c.id,awareness:"2026-11-02",note:"Article reviewed on this date"});
  await t.call(MANAGER,"/api/narrative-generate",{caseId:c.id});
  const approval=await t.call(MANAGER,"/api/case-approve",{caseId:c.id,profile:"ICH",note:"Compared the case with its evidence."});
  assert.equal(approval.status,200,JSON.stringify(approval.body));
  const pre=(await t.call(MANAGER,"/api/sign-preview",{kind:"case",id:c.id,meaning:"case_approve"})).body;
  const signed=await t.call(MANAGER,"/api/sign",{kind:"case",id:c.id,meaning:"case_approve",expected_content_sha256:pre.content_sha256,reviewed_evidence_sha256:pre.evidence_sha256},{"x-esign-reauth":"1"});
  assert.equal(signed.status,200,JSON.stringify(signed.body));
  const run=await t.call(MANAGER,"/api/synchrony",{action:"run"});
  assert.equal(run.body.packages,1,JSON.stringify(run.body));
  const pack=await t.raw(MANAGER,"/api/synchrony",{action:"package",id:c.id});
  assert.equal(pack.status,200);
  const files=readZip(await pack.arrayBuffer());
  assert.ok(files.has("E2B-R3.xml") && files.has("CIOMS-I.pdf") && files.has("narrative.txt") && files.has("line-listing.csv"));
  assert.equal(JSON.parse(files.get("manifest.json")).approvalHash,approval.body.approval.hash);
  const handoff=await t.call(MANAGER,"/api/synchrony",{action:"handoff",id:c.id,recipient:"Sponsor safety team",note:"Receipt reference 1001"});
  assert.equal(handoff.status,200,JSON.stringify(handoff.body));
  assert.equal((await t.call(MANAGER,"/api/synchrony",{action:"acknowledge",id:c.id,taskId:handoff.body.id,note:"Sponsor acknowledged"})).status,200);
  assert.equal((await t.call(MANAGER,"/api/synchrony",{action:"run"})).body.packages,0);
});

test("background OpenAI only runs for an allowed portfolio and prepares cited, unapplied fields",async()=>{
  const abstract="A 54-year-old man received aciclovir for herpes zoster. He developed a rash on day 4. He weighed 73 kg.";
  const t=await scenario({syncMode:"active",syncAiPortfolios:["Antivirals"],ai:{enabled:true,monthlyTokens:10000}}, {...article,abstract}, {OPENAI_API_KEY:"synthetic-test-key"}, report);
  let calls=0;
  await withFetch(async (url,init)=>{
    assert.equal(String(url),"https://api.openai.com/v1/chat/completions");
    calls++;
    const payload=JSON.parse(init.body), asked=JSON.parse(payload.messages[1].content);
    const sentence=asked.lines.find(r=>r.text.includes("73 kg"));
    const fields=sentence ? [{id:"p.weight",value:"73 kg",unit:sentence.id},{id:"p.country",value:"Neverland",unit:sentence.id}] : [];
    return Response.json({choices:[{message:{content:JSON.stringify({fields})}}],usage:{total_tokens:150}});
  },()=>t.call(MANAGER,"/api/synchrony",{action:"run"}));
  assert.ok(calls>0,"the allowed portfolio used the existing key");
  const first=(await t.state()).cases[0];
  assert.ok(first.preparation.ai.proposals.every(p=>p.value!=="Neverland"));
  assert.ok(!first.data.patient.weight.value,"AI proposals do not alter case data");
  await t.call(MANAGER,"/api/synchrony",{action:"run"});
  assert.equal((await t.state()).aiUsage.calls,calls);
});
