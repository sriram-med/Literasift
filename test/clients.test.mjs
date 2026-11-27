import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, MANAGER, SCREENER } from "./helpers.mjs";

const seed = async () => {
  const t = await makeEnv({ watches: [{ portfolio:"CNS", molecule:"aripiprazole", query:"aripiprazole", versions:[] }, { portfolio:"CNS", molecule:"aciclovir", query:"aciclovir", versions:[] }],
    assignments: [{ id:"a1", pmid:"1", portfolio:"CNS", molecules:["aripiprazole"], status:"Pending", reviewer:SCREENER }, { id:"a2", pmid:"2", portfolio:"CNS", molecules:["aciclovir"], status:"Pending", reviewer:SCREENER }], articles:{ 1:{ id:"1", title:"A" }, 2:{ id:"2", title:"B" } } });
  return t;
};
const key = (p, m) => encodeURIComponent(p) + "|" + encodeURIComponent(m);

test("clients replace portfolios: every molecule belongs to a client, moving a molecule moves its queue items, deleting a client moves its molecules to No client", async () => {
  const t = await seed();
  // the former portfolio "CNS" became a client of the same name, with both molecules and their queue items
  let st = await (await t.get(MANAGER, "/api/state")).json(); const cns = st.clients.find(c => c.name === "CNS");
  assert.ok(cns, "a client was created from the former portfolio"); assert.equal(st.assignments.find(a => a.id === "a1").client, cns.id);
  const created = (await t.call(MANAGER, "/api/client-save", { name:"Acme Pharma", contact:"pv@acme.test" })).body;
  assert.ok(created.id);
  assert.equal((await t.call(MANAGER, "/api/client-save", { name:"acme pharma" })).body.error, "A client with that name already exists.");
  await t.call(MANAGER, "/api/client-assign", { watch:key("CNS", "aripiprazole"), client:created.id });
  st = await (await t.get(MANAGER, "/api/state")).json();
  const a1 = st.assignments.find(a => a.id === "a1"), a2 = st.assignments.find(a => a.id === "a2");
  assert.equal(a1.client, created.id); assert.equal(a1.portfolio, "Acme Pharma", "the queue item moved with its molecule"); assert.equal(a1.reviewer, SCREENER, "and kept its reviewer");
  assert.equal(a2.client, cns.id); assert.equal(a2.portfolio, "CNS");
  assert.deepEqual(st.clients.find(c => c.id === created.id).molecules, [{ portfolio:"Acme Pharma", molecule:"aripiprazole" }]);
  // renaming a client renames its group everywhere
  await t.call(MANAGER, "/api/client-save", { id:created.id, name:"Acme" });
  st = await (await t.get(MANAGER, "/api/state")).json(); assert.equal(st.assignments.find(a => a.id === "a1").portfolio, "Acme"); assert.ok(st.watches.some(w => w.portfolio === "Acme" && w.molecule === "aripiprazole"));
  // taken out of its client, a molecule goes to No client
  await t.call(MANAGER, "/api/client-assign", { watch:key("Acme", "aripiprazole"), client:"" });
  st = await (await t.get(MANAGER, "/api/state")).json(); assert.equal(st.assignments.find(a => a.id === "a1").client, ""); assert.equal(st.assignments.find(a => a.id === "a1").portfolio, "No client");
  await t.call(MANAGER, "/api/client-assign", { watch:key("CNS", "aciclovir"), client:created.id });
  await t.call(MANAGER, "/api/client-delete", { id:created.id });
  st = await (await t.get(MANAGER, "/api/state")).json(); assert.ok(!st.clients.some(c => c.id === created.id)); assert.equal(st.assignments.find(a => a.id === "a2").client, ""); assert.equal(st.assignments.find(a => a.id === "a2").portfolio, "No client");
  assert.ok(st.watches.some(w => w.molecule === "aciclovir"), "molecules are kept when a client is removed");
});

test("clients: only managers manage them; re-saving a watchlist keeps its client", async () => {
  const t = await seed();
  const c = (await t.call(MANAGER, "/api/client-save", { name:"Beta" })).body;
  assert.equal((await t.raw(SCREENER, "/api/client-save", { name:"X" })).status, 403);
  await t.call(MANAGER, "/api/client-assign", { watch:key("CNS", "aciclovir"), client:c.id });
  await t.call(MANAGER, "/api/watch", { portfolio:"CNS", molecule:"aciclovir", query:"aciclovir OR acyclovir" });
  const st = await (await t.get(MANAGER, "/api/state")).json();
  assert.equal(st.assignments.find(a => a.id === "a2").client, c.id);
  assert.equal((await t.call(MANAGER, "/api/client-assign", { watch:key("CNS", "aciclovir"), client:"nope" })).body.error, "Choose a client.");
});

