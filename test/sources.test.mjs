// Springer Nature, Adis journals, Embase and AdisInsight as Discover / Other sources (network mocked).
import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, makeEnv, withFetch } from "./helpers.mjs";

const springerBody = { records: [{ title: "Lactic acidosis with metformin: a case report", creators: [{ creator: "Rao, A" }], publicationName: "Reactions Weekly", publicationDate: "2026-11-20", doi: "10.1007/s40278-026-0001-x", abstract: { p: ["A 60-year-old man developed lactic acidosis."] }, url: [{ format: "html", value: "https://link.springer.com/article/10.1007/s40278-026-0001-x" }] }] };
const embaseBody = { header: { hits: 1 }, results: [{ itemInfo: {}, title: "Metformin-associated lactic acidosis in CKD", authors: [{ name: "Li B" }], sourceTitle: "Kidney Int", publicationYear: "2026", doi: "10.1016/j.kint.2026.01.001", pmid: "43000001", abstract: "A case." }] };

test("Springer, Adis, Embase and AdisInsight results reach Discover; keys come from Settings; missing keys are reported", async () => {
  const t = await makeEnv({});
  const calls = [];
  const fake = async (u, init) => { const s = String(u); calls.push({ s, h: init?.headers || {} });
    if (s.includes("api.springernature.com")) return new Response(JSON.stringify(springerBody), { status: 200 });
    if (s.includes("api.elsevier.com/content/embase")) return new Response(JSON.stringify(embaseBody), { status: 200 });
    if (s.includes("unpaywall")) return new Response("{}", { status: 404 });
    return new Response("{}", { status: 404 }); };
  const none = await withFetch(fake, () => t.call(MANAGER, "/api/discover", { q: "metformin lactic acidosis", sources: ["springer", "embase", "adisinsight"] }));
  const text = JSON.stringify(none.body);
  assert.match(text, /Springer Nature API key/); assert.match(text, /Elsevier API key with Embase access/);
  assert.ok(none.body.results.some(r => /AdisInsight/.test(r.title)), "AdisInsight link needs no key");
  await t.call(MANAGER, "/api/settings", { springerApiKey: "S".repeat(32), elsevierApiKey: "E".repeat(32), elsevierInsttoken: "I".repeat(20) });
  calls.length = 0;
  const r = await withFetch(fake, () => t.call(MANAGER, "/api/discover", { q: "metformin lactic acidosis", sources: ["springer", "adis", "embase"], from: "2026-11-01", to: "2026-11-28" }));
  const titles = r.body.results.map(x => x.title);
  assert.ok(titles.includes("Lactic acidosis with metformin: a case report")); assert.ok(titles.includes("Metformin-associated lactic acidosis in CKD"));
  const sp = calls.filter(c => c.s.includes("springernature")).map(c => decodeURIComponent(new URL(c.s).searchParams.get("q")));
  assert.ok(sp.some(q => q.includes('pub:"Reactions Weekly"') && q.includes("onlinedatefrom:2026-11-01")), "Adis search limits to Adis journals and the dates");
  assert.ok(calls.some(c => c.s.includes("springernature") && c.s.includes("api_key=" + "S".repeat(32))));
  const em = calls.find(c => c.s.includes("embase")); assert.equal(em.h["X-ELS-APIKey"], "E".repeat(32)); assert.equal(em.h["X-ELS-Insttoken"], "I".repeat(20));
  const pm = r.body.results.find(x => x.title === "Metformin-associated lactic acidosis in CKD"); assert.equal(pm.pmid, "43000001");
});
