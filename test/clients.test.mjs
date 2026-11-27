import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, MANAGER, SCREENER } from "./helpers.mjs";

const seed = async () => {
  const t = await makeEnv({ watches: [{ portfolio:"CNS", molecule:"aripiprazole", query:"aripiprazole", versions:[] }, { portfolio:"CNS", molecule:"aciclovir", query:"aciclovir", versions:[] }],
    assignments: [{ id:"a1", pmid:"1", portfolio:"CNS", molecules:["aripiprazole"], status:"Pending", reviewer:SCREENER }, { id:"a2", pmid:"2", portfolio:"CNS", molecules:["aciclovir"], status:"Pending", reviewer:SCREENER }], articles:{ 1:{ id:"1", title:"A" }, 2:{ id:"2", title:"B" } } });
  return t;
};
const key = (p, m) => encodeURIComponent(p) + "|" + encodeURIComponent(m);

test("clients: create, assign molecules, queue items carry the client, unassign and delete", async () => {
  const t = await seed();
  const created = (await t.call(MANAGER, "/api/client-save", { name:"Acme Pharma", contact:"pv@acme.test" })).body;
  assert.ok(created.id);
  assert.equal((await t.call(MANAGER, "/api/client-save", { name:"acme pharma" })).body.error, "A client with that name already exists.");
  await t.call(MANAGER, "/api/client-assign", { watch:key("CNS", "aripiprazole"), client:created.id });
  let st = await (await t.get(MANAGER, "/api/state")).json();
  const a1 = st.assignments.find(a => a.id === "a1"), a2 = st.assignments.find(a => a.id === "a2");
  assert.equal(a1.client, created.id); assert.equal(a2.client, "");
  assert.deepEqual(st.clients[0].molecules, [{ portfolio:"CNS", molecule:"aripiprazole" }]);
  await t.call(MANAGER, "/api/client-assign", { watch:key("CNS", "aripiprazole"), client:"" });
  st = await (await t.get(MANAGER, "/api/state")).json(); assert.equal(st.assignments.find(a => a.id === "a1").client, "");
  await t.call(MANAGER, "/api/client-assign", { watch:key("CNS", "aciclovir"), client:created.id });
  await t.call(MANAGER, "/api/client-delete", { id:created.id });
  st = await (await t.get(MANAGER, "/api/state")).json(); assert.equal(st.clients.length, 0); assert.equal(st.assignments.find(a => a.id === "a2").client, "");
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
  st = await (await t.get(SCREENER, "/api/state")).json(); assert.equal(st.clientAdmin, false); assert.ok(st.watches.every(w => !w.query && w.portfolio === "CNS"), "only the molecule names of their own portfolios, for Search & Pull, never the queries");
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
