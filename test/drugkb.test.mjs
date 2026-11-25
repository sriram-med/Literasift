// Drug and brand-name knowledge base and universal search. A fake RxNorm / openFDA stands in for the internet. Synthetic fixtures only.
import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, SCREENER, makeEnv, withFetch } from "./helpers.mjs";

function fakeSources() {
  const calls = [];
  const handler = async url => {
    const u = new URL(String(url)); calls.push(u.host + u.pathname); const q = u.searchParams, J = o => new Response(JSON.stringify(o), { status: 200 });
    if (u.host === "rxnav.nlm.nih.gov") {
      if (u.pathname.endsWith("/rxcui.json")) { const n = (q.get("name") || "").toLowerCase(); return J({ idGroup: n === "aripiprazole" ? { rxnormId: ["89013"] } : n === "abilify" ? { rxnormId: ["213169"] } : n === "olanzapine" ? { rxnormId: ["61381"] } : {} }); }
      if (u.pathname.endsWith("/properties.json")) { const id = u.pathname.split("/")[3]; return J({ properties: { rxcui: id, name: { 89013: "aripiprazole", 213169: "Abilify", 61381: "olanzapine" }[id], tty: id === "213169" ? "BN" : "IN" } }); }
      if (u.pathname.endsWith("/related.json")) { const id = u.pathname.split("/")[3], t = q.get("tty");
        if (t === "IN MIN") return J({ relatedGroup: { conceptGroup: [{ tty: "IN", conceptProperties: [{ rxcui: "89013", name: "aripiprazole" }] }] } });
        if (id === "89013") return J({ relatedGroup: { conceptGroup: [{ tty: "BN", conceptProperties: [{ rxcui: "1", name: "Abilify" }, { rxcui: "2", name: "Abilify Mycite" }] }, { tty: "PIN", conceptProperties: [{ rxcui: "3", name: "aripiprazole lauroxil" }] }] } });
        if (id === "61381") return J({ relatedGroup: { conceptGroup: [{ tty: "BN", conceptProperties: [{ rxcui: "4", name: "Zyprexa" }] }] } }); return J({}); }
      if (u.pathname.endsWith("/allconcepts.json")) return J({ minConceptGroup: { minConcept: [{ rxcui: "89013", name: "aripiprazole", tty: "IN" }, { rxcui: "61381", name: "olanzapine", tty: "IN" }, { rxcui: "5", name: "zolpidem", tty: "IN" }] } });
    }
    if (u.host === "api.fda.gov") return J({ results: (q.get("search") || "").includes("ARIPIPRAZOLE") ? [{ term: "ABILIFY MAINTENA", count: 4 }, { term: "ARISTADA", count: 2 }] : [] });
    return new Response("", { status: 404 });
  };
  return { handler, calls };
}
const f = x => ({ value: x });
async function setup() {
  const t = await makeEnv({ profiles: [{ email: MANAGER, name: "Boss", role: "manager", active: true }, { email: SCREENER, name: "Asha", role: "reviewer", portfolio: "CNS", active: true, capacity: 50 }],
    watches: [{ portfolio: "CNS", molecule: "aripiprazole", query: "q" }], articles: { 1: { id: "1", title: "Abilify and akathisia", abstract: "a case", authors: [] }, 2: { id: "2", title: "Olanzapine weight gain", abstract: "a case", authors: [] } },
    assignments: [{ id: "a1", pmid: "1", portfolio: "CNS", molecules: ["aripiprazole"], reviewer: SCREENER, status: "Pending" }] });
  const s = await t.state(), mk = (id, n, pmid, drug) => ({ id, number: n, pmid, portfolio: "CNS", molecule: drug, status: "Draft", assignee: SCREENER, createdBy: SCREENER, createdAt: "2026-01-01", updatedAt: "2026-01-01", history: [], versions: [], data: { patient: {}, reporter: {}, products: [{ name: f(drug), role: "suspect" }], events: [{ verbatim: f("akathisia"), seriousness: {} }] } });
  s.cases = [mk("c1", "LS-1", "1", "Abilify"), mk("c2", "LS-2", "2", "olanzapine"), mk("c3", "LS-3", "1", "aripiprazole")]; await t.BUCKET.put("bench.json", JSON.stringify(s)); return t;
}

