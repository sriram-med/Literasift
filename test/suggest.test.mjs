// Suggested screening decisions: a hint the DE confirms, never a decision on its own.
import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, SCREENER, makeEnv } from "./helpers.mjs";
import worker from "../worker/index.js";
const S = worker.suggestDecision;

test("suggestions from title, abstract and publication type", () => {
  assert.equal(S({ title: "Lactic acidosis after metformin overdose", abstract: "A 64-year-old man developed severe lactic acidosis and died.", pubTypes: ["Case Reports"] }, ["metformin"]).value, "potential_icsr");
  assert.equal(S({ title: "Metformin in mice", abstract: "Metformin reduced tumour growth in mice and cell lines.", pubTypes: ["Journal Article"] }, ["metformin"]).reason, "No individual patient (aggregate or study data only)");
  assert.equal(S({ title: "Metformin and the gut microbiome", abstract: "We review how metformin changes the microbiome.", pubTypes: ["Review"] }, ["metformin"]).reason, "Not a drug safety report (review, background, or editorial)");
  assert.equal(S({ title: "Glucose control in diabetes", abstract: "Insulin lowered HbA1c in adults.", pubTypes: ["Journal Article"] }, ["metformin"]).reason, "No suspect product");
  assert.equal(S({ title: "Metformin and HbA1c in adults", abstract: "Metformin lowered HbA1c in 400 adults with type 2 diabetes.", pubTypes: ["Randomized Controlled Trial"] }, ["metformin"]).reason, "No adverse event");
  assert.equal(S({ title: "Metformin in 2000 patients", abstract: "Metformin was associated with lactic acidosis and hepatotoxicity in a cohort of patients.", pubTypes: ["Journal Article"] }, ["metformin"]).value, "aggregate_safety");
});

test("reject the ticked with their suggested reasons; others are skipped; the note says it was confirmed", async () => {
  const t = await makeEnv({ articles: { 1: { id: "1", title: "Metformin in mice", abstract: "Metformin reduced tumour growth in mice.", pubTypes: ["Journal Article"] }, 2: { id: "2", title: "Lactic acidosis with metformin", abstract: "A 64-year-old man developed lactic acidosis.", pubTypes: ["Case Reports"] } },
    assignments: [{ id: "a1", pmid: "1", portfolio: "P", molecules: ["metformin"], reviewer: SCREENER, status: "Pending" }, { id: "a2", pmid: "2", portfolio: "P", molecules: ["metformin"], reviewer: SCREENER, status: "Pending" }] });
  const st = await (await t.get(SCREENER, "/api/state")).json();
  assert.equal(st.assignments.find(a => a.id === "a1").suggest.value, "excluded"); assert.equal(st.assignments.find(a => a.id === "a2").suggest.value, "potential_icsr");
  const r = (await t.call(SCREENER, "/api/disposition-bulk", { ids: ["a1", "a2"], useSuggested: true })).body;
  assert.equal(r.done, 1); assert.equal(r.skipped[0].why, "no suggested rejection");
  const a1 = (await t.state()).assignments.find(a => a.id === "a1");
  assert.equal(a1.disposition.reason, "No individual patient (aggregate or study data only)"); assert.match(a1.disposition.note, /suggested: Animal or laboratory study; confirmed by the DE/);
  assert.equal((await t.state()).assignments.find(a => a.id === "a2").disposition, undefined, "the ICSR suggestion is never applied in bulk");
});
