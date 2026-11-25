// Shared fixtures: a fake NCBI E-utilities server, a worker environment, and small builders. Synthetic data only.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import worker from "../worker/index.js";
import { FileBucket } from "../server/storage.mjs";

export const MANAGER = "boss@example.org", SCREENER = "asha@example.org", SCREENER2 = "ravi@example.org", MEDICAL = "meera@example.org", QC = "quinn@example.org";
export const pubmedXml = (pmid, { title = "Case " + pmid, abstract = "A case.", authors = ["Smith A", "Jones B"], affiliation = "Dept of Medicine, Test Hospital, Pune, India" } = {}) =>
  `<PubmedArticle><MedlineCitation><PMID Version="1">${pmid}</PMID><Article><ArticleTitle>${title}</ArticleTitle><Abstract><AbstractText>${abstract}</AbstractText></Abstract><AuthorList>${authors.map((a, i) => `<Author><LastName>${a.split(" ")[0]}</LastName><Initials>${a.split(" ")[1] || ""}</Initials>${i === 0 ? `<AffiliationInfo><Affiliation>${affiliation}</Affiliation></AffiliationInfo>` : ""}</Author>`).join("")}</AuthorList><PublicationTypeList><PublicationType>Case Reports</PublicationType></PublicationTypeList></Article></MedlineCitation></PubmedArticle>`;

// records: [{ pmid, date: "YYYY-MM-DD", title?, abstract?, authors? }]. Options inject failures by window start date.
export function fakeNcbi(records, options = {}) {
  const calls = [], fails = new Map(Object.entries(options.failWindows || {}));   // "from" -> remaining failures
  const dropDetails = new Set(options.dropDetails || []), dropSummary = new Set(options.dropSummary || []), cap = options.cap || 9999;
  const handler = async url => {
    const u = new URL(String(url)); calls.push(u.pathname.split("/").pop() + " " + (u.searchParams.get("term") || u.searchParams.get("id") || ""));
    const op = u.pathname.split("/").pop();
    if (op === "esearch.fcgi") {
      const term = u.searchParams.get("term") || "", m = /(\d{4}\/\d{2}\/\d{2})\[(?:crdt|dp)\]:(\d{4}\/\d{2}\/\d{2})\[(?:crdt|dp)\]/.exec(term);
      const from = m[1].replaceAll("/", "-"), to = m[2].replaceAll("/", "-");
      if (fails.get(from) > 0) { fails.set(from, fails.get(from) - 1); return new Response("busy", { status: options.failStatus || 500 }); }
      const ids = records.filter(r => r.date >= from && r.date <= to).map(r => r.pmid);
      return new Response(JSON.stringify({ esearchresult: { count: String(ids.length), idlist: u.searchParams.get("retmax") === "0" ? [] : ids.slice(0, cap) } }), { status: 200 });
    }
    if (op === "esummary.fcgi") {
      const result = { uids: [] };
      for (const id of (u.searchParams.get("id") || "").split(",")) { const r = records.find(x => x.pmid === id); if (r && !dropSummary.has(id)) result[id] = { title: r.title || "Case " + id, fulljournalname: "J Test", pubdate: r.date, articleids: [{ idtype: "doi", value: "10.1234/" + id }], pubtype: [] }; }
      return new Response(JSON.stringify({ result }), { status: 200 });
    }
    if (op === "efetch.fcgi") {
      const ids = (u.searchParams.get("id") || "").split(",").filter(id => !dropDetails.has(id));
      return new Response("<?xml version=\"1.0\"?><PubmedArticleSet>" + ids.map(id => { const r = records.find(x => x.pmid === id); return r ? pubmedXml(id, r) : ""; }).join("") + "</PubmedArticleSet>", { status: 200 });
    }
    return new Response("", { status: 404 });
  };
  return { handler, calls };
}
export async function withFetch(handler, fn) {
  const real = globalThis.fetch; globalThis.fetch = handler;
  try { return await fn(); } finally { globalThis.fetch = real; }
}
export async function makeEnv(state = {}, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ls-p1-")), BUCKET = new FileBucket(dir + "/objects");
  const base = { profiles: [{ email: MANAGER, name: "Boss", role: "manager", active: true }, { email: SCREENER, name: "Asha", role: "reviewer", active: true, capacity: 99 }], watches: [], settings: {}, runs: [], articles: {}, assignments: [], ...state };
  await BUCKET.put("bench.json", JSON.stringify(base));
  const env = { BUCKET, RUN_TOKEN: "x".repeat(40), HOST_ACCOUNTS: true, RETRY_BASE_MS: 1, AUDIT_ANCHOR_KEY: "k".repeat(32), ...extra };
  const call = async (who, path, body = {}, headers = {}) => { const r = await worker.fetch(new Request("http://localhost" + path, { method: "POST", headers: { "oai-authenticated-user-email": who, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }), env); return { status: r.status, body: await r.json().catch(() => ({})), response: r }; };
  const get = async (who, path) => { const r = await worker.fetch(new Request("http://localhost" + path, { headers: { "oai-authenticated-user-email": who } }), env); return r; };
  const state2 = async () => JSON.parse(await (await BUCKET.get("bench.json")).text());
  return { dir, env, BUCKET, call, get, state: state2 };
}
