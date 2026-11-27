import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, withFetch, SCREENER } from "./helpers.mjs";

test("abstract screening validates source quotes and re-screens when authorised full text arrives", async () => {
  const article = { id:"1", title:"Aciclovir report", abstract:"A 40-year-old man developed rash after receiving aciclovir. Before treatment the patient had diabetes.", pubTypes:["Case Reports"] };
  const t = await makeEnv({ articles:{ 1:article }, assignments:[{ id:"a1", pmid:"1", portfolio:"Antivirals", molecules:["aciclovir"], reviewer:SCREENER, status:"Pending" }],
    settings:{ syncMode:"shadow", syncAiPortfolios:["Antivirals"], ai:{ enabled:true, monthlyTokens:50000 } } }, { OPENAI_API_KEY:"test-key" });
  const calls = [];
  const provider = async (url, init) => {
    assert.equal(new URL(url).hostname,"api.openai.com");
    const input = JSON.parse(JSON.parse(init.body).messages[1].content), row = input.rows.find(r => r.text.includes("developed rash"));
    calls.push(input.rows);
    const findings = row ? [{ id:row.id, type:"reaction", term:"rash", quote:row.text },{ id:row.id, type:"reaction", term:"sepsis", quote:"Patient had sepsis." }] : [];
    return Response.json({ choices:[{ message:{ content:JSON.stringify({ assessment:row?"signal":"no_signal", findings }) } }],usage:{ total_tokens:100 } });
  };
  const tick = () => withFetch(provider, () => t.call("","/api/synchrony-tick",{}, { Authorization:"Bearer "+t.env.RUN_TOKEN }));
  let response = await tick();
  assert.equal(response.status,200,JSON.stringify(response.body));
  assert.equal(response.body.aiScreened,1);
  let state = await t.state();
  assert.equal(state.assignments[0].aiScreen.scope,"abstract");
  assert.deepEqual(state.assignments[0].aiScreen.findings.map(f => f.term),["rash"]);
  assert.equal(state.assignments[0].disposition,undefined);
  assert.equal((await tick()).body.aiScreened,0);
  state.articles["1"].fullTextKey = "licensed.pdf";
  state.articles["1"].fullTextTextKey = "full.txt";
  state.articles["1"].fullTextRestricted = true;
  await t.BUCKET.put("full.txt","Case presentation\nA 40-year-old man developed rash after receiving aciclovir. He was discharged after two days.");
  await t.BUCKET.put("bench.json",JSON.stringify(state));
  assert.equal((await tick()).body.aiScreened,0);
  state = await t.state();
  state.settings.syncAiAuthorizedText = true;
  await t.BUCKET.put("bench.json",JSON.stringify(state));
  assert.equal((await tick()).body.aiScreened,1);
  assert.equal(calls.length,2);
  assert.ok(calls[1].some(r => r.text.includes("discharged")));
  assert.equal((await t.state()).assignments[0].aiScreen.scope,"full_text");
});
