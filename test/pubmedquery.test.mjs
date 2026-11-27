// Adopted from the PubmedAPI tutorial (TLDWTutorials/PubmedAPI, MIT): author + Title/Abstract topic queries and an Excel export with its columns,
// run through LiteraSift's own reconciled pull engine.
import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, SCREENER, fakeNcbi, withFetch, makeEnv, readZip } from "./helpers.mjs";
import worker from "../worker/index.js";

const dAgo = n => new Date(Date.now() + 5.5 * 3600000 - n * 86400000).toISOString().slice(0, 10);

test("authors and topics build the tutorial's query: authors ORed with [Author], topics ORed with [Title/Abstract], the groups ANDed", async () => {
  const t = await makeEnv({});
  const r = await t.call(MANAGER, "/api/build-query", { authors: "Bryan Holland, Mehmet Oz\nAnthony Fauci", topics: "RNA, cardiovascular disease" });
  assert.equal(r.body.query, '("Bryan Holland"[Author] OR "Mehmet Oz"[Author] OR "Anthony Fauci"[Author]) AND (RNA[Title/Abstract] OR "cardiovascular disease"[Title/Abstract])');
  assert.equal((await t.call(MANAGER, "/api/build-query", { topics: "RNA" })).body.query, "(RNA[Title/Abstract])");
  assert.equal((await t.call(MANAGER, "/api/build-query", {})).status, 400);
});

test("a PubMed query pull runs the exact expression with the chosen dates, is reconciled PMID by PMID, and lands in the portfolio queue", async () => {
  const t = await makeEnv({});
  const recs = Array.from({ length: 7 }, (_, i) => ({ pmid: String(100 + i), date: dAgo(2 + i * 3) })), ncbi = fakeNcbi(recs);
  const r = await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/pull-query", { query: '("calcium acetate"[tiab]) AND hyperphosphatemia', portfolio: "Renal", label: "Binders", from: dAgo(30), to: dAgo(0), dateField: "pdat" }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const x = r.body.results[0];
  assert.equal(x.complete, true, JSON.stringify(x)); assert.equal(x.expected, 7); assert.equal(x.withCitation, 7); assert.equal(x.linked, 7); assert.equal(x.mode, "custom");
  assert.ok(x.term.startsWith('(("calcium acetate"[tiab]) AND hyperphosphatemia) AND (') && x.term.includes("[dp]") && !x.term.includes("[crdt]"), x.term);
  const st = await t.state(); assert.equal(st.assignments.filter(a => a.portfolio === "Renal" && a.molecules.includes("Binders")).length, 7);
  assert.equal(st.runs.find(run => run.id === x.runId).snapshot.term, x.term);
  // a person who is not a manager pulls only into a portfolio they work in
  assert.equal((await withFetch(ncbi.handler, () => t.call(SCREENER, "/api/pull-query", { query: "x", portfolio: "Elsewhere" }))).status, 400);
  // built from authors and topics when no query is typed
  const b = await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/pull-query", { authors: "Anthony Fauci", topics: "RNA", portfolio: "Renal", from: dAgo(30), to: dAgo(0) }));
  assert.ok(b.body.results[0].term.includes('"Anthony Fauci"[Author]') && b.body.results[0].term.includes("RNA[Title/Abstract]"));
});

test("the Excel export has the tutorial's columns, one row per stored article, and every author's affiliation", async () => {
  const t = await makeEnv({});
  const recs = [{ pmid: "501", date: dAgo(2), title: "Calcium acetate and phosphate" }, { pmid: "502", date: dAgo(3) }], ncbi = fakeNcbi(recs);
  const handler = async (u, i) => { const res = await ncbi.handler(u, i); if (!String(u).includes("efetch")) return res;
    const xml = (await res.text()).replace(/<\/AuthorList>/, '<Author><LastName>Second</LastName><Initials>B</Initials><AffiliationInfo><Affiliation>Dhaka Medical College &amp; Hospital</Affiliation></AffiliationInfo></Author></AuthorList>');
    return new Response(xml); };
  const x = (await withFetch(handler, () => t.call(MANAGER, "/api/pull-query", { query: "calcium acetate", portfolio: "Renal", from: dAgo(10), to: dAgo(0) }))).body.results[0];
  const res = await worker.fetch(new Request("http://localhost/api/pull-xlsx", { method: "POST", headers: { "oai-authenticated-user-email": MANAGER, "content-type": "application/json" }, body: JSON.stringify({ runIds: [x.runId] }) }), t.env);
  assert.equal(res.status, 200); assert.match(res.headers.get("content-type"), /spreadsheetml/);
  const files = readZip(new Uint8Array(await res.arrayBuffer())), names = [...files.keys()];
  for (const f of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/worksheets/sheet1.xml"]) assert.ok(names.includes(f), f);
  const sheet = files.get("xl/worksheets/sheet1.xml").toString("utf8"), cells = [...sheet.matchAll(/<t xml:space="preserve">([^<]*)<\/t>/g)].map(m => m[1]);
  assert.deepEqual(cells.slice(0, 8), ["PMID", "Title", "Abstract", "Authors", "Journal", "Keywords", "URL", "Affiliations"]);
  assert.equal((sheet.match(/<row /g) || []).length, 3, "a header and two articles");
  assert.ok(cells.includes("https://pubmed.ncbi.nlm.nih.gov/501/")); assert.ok(sheet.includes("Dhaka Medical College &amp; Hospital"), "every author's affiliation is listed");
});