test("clients: a user can manage clients only after a manager allows it, and revoking removes it", async () => {
  const t = await seed();
  const key2 = key("CNS", "aripiprazole");
  assert.equal((await t.raw(SCREENER, "/api/client-save", { name:"Gamma" })).status, 403);
  assert.equal((await t.raw(SCREENER, "/api/client-permission", { email:SCREENER, allowed:true })).status, 403, "users cannot grant themselves");
  assert.equal((await t.call(MANAGER, "/api/client-permission", { email:MANAGER, allowed:true })).body.error, "Choose a team member (not a manager).");
  await t.call(MANAGER, "/api/client-permission", { email:SCREENER, allowed:true });
  let st = await (await t.get(SCREENER, "/api/state")).json();
  assert.equal(st.clientAdmin, true); assert.ok(st.watches.length && !st.watches[0].query, "only names are exposed, not queries");
  const c = (await t.call(SCREENER, "/api/client-save", { name:"Gamma" })).body;
  assert.ok(c.id);
  assert.equal((await t.call(SCREENER, "/api/client-assign", { watch:key2, client:c.id })).status, 200);
  assert.equal((await t.raw(SCREENER, "/api/watch", { portfolio:"CNS", molecule:"x", query:"x" })).status, 403, "still cannot edit watchlists");
  await t.call(MANAGER, "/api/profile", { email:SCREENER, name:"Asha", capacity:99, portfolio:"" });
  st = await (await t.get(SCREENER, "/api/state")).json(); assert.equal(st.clientAdmin, true, "saving the profile keeps the permission");
  await t.call(MANAGER, "/api/client-permission", { email:SCREENER, allowed:false });
  assert.equal((await t.raw(SCREENER, "/api/client-save", { name:"Delta" })).status, 403);
  st = await (await t.get(SCREENER, "/api/state")).json(); assert.equal(st.clientAdmin, false); assert.ok(st.watches.length && st.watches.every(w => !w.query), "only the molecule names of their own clients, for Search & Pull, never the queries");
});

import worker from "../worker/index.js";
test("library: client layout groups Client / Molecule / range, and picks up clients added later", () => {
  const state = { watches:[{ portfolio:"CNS", molecule:"aripiprazole", client:"c1" }, { portfolio:"CNS", molecule:"metformin" }], clients:[{ id:"c1", name:"Acme Pharma" }],
    runs:[{ status:"Imported", source:"PubMed", portfolio:"CNS", molecule:"aripiprazole", from:"2026-01-01", to:"2026-01-31", ids:["1", "2"] }, { status:"Imported", source:"PubMed", portfolio:"CNS", molecule:"metformin", from:"2026-01-01", to:"2026-01-31", ids:["3"] }], articles:{} };
  const out = worker.libraryLayout(state, "client");
  assert.deepEqual([...new Set(out.map(e => e.folder))].sort(), ["Acme Pharma/aripiprazole/2026-01-01_to_2026-01-31", "No client/metformin/2026-01-01_to_2026-01-31"]);
  state.clients.push({ id:"c2", name:"Beta" }); state.watches[1].client = "c2";
  assert.ok(worker.libraryLayout(state, "client").some(e => e.folder.startsWith("Beta/metformin/")));
  assert.ok(worker.libraryLayout(state).every(e => e.folder.startsWith("PubMed/")), "the default layout is unchanged");
});

test("the Library includes stored assignments and partial pulls without losing repulled ranges", () => {
  const portfolio = "Renal", molecule = "Calcium acetate";
  const state = { watches:[{ portfolio,molecule,client:"square" }], clients:[{ id:"square",name:"Square" }],
    articles:{ "1":{ id:"1" }, "2":{ id:"2" }, "3":{ id:"3" } },
    runs:[{ status:"Running", portfolio,molecule,from:"2026-11-21",to:"2026-11-24",ids:["1","2"] },
      { status:"Imported", portfolio,molecule,from:"2026-11-20",to:"2026-11-22",ids:["1"] }],
    assignments:[{ portfolio,molecules:[molecule],pmid:"1",ird:"2026-11-22" },{ portfolio,molecules:[molecule],pmid:"3",ird:"2026-11-23" }] };
  const entries = worker.libraryLayout(state,"client");
  assert.equal(entries.filter(e => e.pmid === "1").length,2);
  assert.equal(entries.find(e => e.pmid === "2").range,"2026-11-21_to_2026-11-24");
  assert.equal(entries.find(e => e.pmid === "3").range,"Received 2026-11");
  assert.ok(entries.every(e => e.client === "Square"));
});