test("a generic name is pulled with its brands and salts and each of them leads back to the ingredient; brands from openFDA are added", async () => {
  const t = await setup(), src = fakeSources();
  await withFetch(src.handler, async () => {
    const r = (await t.call(SCREENER, "/api/drug-lookup", { name: "aripiprazole" })).body;
    assert.equal(r.found, true); assert.equal(r.pulled, true); assert.deepEqual(r.brands.sort(), ["Abilify", "Abilify Maintena", "Abilify Mycite", "Aristada"]); assert.deepEqual(r.salts, ["aripiprazole lauroxil"]); assert.deepEqual(r.sources.map(x => x.name), ["RxNorm", "openFDA labels"]);
    const b = (await t.call(SCREENER, "/api/drug-lookup", { name: "ABILIFY MAINTENA" })).body; assert.equal(b.name, "aripiprazole"); assert.equal(b.matchedAs, "brand");
    const before = src.calls.length; await t.call(SCREENER, "/api/drug-lookup", { name: "abilify" }); assert.equal(src.calls.length, before, "a known, enriched name is answered from the stored list");
    assert.equal((await t.call(SCREENER, "/api/drug-lookup", { name: "notadrugxyz" })).body.found, false);
  });
  const st = (await t.call(MANAGER, "/api/drugkb-status", {})).body; assert.equal(st.ingredients, 1); assert.equal(st.brands, 4);
});

test("a brand name resolves to its ingredient through RxNorm", async () => {
  const t = await setup(); await withFetch(fakeSources().handler, async () => {
    const r = (await t.call(SCREENER, "/api/drug-lookup", { name: "Abilify" })).body; assert.equal(r.name, "aripiprazole"); assert.ok(r.brands.includes("Abilify"));
  });
});

test("sync: the manager pulls names for watchlists and cases, loads the ingredient list and enriches in restartable batches; others cannot", async () => {
  const t = await setup(), src = fakeSources();
  assert.equal((await t.call(SCREENER, "/api/drugkb-sync", { mode: "watchlist" })).status, 403);
  await withFetch(src.handler, async () => {
    const w = (await t.call(MANAGER, "/api/drugkb-sync", { mode: "watchlist" })).body; assert.ok(w.pulled >= 2, JSON.stringify(w)); assert.equal(w.remaining, 0);
    const i = (await t.call(MANAGER, "/api/drugkb-sync", { mode: "ingredients" })).body; assert.equal(i.added, 1, "olanzapine/aripiprazole already known; zolpidem is new"); 
    const e = (await t.call(MANAGER, "/api/drugkb-sync", { mode: "enrich", limit: 1 })).body; assert.equal(e.pulled, 1); assert.equal(e.remaining, 0);
  });
  const log = (await (await t.BUCKET.get("audit2/" + new Date().toISOString().slice(0, 7) + ".ndjson")).text()).split("\n").filter(Boolean).map(JSON.parse).filter(x => x.action === "drugkb.sync"); assert.equal(log.length, 3);
});

test("searching a generic finds every case with its brand names too, and the brand finds the generic; the response says what else was searched", async () => {
  const t = await setup();
  await withFetch(fakeSources().handler, async () => { await t.call(MANAGER, "/api/drugkb-sync", { mode: "watchlist" }); });
  const q = async text => (await t.call(MANAGER, "/api/search", { q: text })).body;
  let r = await q("aripiprazole"); assert.deepEqual(r.cases.map(c => c.number).sort(), ["LS-1", "LS-3"], "the Abilify case is found by the generic name"); assert.ok(r.expanded[0].alsoSearched.includes("abilify"));
  assert.deepEqual((await q("abilify")).cases.map(c => c.number).sort(), ["LS-1", "LS-3"]); assert.deepEqual((await q("drug:zolpidem")).cases.map(c => c.number), [], "drug names without cases match nothing");
  assert.deepEqual((await q("zyprexa")).cases.map(c => c.number), ["LS-2"], "Zyprexa leads to the olanzapine case");
  assert.deepEqual((await q("aristada")).articles.map(a => a.pmid), ["1"], "brand names also reach the citations of the ingredient");
});

test("names from the list can be merged into a portfolio dictionary", async () => {
  const t = await setup(); await withFetch(fakeSources().handler, async () => { await t.call(MANAGER, "/api/drugkb-sync", { mode: "watchlist" }); });
  assert.equal((await t.call(MANAGER, "/api/dictionary-from-kb", { portfolio: "CNS", names: ["nope"] })).status, 404);
  const r = (await t.call(MANAGER, "/api/dictionary-from-kb", { portfolio: "CNS", names: ["Abilify"] })).body; assert.equal(r.merged, 1);
  const d = (await t.state()).dictionaries.CNS.products[0]; assert.equal(d.name, "aripiprazole"); assert.ok(d.brands.includes("Aristada") && d.salts.includes("aripiprazole lauroxil"));
});
