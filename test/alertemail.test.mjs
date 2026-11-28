// Client PubMed alert emails (.eml): read, matched to a molecule, compared with the app; missing PMIDs pulled; weekly reconciliation.
import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, SCREENER, makeEnv, withFetch, fakeNcbi } from "./helpers.mjs";
import worker from "../worker/index.js";

const eml = (search, name, ids) => [
  "From: My NCBI <efback@ncbi.nlm.nih.gov>", "Subject: =?UTF-8?Q?What=27s_new_for_=27" + search.replace(/ /g, "_") + "=27_in_PubMed?=", "Date: Sun, 22 Nov 2026 12:51:16 +0000",
  "MIME-Version: 1.0", 'Content-Type: multipart/alternative; boundary="b1"', "", "--b1", "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: quoted-printable", "",
  "<html><body><p>Sender's message: " + name + "</p><p>Sent on Sunday, 2026 November 22</p><p>Search: " + search + " View complete results in PubMed</p>",
  '<a href=3D"https://pubmed.ncbi.nlm.nih.gov/?term=3D' + ids.join("%2C") + '&amp;sort=3D">View</a>',
  ...ids.map(id => '<a href=3D"https://pubmed.ncbi.nlm.nih.gov/' + id + '/">t</a>'), '<a href=3D"https://pubmed.ncbi.nlm.nih.gov/99999999/">similar</a>', "<p>" + ids.length + " citations</p></body></html>", "--b1--", ""].join("\r\n");

test("reads a My NCBI alert email: search, sender message, day sent and its PMIDs (not loose links)", () => {
  const e = worker.readAlertEmail(eml("Calcium chloride", "Weekly-10% Calcium Chloride Injection", ["43061685", "43059041", "43051691"]));
  assert.equal(e.search, "Calcium chloride"); assert.equal(e.name, "Weekly-10% Calcium Chloride Injection"); assert.equal(e.sent, "2026-11-22");
  assert.deepEqual(e.pmids, ["43061685", "43059041", "43051691"]); assert.equal(e.listed, 3);
});

test("upload compares each email with the app; missing PMIDs can be pulled; reconciliation lists the differences", async () => {
  const t = await makeEnv({ clients: [{ id: "c1", name: "Navinta", dateBasis: "crdt" }], watches: [{ portfolio: "Navinta", molecule: "calcium chloride", query: "Calcium chloride", client: "c1" }],
    articles: { 43061685: { id: "43061685", title: "Held" } }, assignments: [{ id: "a1", pmid: "43061685", portfolio: "Navinta", molecules: ["calcium chloride"], reviewer: "", status: "Pending" }] });
  const r = (await t.call(MANAGER, "/api/alert-emails", { client: "c1", files: [{ name: "a.eml", text: eml("Calcium chloride", "Weekly", ["43061685", "43059041", "43051691"]) }, { name: "x.eml", text: "hello" }] })).body;
  const row = r.results[0];
  assert.equal(row.molecule, "calcium chloride"); assert.equal(row.same, true); assert.equal(row.held, 1); assert.deepEqual(row.missing, ["43059041", "43051691"]);
  assert.match(r.results[1].error, /does not look like/);
  assert.equal((await t.state()).alertEmails.length, 1, "kept for the weekly reconciliation");
  const ncbi = fakeNcbi([{ pmid: "43061685", date: "2026-11-18" }, { pmid: "43059041", date: "2026-11-18" }, { pmid: "43051691", date: "2026-11-18" }, { pmid: "43000009", date: "2026-11-19" }]);
  const rec = await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/reconcile-week", { client: "c1", from: "2026-11-15", to: "2026-11-21" }));
  const x = rec.body.rows[0];
  assert.equal(x.email.count, 3); assert.equal(x.app, 1); assert.ok(x.notInApp.length >= 2); assert.match(x.reasons.join(" "), /pull them/);
  const pulled = await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/alert-emails-pull", { client: "c1", watch: row.watch, pmids: row.missing }));
  assert.equal(pulled.body.added, 2);
  const s = await t.state(); assert.ok(["43059041", "43051691"].every(id => s.assignments.some(a => a.pmid === id && a.molecules.includes("calcium chloride"))));
  const st = await t.state(); st.profiles.find(p => p.email === SCREENER).portfolio = "Elsewhere"; st.watches.push({ portfolio: "Elsewhere", molecule: "x", query: "x" }); await t.BUCKET.put("bench.json", JSON.stringify(st));
  assert.equal((await t.call(SCREENER, "/api/alert-emails", { client: "c1", files: [{ name: "a.eml", text: "x" }] })).status, 403, "only people who work on the client");
  const xl = await withFetch(ncbi.handler, () => t.raw(MANAGER, "/api/reconcile-week", { client: "c1", from: "2026-11-15", to: "2026-11-21", format: "xlsx" }));
  assert.match(xl.headers.get("content-type"), /spreadsheetml/);
});