test("migration from portfolios to clients: molecules follow their client, duplicate queue items merge keeping the review, roles follow to every client, and it runs once", async () => {
  const t = await makeEnv({ clients: [{ id: "acme", name: "Acme" }, { id: "beta", name: "Beta" }],
    watches: [{ portfolio: "CNS", molecule: "a", query: "a", client: "acme" }, { portfolio: "CNS", molecule: "b", query: "b", client: "beta" }, { portfolio: "Renal", molecule: "c", query: "c" }, { portfolio: "Acme Old", molecule: "d", query: "d", client: "acme" }],
    assignments: [{ id: "x1", pmid: "9", portfolio: "CNS", molecules: ["a"], status: "Pending" }, { id: "x2", pmid: "9", portfolio: "Acme Old", molecules: ["d"], status: "Complete", reviewer: SCREENER, disposition: { value: "not_relevant" } }, { id: "x3", pmid: "8", portfolio: "Renal", molecules: ["c"], status: "Pending" }],
    memberships: [{ email: SCREENER, portfolio: "CNS", role: "screener" }],
    cases: [{ id: "k1", number: "LS-1", pmid: "9", portfolio: "Acme Old", molecule: "d", status: "Draft", history: [], versions: [], data: {}, provenance: { assignmentId: "x1" } }] });
  const st = await (await t.get(MANAGER, "/api/state")).json();
  const w = m => st.watches.find(x => x.molecule === m);
  assert.equal(w("a").portfolio, "Acme"); assert.equal(w("b").portfolio, "Beta"); assert.equal(w("d").portfolio, "Acme");
  assert.equal(w("c").portfolio, "Renal"); assert.ok(st.clients.some(c => c.name === "Renal"), "a portfolio without a client became a client");
  const nine = st.assignments.filter(a => a.pmid === "9"); assert.equal(nine.length, 1, "the two queue items for PMID 9 in Acme are one now");
  assert.equal(nine[0].id, "x2", "the reviewed one is kept"); assert.deepEqual(nine[0].molecules.sort(), ["a", "d"]); assert.equal(nine[0].reviewer, SCREENER);
  assert.equal(st.cases.find(c => c.id === "k1").portfolio, "Acme");
  const raw = JSON.parse(await (await t.env.BUCKET.get("bench.json")).text());
  assert.ok(!raw.schema || raw.schema.grouping !== "client" || raw.cases[0].provenance.assignmentId === "x2");
  // saved on the next change, and not run again
  await t.call(MANAGER, "/api/client-save", { name: "Gamma" });
  const saved = JSON.parse(await (await t.env.BUCKET.get("bench.json")).text());
  assert.equal(saved.schema.grouping, "client"); assert.equal(saved.cases[0].provenance.assignmentId, "x2");
  assert.deepEqual(saved.memberships.filter(m => m.email === SCREENER).map(m => m.portfolio).sort(), ["Acme", "Beta"], "a role in a portfolio now applies to each client it contained");
  const ids = saved.clients.map(c => c.id).join(); await t.call(MANAGER, "/api/client-save", { name: "Delta" });
  assert.ok(JSON.parse(await (await t.env.BUCKET.get("bench.json")).text()).clients.map(c => c.id).join().startsWith(ids), "client ids are stable");
});

