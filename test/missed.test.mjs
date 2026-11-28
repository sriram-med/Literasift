// Missed-article alarm: last week is searched again by date added; what PubMed has and the app does not is listed, pulled or dismissed.
import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, makeEnv, withFetch, fakeNcbi } from "./helpers.mjs";

const lastWeekDay = () => { const now = new Date(Date.now() + 5.5 * 3600000), dow = (now.getUTCDay() + 6) % 7; return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dow - 4)).toISOString().slice(0, 10); };

test("the alarm lists last week's articles the app does not hold; Pull brings them in, Dismiss clears them", async () => {
  const d = lastWeekDay();
  const t = await makeEnv({ clients: [{ id: "c1", name: "Navinta" }], watches: [{ portfolio: "Navinta", molecule: "carmustine", query: "Carmustine", client: "c1" }],
    articles: { 7001: { id: "7001", title: "Held" } }, assignments: [{ id: "a1", pmid: "7001", portfolio: "Navinta", molecules: ["carmustine"], status: "Pending" }] });
  const ncbi = fakeNcbi([{ pmid: "7001", date: d }, { pmid: "7002", date: d }, { pmid: "7003", date: d }]);
  const r = await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/missed-check", {}));
  assert.equal(r.body.articles, 2);
  let st = await (await t.get(MANAGER, "/api/state")).json();
  assert.deepEqual(st.missedAlerts[0].pmids.sort(), ["7002", "7003"]); assert.equal(st.missedAlerts[0].clientName, "Navinta");
  const p = await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/missed-pull", { id: st.missedAlerts[0].id }));
  assert.equal(p.body.added, 2);
  st = await (await t.get(MANAGER, "/api/state")).json(); assert.equal(st.missedAlerts.length, 0);
  assert.equal((await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/missed-check", {}))).body.articles, 0, "nothing missed once pulled");
  const n2 = fakeNcbi([{ pmid: "7001", date: d }, { pmid: "7009", date: d }]);
  await withFetch(n2.handler, () => t.call(MANAGER, "/api/missed-check", {}));
  st = await (await t.get(MANAGER, "/api/state")).json();
  assert.equal((await t.call(MANAGER, "/api/missed-dismiss", { id: st.missedAlerts[0].id, reason: "checked: not relevant" })).status, 200);
  assert.equal((await t.state()).missedAlerts.length, 0);
});

test("the scheduler runs the check once a day", async () => {
  const d = lastWeekDay();
  const t = await makeEnv({ clients: [{ id: "c1", name: "Navinta", autoPull: false }], watches: [{ portfolio: "Navinta", molecule: "carmustine", query: "Carmustine", client: "c1" }] }, { MISSED_CHECK: "on" });
  let st = await t.state(); st.clients[0].autoPull = true; st.settings.autoPull = false; await t.BUCKET.put("bench.json", JSON.stringify(st));
  const ncbi = fakeNcbi([{ pmid: "7005", date: d }]);
  const r = await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/scheduled", {}));
  assert.equal(r.body.missed.articles, 1);
  const again = await withFetch(ncbi.handler, () => t.call(MANAGER, "/api/scheduled", {}));
  assert.equal(again.body.missed, null, "once a day");
});
