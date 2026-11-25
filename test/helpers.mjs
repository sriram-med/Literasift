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
  const env = { BUCKET, RUN_TOKEN: "x".repeat(40), HOST_ACCOUNTS: true, RETRY_BASE_MS: 1, NCBI_GAP_MS: 0, AUDIT_ANCHOR_KEY: "k".repeat(32), ...extra };
  const call = async (who, path, body = {}, headers = {}) => { const r = await worker.fetch(new Request("http://localhost" + path, { method: "POST", headers: { "oai-authenticated-user-email": who, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }), env); return { status: r.status, body: await r.json().catch(() => ({})), response: r }; };
  const raw = (who, path, body = {}) => worker.fetch(new Request("http://localhost" + path, { method: "POST", headers: { "oai-authenticated-user-email": who, "Content-Type": "application/json" }, body: JSON.stringify(body) }), env);
  const get = async (who, path) => { const r = await worker.fetch(new Request("http://localhost" + path, { headers: { "oai-authenticated-user-email": who } }), env); return r; };
  const state2 = async () => JSON.parse(await (await BUCKET.get("bench.json")).text());
  return { dir, env, BUCKET, call, raw, get, state: state2 };
}

import { inflateRawSync } from "node:zlib";
// Minimal zip reader for tests (stored and deflated entries).
export function readZip(buffer) {
  const b = Buffer.from(buffer), out = new Map();
  let end = -1; for (let i = b.length - 22; i >= 0; i--) if (b.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  const count = b.readUInt16LE(end + 10); let pos = b.readUInt32LE(end + 16);
  for (let n = 0; n < count; n++) {
    const method = b.readUInt16LE(pos + 10), size = b.readUInt32LE(pos + 20), nl = b.readUInt16LE(pos + 28), el = b.readUInt16LE(pos + 30), cl = b.readUInt16LE(pos + 32), local = b.readUInt32LE(pos + 42);
    const name = b.subarray(pos + 46, pos + 46 + nl).toString("utf8"); pos += 46 + nl + el + cl;
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28), data = b.subarray(start, start + size);
    out.set(name, method === 0 ? Buffer.from(data) : inflateRawSync(data));
  }
  return out;
}
export const parseCsv = text => { const rows = []; let row = [], cell = "", q = false; for (let i = 0; i < text.length; i++) { const c = text[i]; if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; } else if (c === '"') q = true; else if (c === ",") { row.push(cell); cell = ""; } else if (c === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; } else cell += c; } return rows; };
export const JATS = `<?xml version="1.0"?><article><front><article-meta><title-group><article-title>Aciclovir neurotoxicity and status epilepticus</article-title></title-group>
<contrib-group><contrib contrib-type="author"><name><surname>Rao</surname><given-names>Anil</given-names></name><xref ref-type="aff" rid="a1"/><xref ref-type="corresp" rid="c1"/><email>anil.rao@test-hospital.example</email></contrib>
<contrib contrib-type="author"><name><surname>Iyer</surname><given-names>Sita</given-names></name><xref ref-type="aff" rid="a2"/></contrib></contrib-group>
<aff id="a1">Department of Nephrology, Test Hospital, Pune, India</aff><aff id="a2">Department of Neurology, Test Hospital, Pune, India</aff><author-notes><corresp id="c1">Correspondence: Anil Rao, anil.rao@test-hospital.example</corresp></author-notes>
<abstract><sec><title>Background</title><p>Aciclovir can cause neurotoxicity in renal impairment.</p></sec></abstract></article-meta></front>
<body><sec><title>Case presentation</title><p>A 54-year-old man received aciclovir 10 mg/kg three times daily for herpes zoster encephalitis.<xref ref-type="table" rid="t1">Table 1</xref></p><sec><title>Course</title><p>Creatinine rose on day 3. He became confused on day 4 and developed status epilepticus on day 5.</p></sec></sec>
<sec><title>Discussion</title><p>Renal impairment increases exposure.</p></sec>
<table-wrap id="t1"><label>Table 1</label><caption><p>Laboratory course</p></caption><table><thead><tr><th>Day</th><th>Creatinine (mg/dL)</th></tr></thead><tbody><tr><td>1</td><td>1.0</td></tr><tr><td>3</td><td>2.4</td></tr></tbody></table></table-wrap>
<fig id="f1"><label>Figure 1</label><caption><p>EEG showing generalised discharges</p></caption></fig></body></article>`;