test("a removed client stays removed even when its old articles, pulls and roles still carry its name", async () => {
  const { MANAGER, makeEnv: mk } = await import("./helpers.mjs");
  const t = await mk({ clients: [{ id: "u", name: "USV" }], watches: [],
    assignments: [{ id: "a1", pmid: "1", portfolio: "USV", molecules: ["gone molecule"], status: "New" }], runs: [{ id: "r1", portfolio: "USV", molecule: "gone molecule", ids: ["1"] }],
    memberships: [{ email: "asha@example.org", portfolio: "USV", role: "reviewer" }], schema: { grouping: "client" } });
  const r = await t.call(MANAGER, "/api/client-delete", { id: "u" }); assert.equal(r.status, 200);
  let st = await t.state();
  assert.deepEqual(st.clients, [], "not re-created");
  assert.equal(st.assignments[0].portfolio, "No client"); assert.equal(st.runs[0].portfolio, "No client");
  // a client with the same name can be made again on purpose
  await t.call(MANAGER, "/api/client-save", { name: "USV" }); st = await t.state();
  assert.deepEqual(st.clients.map(c => c.name), ["USV"]); assert.deepEqual(st.retiredClients, []);
});

test("molecules without a client can be deleted in one go; articles only they pulled are listed for deletion, others are kept", async () => {
  const t = await makeEnv({ clients: [{ id: "u", name: "USV" }], schema: { grouping: "client" },
    watches: [{ portfolio: "No client", molecule: "a", query: "a", client: null }, { portfolio: "No client", molecule: "b", query: "b", client: null }, { portfolio: "USV", molecule: "c", query: "c", client: "u" }],
    articles: { 1: { pmid: "1" }, 2: { pmid: "2" }, 3: { pmid: "3" } },
    assignments: [{ id: "x1", pmid: "1", portfolio: "No client", molecules: ["a"] }, { id: "x2", pmid: "2", portfolio: "No client", molecules: ["a"] }, { id: "x3", pmid: "2", portfolio: "USV", molecules: ["c"] }, { id: "x4", pmid: "3", portfolio: "No client", molecules: ["b"] }],
    cases: [{ id: "k", pmid: "3" }] });
  const k = m => encodeURIComponent("No client") + "|" + m;
  assert.equal((await t.call(SCREENER, "/api/delete-watches", { watches: [k("a")] })).status, 403);
  assert.equal((await t.call(MANAGER, "/api/delete-watches", { watches: [encodeURIComponent("USV") + "|c"] })).status, 400, "a molecule with a client is not mass-deleted");
  const r = await t.call(MANAGER, "/api/delete-watches", { watches: [k("a"), k("b")] });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.deleted, 2);
  assert.deepEqual(r.body.orphanPmids, ["1"], "2 is also pulled for c, 3 has a case");
  assert.deepEqual((await t.state()).watches.map(w => w.molecule), ["c"]);
});

test("articles per drug for one week: pulled into the app, and PubMed's count with the drug's saved search", async () => {
  const { fakeNcbi, withFetch } = await import("./helpers.mjs");
  const t = await makeEnv({ clients: [{ id: "u", name: "USV" }], schema: { grouping: "client" },
    watches: [{ portfolio: "USV", molecule: "acarbose", query: "((acarbose))", names: [], client: "u" }, { portfolio: "USV", molecule: "voglibose", query: "((voglibose))", names: [], client: "u" }],
    articles: { 1: { pmid: "1" }, 2: { pmid: "2" }, 3: { pmid: "3" } },
    assignments: [{ id: "a", pmid: "1", portfolio: "USV", molecules: ["acarbose"], ird: "2026-11-17T10:00:00Z" }, { id: "b", pmid: "2", portfolio: "USV", molecules: ["acarbose"], ird: "2026-11-23T10:00:00Z" },
      { id: "c", pmid: "3", portfolio: "USV", molecules: ["acarbose"], ird: "2026-11-24T10:00:00Z" }] });
  const r = await t.call(MANAGER, "/api/drug-week-stats", { client: "u", from: "2026-11-16", to: "2026-11-22" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.rows.map(x => [x.molecule, x.pulled, x.total]), [["acarbose", 1, 3], ["voglibose", 0, 0]]);
  assert.equal(r.body.totals.pulled, 1);
  const ncbi = fakeNcbi([{ pmid: "9", date: "2026-11-18" }, { pmid: "8", date: "2026-11-20" }]);
  const p = await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/drug-week-stats", { client: "u", from: "2026-11-16", to: "2026-11-22", pubmed: true }));
  assert.equal(p.body.rows[0].pubmed, 2); assert.ok(p.body.rows[0].term.includes("2026/11/16[crdt]:2026/11/22[crdt]"), p.body.rows[0].term);
  assert.equal((await t.call(SCREENER, "/api/drug-week-stats", { client: "u", from: "2026-11-16", to: "2026-11-22" })).status, 403);
});
