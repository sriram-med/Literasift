const KEY = "bench.json";
const blank = () => ({ profiles: [], watches: [], articles: {}, assignments: [], runs: [], cases: [] });
const day = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const json = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control":"no-store" } });
async function load(env) {
  const object = await env.BUCKET.get(KEY);
  return { object, state: object ? await object.json() : blank() };
}
async function write(env, mutate) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { object, state } = await load(env);
    const value = mutate(state);
    const saved = await env.BUCKET.put(KEY, JSON.stringify(state), {
      onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: "*" }
    });
    if (saved) return value;
  }
  throw new Error("Concurrent update. Please retry.");
}
// NCBI asks automated clients to use E-utilities (never the web pages), identify themselves (tool + email), and stay under
// 3 requests/second, or 10 with a free API key. All E-utilities calls share one pacing gate and identity.
let ncbiNext = 0;
async function ncbiThrottle(env) {
  const gap = env.NCBI_API_KEY ? 110 : 340, at = Math.max(Date.now(), ncbiNext);
  ncbiNext = at + gap;
  if (at > Date.now()) await new Promise(resolve => setTimeout(resolve, at - Date.now()));
}
const ncbiParams = env => {
  const params = { tool:"literasift" }, email = env.NCBI_EMAIL || env.UNPAYWALL_EMAIL || env.CROSSREF_EMAIL;
  if (email) params.email = email;
  if (env.NCBI_API_KEY) params.api_key = env.NCBI_API_KEY;
  return params;
};
const withSettings = (base, state) => Object.assign(Object.create(base), {
  UNPAYWALL_EMAIL:base.UNPAYWALL_EMAIL || state.settings?.unpaywallEmail || "", ALLOW_RESTRICTED:state.settings?.storeRestricted !== false,
  NCBI_EMAIL:base.NCBI_EMAIL || state.settings?.ncbiEmail || "", NCBI_API_KEY:base.NCBI_API_KEY || state.settings?.ncbiApiKey || "",
  CORE_API_KEY:base.CORE_API_KEY || state.settings?.coreApiKey || "", WILEY_TDM_TOKEN:base.WILEY_TDM_TOKEN || state.settings?.wileyTdmToken || "",
  ELSEVIER_API_KEY:base.ELSEVIER_API_KEY || state.settings?.elsevierApiKey || "", ELSEVIER_INSTTOKEN:base.ELSEVIER_INSTTOKEN || state.settings?.elsevierInsttoken || "",
  PV_NEXUS_URL:base.PV_NEXUS_URL || state.settings?.pvNexusUrl || "", PV_NEXUS_TOKEN:base.PV_NEXUS_TOKEN || state.settings?.pvNexusToken || "" });
async function pubmed(env, operation, params) {
  await ncbiThrottle(env);
  const url = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/" + operation + ".fcgi");
  url.search = new URLSearchParams({ db: "pubmed", ...ncbiParams(env), ...params });
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error("PubMed returned HTTP " + response.status);
  return response.json();
}
function allocate(state, item) {
  // A molecule owner (set by a manager) receives every article for that molecule, regardless of capacity.
  const owned = state.watches.find(w => w.owner && w.portfolio === item.portfolio && (!w.molecule || (item.molecules || []).includes(w.molecule)));
  if (owned && state.profiles.some(p => p.email === owned.owner && p.active)) { item.reviewer = owned.owner; return; }
  const matches = p => p.active && (!p.portfolio || p.portfolio.toLowerCase() === item.portfolio.toLowerCase());
  let candidates = state.profiles.filter(p => p.role === "reviewer" && matches(p));
  // With no reviewers yet, managers screen their own queue so nothing sits unassigned.
  if (!state.profiles.some(p => p.role === "reviewer" && p.active)) candidates = state.profiles.filter(p => p.role === "manager" && p.active).map(p => ({ ...p, capacity:Infinity }));
  const open = p => state.assignments.filter(a => a.reviewer === p.email && a.status !== "Complete").length;
  const reviewer = candidates.map(p => ({ ...p, open: open(p) }))
    .filter(p => p.open < p.capacity).sort((a, b) => a.open - b.open || a.email.localeCompare(b.email))[0];
  if (reviewer) item.reviewer = reviewer.email;
}
const addDays = (value, days) => new Date(Date.parse(value) + days * 86400000).toISOString().slice(0, 10);
// A search over the 9,999-record limit is split into halves of the date range until every part fits.
async function searchIds(env, watch, from, to, depth = 0) {
  const date = value => value.replaceAll("-", "/");
  const term = "(" + watch.query + ") AND (" + date(from) + "[crdt]:" + date(to) + "[crdt])";
  const { esearchresult: result } = await pubmed(env, "esearch", { term, retmode: "json", retmax: "9999" });
  if (!result?.idlist) throw new Error("PubMed search was incomplete.");
  if (Number(result.count) === result.idlist.length) return result.idlist;
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (days < 1 || depth > 12) throw new Error("A single day exceeds the 9,999 record batch limit. Narrow the query.");
  const middle = addDays(from, Math.floor(days / 2));
  const left = await searchIds(env, watch, from, middle, depth + 1);
  const right = await searchIds(env, watch, addDays(middle, 1), to, depth + 1);
  return [...new Set([...left, ...right])];
}
// ---- Patient-reported posts (social media or forums), added by hand. Personal data is masked before anything is stored. The idea follows DrishtiAI (listening for patient-reported
// events, masking identifiers, explainable scoring); this is a separate implementation, and posts are never collected automatically (platform terms and privacy law). ----
function maskPii(text) {
  const types = new Set(); let out = String(text || "");
  const sub = (re, label, type) => { out = out.replace(re, () => { types.add(type); return label; }); };
  sub(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[EMAIL]", "email");
  sub(/(?<![\w@])@[A-Za-z0-9_]{2,30}\b/g, "[USER]", "handle");
  sub(/\bhttps?:\/\/\S+/g, "[LINK]", "link");
  sub(/\b\d{3}-\d{2}-\d{4}\b|\b\d{4}\s\d{4}\s\d{4}\b/g, "[ID NUMBER]", "id number");
  sub(/(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,5}[\s.-]\d{3,5}(?:[\s.-]\d{2,5})?/g, "[PHONE]", "phone");
  sub(/\b\d{10,12}\b/g, "[NUMBER]", "number");
  sub(/\b(?:dob|d\.o\.b\.|date of birth|born on)\s*[:\-]?\s*[0-9A-Za-z ,\/.\-]{6,20}/gi, "[DATE OF BIRTH]", "date of birth");
  sub(/\b(?:[Mm]y name is|[Ii] am called|[Nn]ame:|I am|I'm)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/g, "[NAME]", "name");
  sub(/\b(?:Dr|Mr|Mrs|Ms|Miss|Prof)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/g, "[NAME]", "name");
  return { text:out, types:[...types] };
}
async function addSocialPosts(env, posts, portfolio, molecule, platform, by) {
  const ime = await loadIme(env), state0 = (await load(env)).state, promotions = state0.settings?.imePromotions || [], added = [];
  const built = {};
  for (const post of posts) {
    const masked = maskPii(post.text), digest = await sha256(platform + "|" + post.text.slice(0, 500)), id = "SM-" + digest.slice(0, 10);
    const article = { id, source:"Social media", platform, title:masked.text.replace(/\s+/g, " ").slice(0, 110) + (masked.text.length > 110 ? "..." : ""), abstract:masked.text.slice(0, 6000), abstractSource:"Patient-reported post", journal:platform,
      date:post.postedAt || day(), url:/^https:\/\//.test(post.url || "") ? post.url : "", authors:[], piiMasked:true, piiTypes:masked.types, enrichedAt:new Date().toISOString(), enrichVersion:99, entitiesCheckedAt:new Date().toISOString(), linksCheckedAt:new Date().toISOString(),
      oaCheckedAt:new Date().toISOString(), retractionCheckedAt:new Date().toISOString(), retractionStatus:"Not applicable", fullTextStatus:"Not applicable", fullTextTier, addedBy:by };
    Object.assign(article, applyDetection(article, molecule ? [molecule] : [], ime, promotions, ""));
    built[id] = article; added.push(id);
  }
  await write(env, state => {
    for (const [id, article] of Object.entries(built)) state.articles[id] = { ...state.articles[id], ...article };
    const run = { id:crypto.randomUUID(), source:"Social media", portfolio, molecule, from:day(), to:day(), count:added.length, ids:added, time:new Date().toISOString(), query:"Patient-reported posts (" + platform + ")", status:"Imported" };
    state.runs.unshift(run);
    for (const id of added) {
      if (state.assignments.some(a => a.pmid === id && a.portfolio === portfolio)) continue;
      const item = { id:crypto.randomUUID(), pmid:id, portfolio, molecules:molecule ? [molecule] : [], reviewer:"", status:"Pending" };
      allocate(state, item); state.assignments.push(item);
    }
  });
  return added;
}
// ---- Batch by PMID list (after Pubmed-Batch-Download, MIT, Copyright 2023 Bill Young Greenwald): a list of PMIDs, optionally with a name for each, goes through the whole
// pipeline instead of being downloaded as loose files. One PMID per line (PMID, then an optional name), or a comma-separated list. ----
function parsePmidList(text) {
  const seen = new Set(), out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const tokens = line.trim().split(/[\t, ;]+/).filter(Boolean);
    if (!tokens.length || tokens[0].startsWith("#")) continue;
    const ids = tokens.every(t => /^\d{1,9}$/.test(t)) ? tokens : /^\d{1,9}$/.test(tokens[0]) ? [tokens[0]] : [];
    const name = ids.length === 1 && tokens.length > 1 ? tokens.slice(1).join(" ").replace(/[^\w .()\-]+/g, "").trim().slice(0, 80) : "";
    for (const pmid of ids) if (!seen.has(pmid) && out.length < 1000) { seen.add(pmid); out.push({ pmid, name }); }
  }
  return out;
}
async function importPmidList(env, list, portfolio, molecule) {
  env = withSettings(env, (await load(env)).state);
  const articles = {}, missing = [];
  for (let offset = 0; offset < list.length; offset += 100) {
    const chunk = list.slice(offset, offset + 100), ids = chunk.map(x => x.pmid);
    const { result: summary } = await pubmed(env, "esummary", { id:ids.join(","), retmode:"json" });
    const found = [];
    for (const { pmid, name } of chunk) {
      const citation = summary?.[pmid];
      if (!citation?.title) { missing.push(pmid); continue; }
      found.push(pmid);
      articles[pmid] = { id:pmid, source:"PubMed", title:citation.title, journal:citation.fulljournalname, date:citation.pubdate, doi:citation.articleids?.find(a => a.idtype === "doi")?.value || "",
        pmcid:citation.articleids?.find(a => a.idtype === "pmc")?.value || "", pubmedRetracted:(citation.pubtype || []).includes("Retracted Publication"), url:"https://pubmed.ncbi.nlm.nih.gov/" + pmid + "/", ...(name ? { batchName:name } : {}) };
    }
    const details = found.length ? await fetchPubmedDetails(env, found).catch(() => ({})) : {};
    for (const id of found) if (details[id]) Object.assign(articles[id], details[id], { abstractSource:details[id].abstract ? "PubMed" : "", abstractCheckedAt:new Date().toISOString() });
  }
  const today = day(), ids = Object.keys(articles);
  const run = await write(env, state => {
    for (const [id, article] of Object.entries(articles)) state.articles[id] = { ...state.articles[id], ...article, pullQuery:"PMID list (" + list.length + ")", pullRange:today, pullAt:new Date().toISOString() };
    const made = { id:crypto.randomUUID(), source:"PubMed", portfolio, molecule, from:today, to:today, count:ids.length, ids, time:new Date().toISOString(), query:"PMID list (" + list.length + " requested)", status:"Imported" };
    state.runs.unshift(made);
    for (const id of ids) {
      const existing = state.assignments.find(a => a.pmid === id && a.portfolio === portfolio);
      if (existing) { if (molecule && !(existing.molecules || []).includes(molecule) && (existing.molecules || []).length < 20) (existing.molecules ||= []).push(molecule); continue; }
      const item = { id:crypto.randomUUID(), pmid:id, portfolio, molecules:molecule ? [molecule] : [], reviewer:"", status:"Pending" };
      allocate(state, item);
      state.assignments.push(item);
    }
    return made;
  });
  return { run, missing };
}
// ---- Imports as restartable jobs. A search range is cut into bounded date windows; each window is searched, reconciled (count reported by PubMed against unique PMIDs retrieved)
// and checkpointed before the next one starts, so a failure resumes where it stopped and a replay changes nothing that was already decided. ----
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const DATE_FIELDS = { crdt:{ label:"Create Date", tag:"crdt" }, pdat:{ label:"Publication Date", tag:"dp" } };
async function withRetry(env, fn, { tries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (error) {
      const retryable = /HTTP (429|5\d\d)|timed? ?out|aborted|fetch failed|network|incomplete/i.test(String(error.message));
      if (!retryable || attempt >= tries - 1) throw error;
      await sleep(Number(env.RETRY_BASE_MS ?? 700) * 2 ** attempt + Math.random() * 100);
    }
  }
}
const uniq = list => [...new Set(list)];
// The query version in effect on a date. Versions are applied prospectively: executed searches keep the version they ran with.
function queryAt(watch, date) {
  const versions = (watch.versions || []).slice().sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  let hit = null; for (const v of versions) if (v.effectiveFrom <= date) hit = v;
  return hit || (versions[0] ? { ...versions[0] } : { version:1, query:watch.query, effectiveFrom:"0000-00-00" });
}
const searchTerm = (query, from, to, dateField) => { const tag = DATE_FIELDS[dateField].tag, d = x => x.replaceAll("-", "/"); return "(" + query + ") AND (" + d(from) + "[" + tag + "]:" + d(to) + "[" + tag + "])"; };
function makeWindows(watch, from, to, days, dateField) {
  const out = []; let start = from;
  while (start <= to) {
    const end = addDays(start, days - 1) < to ? addDays(start, days - 1) : to, q = queryAt(watch, start);
    out.push({ from:start, to:end, state:"pending", attempts:0, queryVersion:q.version, query:q.query, term:searchTerm(q.query, start, end, dateField) });
    start = addDays(end, 1);
  }
  return out;
}
// Coverage of a whole import, from its windows: running, reconciled, zero_results, partial or failed. Any window that is not reconciled stays listed as a gap.
function summarizeRun(run) {
  const ws = run.windows || [], count = state => ws.filter(w => w.state === state).length;
  const unresolved = ws.filter(w => !["reconciled", "zero_results"].includes(w.state));
  run.gaps = unresolved.map(w => ({ from:w.from, to:w.to, state:w.state, expected:w.expected ?? null, retrieved:w.retrieved ?? 0, error:w.error || "", missing:(w.missing || []).slice(0, 50) }));
  run.expected = ws.reduce((n, w) => n + (w.expected || 0), 0); run.retrieved = uniq(run.ids || []).length;
  run.coverage = count("pending") || count("running") ? "running" : count("failed") === ws.length ? "failed" : unresolved.length ? "partial" : count("zero_results") === ws.length ? "zero_results" : "reconciled";
  run.status = run.coverage === "running" ? "Running" : run.coverage === "failed" && !(run.ids || []).length ? "Failed" : "Imported";
  run.count = (run.ids || []).length;
  return run;
}
async function fetchCitations(env, ids) {
  const articles = {}, missing = [], xml = {};
  for (let offset = 0; offset < ids.length; offset += 100) {
    const chunk = ids.slice(offset, offset + 100);
    const { result: summary } = await withRetry(env, () => pubmed(env, "esummary", { id:chunk.join(","), retmode:"json" }));
    const found = [];
    for (const id of chunk) {
      const citation = summary?.[id];
      if (!citation?.title) { missing.push(id); continue; }
      found.push(id);
      articles[id] = { id, source:"PubMed", title:citation.title, journal:citation.fulljournalname, date:citation.pubdate, doi:citation.articleids?.find(a => a.idtype === "doi")?.value || "", pmcid:citation.articleids?.find(a => a.idtype === "pmc")?.value || "",
        pubmedRetracted:(citation.pubtype || []).includes("Retracted Publication"), url:"https://pubmed.ncbi.nlm.nih.gov/" + id + "/" };
    }
    const raw = {};
    const details = found.length ? await withRetry(env, () => fetchPubmedDetails(env, found, raw)).catch(error => ({ __error:error.message })) : {};
    for (const id of found) {
      if (details[id]) Object.assign(articles[id], details[id], { abstractSource:details[id].abstract ? "PubMed" : "", abstractCheckedAt:new Date().toISOString() });
      if (raw[id]) xml[id] = raw[id]; else articles[id].citationXmlStatus = details.__error ? "Failed: " + details.__error.slice(0, 120) : "Missing from the EFetch response";
    }
  }
  return { articles, missing, xml };
}
const sha256Hex = async data => [...new Uint8Array(await crypto.subtle.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : data))].map(b => b.toString(16).padStart(2, "0")).join("");
async function processWindow(env, runId, index) {
  const { state } = await load(env), run = state.runs.find(r => r.id === runId), win = run?.windows?.[index];
  if (!win) return null;
  const mark = patch => write(env, data => { const r = data.runs.find(x => x.id === runId), w = r.windows[index]; Object.assign(w, patch); summarizeRun(r); });
  try {
    await mark({ state:"running", attempts:win.attempts + 1, error:"" });
    const { esearchresult: result } = await withRetry(env, () => pubmed(env, "esearch", { term:win.term, retmode:"json", retmax:"9999" }));
    if (!result?.idlist) throw new Error("PubMed search was incomplete.");
    const expected = Number(result.count), ids = uniq(result.idlist);
    if (expected > ids.length && win.from < win.to) {
      // More records than one search can return: split the window in two. Both halves keep the same query version.
      const middle = addDays(win.from, Math.floor((Date.parse(win.to) - Date.parse(win.from)) / 86400000 / 2));
      await write(env, data => { const r = data.runs.find(x => x.id === runId), w = r.windows[index];
        const left = { ...w, to:middle, state:"pending", attempts:0, term:searchTerm(w.query, w.from, middle, run.dateField) }, right = { ...w, from:addDays(middle, 1), state:"pending", attempts:0, term:searchTerm(w.query, addDays(middle, 1), w.to, run.dateField) };
        r.windows.splice(index, 1, left, right); summarizeRun(r); });
      return { split:true };
    }
    if (expected > ids.length) throw new Error("A single day has more than 9,999 records. Narrow the query.");
    const fetched = ids.length ? await fetchCitations(env, ids) : { articles:{}, missing:[], xml:{} };
    // Original EFetch XML, one object per PMID with its hash, kept apart from full texts and screenshots.
    const evidence = {};
    for (const [id, xml] of Object.entries(fetched.xml)) {
      const key = "evidence/" + id + "/efetch.xml", hash = await sha256Hex(xml);
      await env.BUCKET.put(key, xml, { httpMetadata:{ contentType:"application/xml" } });
      evidence[id] = { key, sha256:hash, bytes:xml.length, source:"NCBI EFetch (PubMed)", license:"NLM data; abstracts remain the property of their publishers", retrievedAt:new Date().toISOString(), parser:"efetch-parser/1" };
    }
    const missing = uniq([...fetched.missing, ...ids.filter(id => fetched.articles[id] && !fetched.xml[id])]);
    const reconciled = ids.length === expected && missing.length === 0;
    await write(env, data => {
      const r = data.runs.find(x => x.id === runId), w = r.windows[index], watch = data.watches.find(x => x.portfolio === r.portfolio && (x.molecule || "") === (r.molecule || "")) || { portfolio:r.portfolio, molecule:r.molecule };
      let imported = 0;
      for (const [id, article] of Object.entries(fetched.articles)) {
        if (!data.articles[id]) imported++;
        data.articles[id] = { ...data.articles[id], ...article, pullQuery:w.query, pullRange:w.from + " to " + w.to, pullAt:new Date().toISOString(), pullDateField:DATE_FIELDS[r.dateField].label, pullQueryVersion:w.queryVersion,
          evidence:{ ...(data.articles[id]?.evidence || {}), ...(evidence[id] ? { efetch:evidence[id] } : {}) } };
      }
      for (const id of ids) {
        if (!data.articles[id]) continue;
        const existing = data.assignments.find(a => a.pmid === id && a.portfolio === r.portfolio);
        if (existing) { if (watch.molecule && !(existing.molecules || []).includes(watch.molecule) && (existing.molecules || []).length < 20) (existing.molecules ||= []).push(watch.molecule); continue; }
        const item = { id:crypto.randomUUID(), pmid:id, portfolio:r.portfolio, molecules:watch.molecule ? [watch.molecule] : [], reviewer:"", status:"Pending" };
        allocate(data, item); data.assignments.push(item);
      }
      r.ids = uniq([...(r.ids || []), ...ids.filter(id => data.articles[id])]);
      Object.assign(w, { expected, retrieved:ids.length, imported, missing, state:expected === 0 ? "zero_results" : reconciled ? "reconciled" : "partial", error:"", completedAt:new Date().toISOString() });
      summarizeRun(r);
    });
    return { done:true };
  } catch (error) {
    await mark({ state:"failed", error:String(error.message).slice(0, 300) });
    return { failed:true };
  }
}
// Runs the pending and failed windows of an import, a few at a time. Safe to call again at any point: finished windows are never repeated.
async function runImport(env, runId, budget = 12) {
  env = withSettings(env, (await load(env)).state);
  for (let step = 0; step < budget; step++) {
    const { state } = await load(env), run = state.runs.find(r => r.id === runId);
    const index = run?.windows?.findIndex(w => w.state === "pending" || w.state === "running" || (w.state === "failed" && w.attempts < 8));
    if (index === undefined || index < 0) break;
    await processWindow(env, runId, index);
  }
  return (await load(env)).state.runs.find(r => r.id === runId);
}
async function execute(env, watch, from, to, { mode = "monitor", dateField, force = false } = {}) {
  env = withSettings(env, (await load(env)).state);
  const field = DATE_FIELDS[dateField] ? dateField : mode === "backfill" ? "pdat" : "crdt", windows = makeWindows(watch, from, to, mode === "backfill" ? 14 : 7, field);
  const key = [watchKey(watch), mode, field, from, to, windows.map(w => w.queryVersion).join(",")].join("|");
  const { state } = await load(env), existing = state.runs.find(r => r.idem === key);
  if (existing && !force) {
    if (["reconciled", "zero_results"].includes(existing.coverage)) return { ...existing, replayed:true };
    return runImport(env, existing.id);
  }
  const run = { id:crypto.randomUUID(), source:"PubMed", portfolio:watch.portfolio, molecule:watch.molecule || "", from, to, mode, dateField:field, dateFieldLabel:DATE_FIELDS[field].label, windows, ids:[], count:0, time:new Date().toISOString(), searchedAt:new Date().toISOString(),
    query:windows[windows.length - 1].query, queryVersions:uniq(windows.map(w => w.queryVersion)), executedQueries:uniq(windows.map(w => w.term)).slice(0, 50), idem:key, status:"Running", coverage:"running" };
  await write(env, data => { data.runs.unshift(run); });
  return runImport(env, run.id);
}
// ---- Product dictionaries and watchlist versions. A portfolio dictionary lists, for each product, its generic names, brands, salts and approved aliases; a watchlist query is built from them.
// Every change to a query is a new version with an effective date, and imports record the version they ran with. ----
const splitNames = value => uniq((Array.isArray(value) ? value : String(value || "").split(/[,;\n]/)).map(x => String(x).replace(/["\[\]()*]/g, " ").replace(/\s+/g, " ").trim()).filter(x => x && x.length <= 100)).slice(0, 40);
const dictNames = p => uniq([p.name, ...(p.generics || []), ...(p.brands || []), ...(p.salts || []), ...(p.aliases || [])].map(x => String(x || "").trim()).filter(Boolean));
const dictionaryFor = (state, portfolio, molecule) => (state.dictionaries?.[portfolio]?.products || []).find(p => dictNames(p).some(n => n.toLowerCase() === String(molecule || "").toLowerCase())) || null;
const namesWithDictionary = (state, portfolio, names) => { const entry = names.map(n => dictionaryFor(state, portfolio, n)).find(Boolean); return entry ? uniq([...names, ...dictNames(entry)]) : names; };
const queryTerms = query => uniq([...String(query).matchAll(/"([^"]+)"\[(?:tiab|MeSH Terms|Supplementary Concept)\]/g)].map(m => m[1]));
function commitWatch(data, watch, by, note = "query edited") {
  const old = data.watches.find(w => watchKey(w) === watchKey(watch)), at = new Date().toISOString();
  const versions = (old?.versions || (old ? [{ version:1, query:old.query, effectiveFrom:"0000-00-00", createdAt:at, by:"system", note:"initial" }] : [])).slice();
  if (!old) versions.push({ version:1, query:watch.query, effectiveFrom:"0000-00-00", createdAt:at, by, note:"created" });
  else if (old.query !== watch.query) versions.push({ version:Math.max(...versions.map(v => v.version)) + 1, query:watch.query, effectiveFrom:day(), createdAt:at, by, note });
  watch.versions = versions;
  data.watches = data.watches.filter(w => watchKey(w) !== watchKey(watch)); data.watches.push(watch);
}
async function esearchCount(env, query, from, to, dateField) {
  const { esearchresult: r } = await withRetry(env, () => pubmed(env, "esearch", { term:searchTerm(query, from, to, dateField), retmode:"json", retmax:"0" }), { tries:2 });
  return Number(r?.count ?? NaN);
}
const safetyFilter = '("adverse effects"[sh] OR "drug-related side effects and adverse reactions"[MeSH Terms] OR safety[tiab] OR toxicity[tiab] OR "adverse event*"[tiab] OR "adverse reaction*"[tiab] OR "adverse drug reaction*"[tiab] OR "side effect*"[tiab])';
function buildQuery(names, safetyOnly) {
  const clean = [...new Set(names.map(n => String(n || "").replace(/["\[\]()*]/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean))];
  if (!clean.length || clean.length > 30 || clean.some(n => n.length > 100)) return "";
  const terms = clean.map(n => '"' + n + '"[tiab] OR "' + n + '"[MeSH Terms] OR "' + n + '"[Supplementary Concept]');
  const query = "(" + terms.join(" OR ") + ")" + (safetyOnly ? " AND " + safetyFilter : "");
  return query.length <= 1500 ? query : "";
}
const keepOwner = (data, watch) => { const old = data.watches.find(w => watchKey(w) === watchKey(watch)); if (old?.owner && !watch.owner) watch.owner = old.owner; };
const watchKey = w => w.portfolio + "\u0000" + (w.molecule || "");
const maxWatchesPerRun = 10;
const pmcOrigin = "https://pmc-oa-opendata.s3.amazonaws.com";
async function captureFromPmc(env, article) {
  if (!/^PMC[0-9]+$/.test(article.pmcid)) return { fullTextStatus:"No PMC record" };
  const listUrl = pmcOrigin + "/?list-type=2&prefix=" + encodeURIComponent("metadata/" + article.pmcid + ".");
  const list = await fetch(listUrl, {signal:AbortSignal.timeout(15000)});
  if (!list.ok) throw new Error("PMC listing returned HTTP " + list.status);
  const names = [...(await list.text()).matchAll(/<Key>(metadata\/PMC[0-9]+\.[0-9]+\.json)<\/Key>/g)].map(match => match[1]);
  const versions = await Promise.all(names.slice(-10).map(async name => {
    const response = await fetch(pmcOrigin + "/" + name, {signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error("PMC metadata unavailable.");
    return response.json();
  }));
  const permissivePmc = v => ["CC0","CC BY","CC BY-SA","CC BY-ND"].includes(String(v.license_code).trim().toUpperCase().replace(/^CC[-_]/,"CC ").replace(/_/g,"-"));
  const item = versions.filter(v => env.ALLOW_RESTRICTED || permissivePmc(v))
    .sort((a,b) => Number(permissivePmc(b)) - Number(permissivePmc(a)) || Number(a.is_manuscript === "yes") - Number(b.is_manuscript === "yes") || Number(b.version) - Number(a.version))[0];
  if (!item) return {fullTextStatus:"No eligible PMC file"};
  const version = String(item.version);
  if (!/^[0-9]+$/.test(version)) throw new Error("Invalid PMC version.");
  const filename = article.pmcid + "." + version;
  const format = item.pdf_url ? "pdf" : "xml";
  const file = filename + "." + format;
  const url = pmcOrigin + "/" + filename + "/" + file;
  const response = await fetch(url, {signal:AbortSignal.timeout(25000)});
  if (!response.ok) throw new Error("PMC file returned HTTP " + response.status);
  const bytes = await response.arrayBuffer();
  const key = "evidence/" + article.id + "/" + file;
  await env.BUCKET.put(key, bytes, {httpMetadata:{contentType:format === "pdf" ? "application/pdf" : "application/xml"}});
  let text = "";
  try { text = format === "pdf" ? await pdfToText(env, bytes) : xmlToText(new TextDecoder().decode(bytes)); } catch { /* text extraction is best effort */ }
  return {fullTextStatus:"Captured", fullTextKey:key, fullTextLicense:item.license_code, fullTextSource:url, fullTextOrigin:"PMC", fullTextRestricted:!permissivePmc(item), _text:text};
}
// ---- Extraction: abstracts/metadata (PubMed, Europe PMC, OpenAlex), full-text text + key passages, optional GROBID for PDFs ----
const safetyTerms = ["adverse","toxicity","toxic","hepatotoxic","nephrotoxic","cardiotoxic","neurotoxic","death","fatal","overdose","reaction","syndrome","injury",
  "failure","hypersensitivity","anaphyla","rash","pregnan","withdrawal","contraindicat","interaction","side effect","safety","harm","hospitali","discontinu","serious"];
const decodeXml = value => String(value || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, "&");
const xmlText = value => decodeXml(String(value || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
function parsePubmedXml(xml) {
  const out = {};
  for (const block of xml.split("<PubmedArticle>").slice(1)) {
    const pmid = /<PMID[^>]*>(\d+)<\/PMID>/.exec(block)?.[1];
    if (!pmid) continue;
    const abstract = [...block.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)]
      .map(m => { const label = /Label="([^"]*)"/.exec(m[1])?.[1]; return (label ? label + ": " : "") + xmlText(m[2]); }).filter(Boolean).join("\n");
    const authors = [...block.matchAll(/<Author[ >][\s\S]*?<\/Author>/g)].map(m => {
      const last = /<LastName>([^<]*)</.exec(m[0])?.[1], initials = /<Initials>([^<]*)</.exec(m[0])?.[1], group = /<CollectiveName>([^<]*)</.exec(m[0])?.[1];
      return xmlText(group || [last, initials].filter(Boolean).join(" "));
    }).filter(Boolean).slice(0, 12);
    const list = re => [...block.matchAll(re)].map(m => xmlText(m[1])).filter(Boolean);
    const firstAuthor = /<Author[ >][\s\S]*?<\/Author>/.exec(block)?.[0] || "", aeMesh = [];
    let aeIndexed = false;
    for (const heading of block.matchAll(/<MeshHeading>([\s\S]*?)<\/MeshHeading>/g)) {
      const descriptor = /<DescriptorName[^>]*>([^<]+)</.exec(heading[1])?.[1], qualifiers = [...heading[1].matchAll(/<QualifierName[^>]*>([^<]+)</g)].map(x => x[1].toLowerCase());
      if (descriptor && qualifiers.some(q => /^(chemically induced|poisoning|toxicity)$/.test(q))) aeMesh.push(xmlText(descriptor));
      if (descriptor && qualifiers.includes("adverse effects")) aeIndexed = true;
    }
    out[pmid] = { journalCountry:xmlText(/<MedlineJournalInfo>[\s\S]*?<Country>([^<]*)<\/Country>/.exec(block)?.[1] || ""), affiliation:xmlText(/<Affiliation>([\s\S]*?)<\/Affiliation>/.exec(firstAuthor)?.[1] || "").slice(0, 400),
      aeMesh:[...new Set(aeMesh)].slice(0, 10), aeIndexed, abstract, authors, meshTerms:[...new Set(list(/<DescriptorName[^>]*>([^<]+)</g))].slice(0, 30),
      keywords:[...new Set(list(/<Keyword[^>]*>([\s\S]*?)<\/Keyword>/g))].slice(0, 20), pubTypes:[...new Set(list(/<PublicationType[^>]*>([^<]+)</g))].slice(0, 8) };
  }
  return out;
}
async function fetchPubmedDetails(env, ids, xmlOut) {
  await ncbiThrottle(env);
  const url = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi");
  url.search = new URLSearchParams({ db:"pubmed", ...ncbiParams(env), retmode:"xml", id:ids.join(",") });
  const response = await fetch(url, { signal:AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error("PubMed efetch returned HTTP " + response.status);
  const xml = await response.text();
  // The original XML of each article is handed back too, so it can be stored untouched.
  if (xmlOut) for (const block of xml.split("<PubmedArticle>").slice(1)) { const pmid = /<PMID[^>]*>(\d+)<\/PMID>/.exec(block)?.[1]; if (pmid) xmlOut[pmid] = '<?xml version="1.0" encoding="UTF-8"?>\n<PubmedArticleSet><PubmedArticle>' + block.replace(/<\/PubmedArticleSet>\s*$/, "").trimEnd() + "</PubmedArticleSet>"; }
  return parsePubmedXml(xml);
}
const epmcBase = "https://www.ebi.ac.uk/europepmc/webservices/rest";
async function europePmcCore(article) {
  const url = new URL(epmcBase + "/search");
  url.search = new URLSearchParams({ query:"EXT_ID:" + article.id + " AND SRC:MED", resultType:"core", format:"json", pageSize:"1" });
  const response = await fetch(url, { signal:AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error("Europe PMC returned HTTP " + response.status);
  return (await response.json()).resultList?.result?.[0] || null;
}
async function openAlexWork(env, article) {
  const url = new URL("https://api.openalex.org/works/pmid:" + encodeURIComponent(article.id));
  const mailto = env.CROSSREF_EMAIL || env.UNPAYWALL_EMAIL;
  if (mailto) url.searchParams.set("mailto", mailto);
  const response = await fetch(url, { signal:AbortSignal.timeout(20000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("OpenAlex returned HTTP " + response.status);
  return response.json();
}
const invertedToText = index => {
  const words = [];
  for (const [word, positions] of Object.entries(index || {})) for (const p of positions) words[p] = word;
  return words.filter(Boolean).join(" ");
};
// One pass of metadata enrichment: abstract, authors, MeSH, keywords, publication types, citations, topic.
async function enrichMetadata(env, article, coreOnce) {
  const fields = {}, errors = [];
  let got = false;
  try {
    const details = (await fetchPubmedDetails(env, [article.id]))[article.id];
    if (details) { got = true; Object.assign(fields, details); if (details.abstract) fields.abstractSource = "PubMed"; }
  } catch (error) { errors.push(error.message); }
  const core = await coreOnce();
  if (core) {
    got = true;
    if (!fields.abstract && core.abstractText) { fields.abstract = xmlText(core.abstractText); fields.abstractSource = "Europe PMC"; }
    if (!fields.keywords?.length && core.keywordList?.keyword) fields.keywords = core.keywordList.keyword.slice(0, 20);
    if (!fields.meshTerms?.length && core.meshHeadingList?.meshHeading) fields.meshTerms = core.meshHeadingList.meshHeading.map(m => m.descriptorName).filter(Boolean).slice(0, 30);
    if (core.citedByCount !== undefined) fields.citedBy = Number(core.citedByCount);
    if (!article.doi && /^10\.\d{4,9}\/\S+$/.test(core.doi || "")) fields.doi = core.doi;
  }
  try {
    const work = await openAlexWork(env, article);
    if (work) {
      got = true;
      if (work.cited_by_count !== undefined) fields.citedBy = Math.max(fields.citedBy || 0, Number(work.cited_by_count));
      const workDoi = String(work.doi || "").replace(/^https?:\/\/doi\.org\//i, "");
      if (!article.doi && !fields.doi && validDoi(workDoi)) fields.doi = workDoi;
      fields.topic = work.primary_topic?.display_name || "";
      fields.workType = work.type || "";
      const text = invertedToText(work.abstract_inverted_index);
      if (!fields.abstract && !article.abstract && text) { fields.abstract = text; fields.abstractSource = "OpenAlex"; }
    }
  } catch (error) { errors.push(error.message); }
  if (got) { fields.enrichedAt = new Date().toISOString(); fields.abstractCheckedAt = fields.enrichedAt; fields.enrichVersion = 2; }
  if (errors.length) fields.enrichError = errors.join("; ");
  return fields;
}
// PubTator3 (NCBI): text-mined diseases and chemicals per article, used for highlighting and screening context.
async function fetchEntities(article) {
  const url = "https://www.ncbi.nlm.nih.gov/research/pubtator3-api/publications/export/biocjson?pmids=" + encodeURIComponent(article.id);
  const response = await fetch(url, { signal:AbortSignal.timeout(20000) });
  if (response.status === 404) return { entitiesCheckedAt:new Date().toISOString() };
  if (!response.ok) throw new Error("PubTator returned HTTP " + response.status);
  const raw = await response.text();
  let docs;
  try { const json = JSON.parse(raw); docs = Array.isArray(json) ? json : json.PubTator3 || json.documents || [json]; }
  catch { docs = raw.split("\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean); }
  const found = { Disease:new Map(), Chemical:new Map() };
  for (const doc of docs) for (const passage of doc.passages || []) for (const note of passage.annotations || []) {
    const map = found[note.infons?.type], name = String(note.text || "").trim();
    if (map && name.length > 2) { const key = name.toLowerCase(); map.set(key, { name, count:(map.get(key)?.count || 0) + 1 }); }
  }
  const top = map => [...map.values()].sort((a, b) => b.count - a.count).slice(0, 12).map(x => x.name);
  return { entitiesCheckedAt:new Date().toISOString(), entities:{ diseases:top(found.Disease), chemicals:top(found.Chemical) } };
}
// RxNorm brand/ingredient names and PubChem synonyms, offered as suggestions when setting up a molecule search.
async function suggestSynonyms(name) {
  const clean = String(name || "").replace(/["\[\]()*]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  const out = new Map(), counts = { rxnorm:0, pubchem:0 };
  const add = (value, source) => {
    const text = String(value || "").trim();
    if (/^[A-Za-z][A-Za-z\- ]{2,40}$/.test(text) && text.toLowerCase() !== clean.toLowerCase() && !out.has(text.toLowerCase())) { out.set(text.toLowerCase(), text); counts[source]++; }
  };
  if (!clean) return { names:[], sources:counts };
  try {
    const response = await fetch("https://rxnav.nlm.nih.gov/REST/drugs.json?name=" + encodeURIComponent(clean), { signal:AbortSignal.timeout(15000) });
    if (response.ok) for (const group of (await response.json()).drugGroup?.conceptGroup || []) for (const concept of group.conceptProperties || []) {
      if (concept.tty === "BN" || concept.tty === "IN" || concept.tty === "MIN") add(concept.name, "rxnorm");
      for (const match of String(concept.name || "").matchAll(/\[([^\]]+)\]/g)) add(match[1], "rxnorm");
    }
  } catch { /* optional source */ }
  try {
    const response = await fetch("https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/" + encodeURIComponent(clean) + "/synonyms/JSON", { signal:AbortSignal.timeout(15000) });
    if (response.ok) for (const name of ((await response.json()).InformationList?.Information?.[0]?.Synonym || []).slice(0, 120)) { if (out.size >= 20) break; add(name, "pubchem"); }
  } catch { /* optional source */ }
  return { names:[...out.values()].slice(0, 20), sources:counts };
}
// openFDA FAERS: most-reported reactions for a drug, as context only (spontaneous reports; no causality or incidence).
async function faersReactions(names) {
  for (const raw of names.slice(0, 6)) {
    const name = String(raw).replace(/["\\]/g, "").trim().slice(0, 100);
    if (!name) continue;
    const search = encodeURIComponent('patient.drug.openfda.generic_name:"' + name + '"');
    const response = await fetch("https://api.fda.gov/drug/event.json?search=" + search + "&count=patient.reaction.reactionmeddrapt.exact&limit=15", { signal:AbortSignal.timeout(20000) });
    if (response.status === 404) continue;
    if (!response.ok) throw new Error("openFDA returned HTTP " + response.status);
    const results = (await response.json()).results || [];
    if (!results.length) continue;
    let total = null;
    try { total = (await (await fetch("https://api.fda.gov/drug/event.json?search=" + search + "&limit=1", { signal:AbortSignal.timeout(15000) })).json()).meta?.results?.total ?? null; } catch { /* optional */ }
    return { name, total, reactions:results.map(x => ({ term:x.term, count:x.count })) };
  }
  return null;
}
// Reference-manager export (RIS for EndNote/Zotero/Mendeley, BibTeX for LaTeX tools).
function citationFile(articles, format, assignmentFor) {
  const oneLine = v => String(v ?? "").replace(/\s+/g, " ").trim();
  const year = a => /\d{4}/.exec(a.date || "")?.[0] || "";
  if (format === "bibtex") return articles.map(a => {
    const field = (k, v) => v ? "  " + k + " = {" + oneLine(v).replace(/[{}]/g, "") + "},\n" : "";
    return "@article{pmid" + a.id + ",\n" + field("title", a.title) + field("author", (a.authors || []).join(" and ")) + field("journal", a.journal) + field("year", year(a)) +
      field("doi", a.doi) + field("pmid", a.id) + field("keywords", [...(a.keywords || []), ...(a.meshTerms || [])].join(", ")) + field("abstract", a.abstract) + field("url", a.url) + "}\n";
  }).join("\n");
  return articles.map(a => {
    const item = assignmentFor(a.id);
    const authors = (a.authors || []).map(n => { const [last, ...rest] = oneLine(n).split(" "); return "AU  - " + last + (rest.length ? ", " + rest.join(" ") : ""); });
    return ["TY  - JOUR", "TI  - " + oneLine(a.title), ...authors, "JO  - " + oneLine(a.journal), "DB  - " + (a.source || "PubMed"), "PY  - " + year(a), "DA  - " + oneLine(a.date), "DO  - " + oneLine(a.doi), "AN  - PMID " + a.id,
      "AB  - " + oneLine(a.abstract), ...[...(a.keywords || []), ...(a.meshTerms || [])].map(k => "KW  - " + oneLine(k)), "UR  - " + a.url,
      "N1  - " + oneLine("Portfolio: " + (item?.portfolio || "") + (item?.molecules?.length ? "; Molecules: " + item.molecules.join(", ") : "")), "ER  - "].filter(l => !/^[A-Z0-9]{2}  - $/.test(l) || l.startsWith("ER")).join("\r\n") + "\r\n";
  }).join("\r\n");
}
async function elink(env, params) {
  await ncbiThrottle(env);
  const url = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi");
  url.search = new URLSearchParams({ dbfrom:"pubmed", retmode:"json", ...ncbiParams(env), ...params });
  const response = await fetch(url, { signal:AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error("PubMed elink returned HTTP " + response.status);
  return response.json();
}
// PubMed LinkOut (publisher and free full-text links) and "cited by" in PubMed, through the supported E-utilities API.
async function fetchLinks(env, article) {
  const out = {}, errors = [];
  let ok = false;
  try {
    const objs = (await elink(env, { id:article.id, cmd:"llinks" })).linksets?.[0]?.idurllist?.[0]?.objurls || [];
    out.linkOut = objs.map(o => ({ provider:o.provider?.name || o.linkname || "", url:o.url?.value || "", free:/free/i.test([].concat(o.attribute || []).join(" ")) }))
      .filter(x => /^https?:\/\//.test(x.url)).sort((a, b) => Number(b.free) - Number(a.free)).slice(0, 6);
    ok = true;
  } catch (error) { errors.push(error.message); }
  try {
    const sets = (await elink(env, { id:article.id, cmd:"neighbor", linkname:"pubmed_pubmed_citedin" })).linksets?.[0]?.linksetdbs || [];
    out.pubmedCitedBy = (sets.find(d => /citedin/.test(d.linkname || "")) || { links:[] }).links.length;
    ok = true;
  } catch (error) { errors.push(error.message); }
  if (ok) out.linksCheckedAt = new Date().toISOString();
  if (errors.length) out.linksError = errors.join("; ");
  return out;
}
// Text of the main sections from JATS (PMC / Europe PMC) or TEI (GROBID) XML.
function xmlToText(xml) {
  const cleaned = String(xml).replace(/<xref\b[^>]*>[\s\S]*?<\/xref>/g, "").replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/g, "").replace(/<table-wrap\b[\s\S]*?<\/table-wrap>/g, "");
  const body = /<body\b[\s\S]*?<\/body>/.exec(cleaned)?.[0] || /<text\b[\s\S]*?<\/text>/.exec(cleaned)?.[0] || "";
  const abstract = /<abstract\b[\s\S]*?<\/abstract>/.exec(cleaned)?.[0] || "";
  return [abstract, body].flatMap(part => [...part.matchAll(/<(title|head|p)\b[^>]*>([\s\S]*?)<\/\1>/g)].map(m => xmlText(m[2]))).filter(t => t.length > 1).join("\n").replace(/[ \t]+([.,;:)])/g, "$1");
}
// Elsevier's full-text XML names its parts ce:section-title, ce:para and ce:simple-para (abstract and body).
function elsevierText(xml) {
  const cleaned = String(xml).replace(/<ce:cross-refs?\b[^>]*>[\s\S]*?<\/ce:cross-refs?>/g, "").replace(/<ce:bibliography\b[\s\S]*?<\/ce:bibliography>/g, "");
  return [...cleaned.matchAll(/<(ce:section-title|ce:para|ce:simple-para|dc:description)\b[^>]*>([\s\S]*?)<\/\1>/g)].map(m => xmlText(m[2])).filter(t => t.length > 1).join("\n").replace(/[ \t]+([.,;:)])/g, "$1");
}
function keyPassages(text, molecules) {
  const names = molecules.map(m => m.toLowerCase()).filter(Boolean);
  const out = [];
  for (const sentence of String(text).replace(/[ \t]+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z(])|\n/)) {
    const lower = sentence.toLowerCase();
    if ((!names.length || names.some(n => lower.includes(n))) && safetyTerms.some(t => lower.includes(t)) && sentence.length > 30) {
      out.push(sentence.trim().slice(0, 400));
      if (out.length >= 6) break;
    }
  }
  return out;
}
// Optional GROBID service (Apache-2.0, self-hosted): turns a stored PDF into structured text.
async function pdfToText(env, bytes) {
  if (!env.GROBID_URL) return env.PDF_TEXT_FN ? String(await env.PDF_TEXT_FN(bytes)) : "";
  const form = new FormData();
  form.append("input", new Blob([bytes], { type:"application/pdf" }), "article.pdf");
  const response = await fetch(String(env.GROBID_URL).replace(/\/+$/, "") + "/api/processFulltextDocument", { method:"POST", body:form, signal:AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error("GROBID returned HTTP " + response.status);
  return xmlToText(await response.text());
}
// Unpaywall: one lookup per article gives open-access status for the whole site and, where the licence allows, a stored PDF.
const openLicenses = ["cc0","cc-by","cc-by-sa","cc-by-nd"];
const maxPdfBytes = 25 * 1024 * 1024;
const oaRecheckMs = 30 * 86400000;
const validDoi = doi => /^10\.\d{4,9}\/\S+$/.test(doi || "");
async function unpaywallLookup(env, article) {
  if (!env.UNPAYWALL_EMAIL) return { state:"unconfigured" };
  if (!validDoi(article.doi)) return { state:"nodoi" };
  const lookup = new URL("https://api.unpaywall.org/v2/" + encodeURIComponent(article.doi));
  lookup.searchParams.set("email", env.UNPAYWALL_EMAIL);
  const response = await fetch(lookup, { signal:AbortSignal.timeout(15000) });
  if (response.status === 404) return { state:"notfound" };
  if (!response.ok) throw new Error("Unpaywall returned HTTP " + response.status);
  return { state:"ok", data:await response.json() };
}
// Fields shown across the site (badges, filters, overview, CSV) from one Unpaywall result.
function oaFields(result) {
  const checked = { oaCheckedAt:new Date().toISOString() };
  if (result.state === "nodoi") return { ...checked, oaStatus:"No DOI" };
  if (result.state === "notfound") return { ...checked, oaStatus:"Not in Unpaywall" };
  if (result.state !== "ok") return {};
  const data = result.data, best = data.best_oa_location;
  return { ...checked, oaStatus:data.oa_status || (data.is_oa ? "open" : "closed"), oaIsOpen:Boolean(data.is_oa),
    oaJournalIsOa:Boolean(data.journal_is_oa), oaLicense:best?.license || "", oaVersion:best?.version || "",
    oaHostType:best?.host_type || "", oaUrl:/^https:\/\//.test(best?.url_for_pdf || best?.url || "") ? (best.url_for_pdf || best.url) : "" };
}
// An open-access landing page normally names its PDF in a standard meta tag (citation_pdf_url). Only pages Unpaywall itself lists as open copies are read.
async function pdfFromLanding(url) {
  try {
    const page = await fetch(url, { signal:AbortSignal.timeout(12000), headers:{ Accept:"text/html" }, redirect:"follow" });
    if (!page.ok || !/html/i.test(page.headers.get("content-type") || "")) return "";
    const html = (await page.text()).slice(0, 1_500_000), tag = /<meta[^>]+name=["']citation_pdf_url["'][^>]*>/i.exec(html) || /<meta[^>]+content=["'][^"']+["'][^>]+name=["']citation_pdf_url["'][^>]*>/i.exec(html);
    const found = tag && /content=["']([^"']+)["']/i.exec(tag[0])?.[1];
    return found ? new URL(decodeXml(found), page.url).href : "";
  } catch { return ""; }
}
async function captureFromUnpaywall(env, article, reason, lookupOnce) {
  const result = await lookupOnce();
  if (result.state === "unconfigured") return { fullTextStatus:reason };
  if (result.state === "nodoi") return { fullTextStatus:"No DOI for open-access lookup" };
  if (result.state === "notfound") return { fullTextStatus:"Not in Unpaywall" };
  const data = result.data;
  if (!data.is_oa) return { fullTextStatus:"No open-access copy" };
  const locations = [data.best_oa_location, ...(data.oa_locations || [])].filter(Boolean);
  const license = l => String(l.license || "").toLowerCase();
  const rank = l => (l.version === "publishedVersion" ? 0 : l.version === "acceptedVersion" ? 1 : 2);
  const permissive = l => openLicenses.includes(license(l));
  // Restricted licences (CC BY-NC, publisher terms, no stated licence) are stored too when the manager allows it; permissive copies come first.
  const pdfs = locations.filter(l => /^https:\/\//.test(l.url_for_pdf || "") && (env.ALLOW_RESTRICTED || permissive(l)))
    .sort((a, b) => (Number(!permissive(a)) * 10 + rank(a)) - (Number(!permissive(b)) * 10 + rank(b)));
  // Locations with no direct PDF link but an open landing page (repositories, publisher OA pages) are tried through the page's own PDF tag.
  const pages = locations.filter(l => !/^https:\/\//.test(l.url_for_pdf || "") && /^https:\/\//.test(l.url_for_landing_page || l.url || "") && (env.ALLOW_RESTRICTED || permissive(l))).slice(0, 2);
  for (const location of pages) { const found = await pdfFromLanding(location.url_for_landing_page || location.url); if (/^https:\/\//.test(found)) pdfs.push({ ...location, url_for_pdf:found }); }
  for (const location of pdfs.slice(0, 5)) {
    try {
      const file = await fetch(location.url_for_pdf, { signal:AbortSignal.timeout(25000), headers:{ Accept:"application/pdf" } });
      if (!file.ok) continue;
      const bytes = await file.arrayBuffer();
      if (bytes.byteLength > maxPdfBytes || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") continue;
      const key = "evidence/" + article.id + "/unpaywall.pdf";
      await env.BUCKET.put(key, bytes, { httpMetadata:{ contentType:"application/pdf" } });
      let text = "";
      try { text = await pdfToText(env, bytes); } catch { /* text extraction is best effort */ }
      return { fullTextStatus:"Captured", fullTextKey:key, fullTextLicense:license(location), fullTextSource:location.url_for_pdf,
        fullTextOrigin:"Unpaywall", fullTextVersion:location.version || "", fullTextHost:location.host_type || "", fullTextRestricted:!permissive(location), _text:text };
    } catch { /* try the next location */ }
  }
  const link = locations.map(l => l.url_for_landing_page || l.url).find(u => /^https:\/\//.test(u || ""));
  return link ? { fullTextStatus:"Open access link only", fullTextLink:link } : { fullTextStatus:"No downloadable open-access copy" };
}
// Europe PMC full-text XML: stored only when its record reports an open-access article under a permissive licence.
async function captureFromEuropePmc(env, article, coreOnce, reason) {
  const core = await coreOnce();
  const license = String(core?.license || "").toLowerCase().trim().replace(/\s+/g, "-");
  const id = core?.pmcid || article.pmcid;
  if (!core || core.isOpenAccess !== "Y" || !(env.ALLOW_RESTRICTED || openLicenses.includes(license)) || !/^PMC[0-9]+$/.test(id || "")) return { fullTextStatus:reason };
  const response = await fetch(epmcBase + "/" + id + "/fullTextXML", { signal:AbortSignal.timeout(25000) });
  if (!response.ok) return { fullTextStatus:reason };
  const bytes = await response.arrayBuffer();
  const xml = new TextDecoder().decode(bytes);
  if (bytes.byteLength > 15 * 1024 * 1024 || !/<article\b/.test(xml)) return { fullTextStatus:reason };
  const key = "evidence/" + article.id + "/europepmc.xml";
  await env.BUCKET.put(key, bytes, { httpMetadata:{ contentType:"application/xml" } });
  return { fullTextStatus:"Captured", fullTextKey:key, fullTextLicense:license, fullTextSource:epmcBase + "/" + id + "/fullTextXML", fullTextOrigin:"Europe PMC", fullTextRestricted:!openLicenses.includes(license), _text:xmlToText(xml) };
}
// Semantic Scholar (free API, optional SEMANTIC_SCHOLAR_KEY): repository copies that other sources may miss.
async function captureFromSemanticScholar(env, article, reason) {
  const url = "https://api.semanticscholar.org/graph/v1/paper/PMID:" + encodeURIComponent(article.id) + "?fields=openAccessPdf";
  const response = await fetch(url, { headers:env.SEMANTIC_SCHOLAR_KEY ? { "x-api-key":env.SEMANTIC_SCHOLAR_KEY } : {}, signal:AbortSignal.timeout(15000) });
  if (!response.ok) return { fullTextStatus:reason }; // 404 = unknown paper, 429 = rate limited: not an error, just no extra source
  const pdf = (await response.json()).openAccessPdf;
  if (!/^https:\/\//.test(pdf?.url || "")) return { fullTextStatus:reason };
  const license = String(pdf.license || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const permissive = ["cc0", "ccby", "ccbysa", "ccbynd"].includes(license);
  if (!env.ALLOW_RESTRICTED && !permissive) return { fullTextStatus:reason };
  try {
    const file = await fetch(pdf.url, { signal:AbortSignal.timeout(25000), headers:{ Accept:"application/pdf" } });
    if (!file.ok) return { fullTextStatus:reason };
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength > maxPdfBytes || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") return { fullTextStatus:reason };
    const key = "evidence/" + article.id + "/semanticscholar.pdf";
    await env.BUCKET.put(key, bytes, { httpMetadata:{ contentType:"application/pdf" } });
    let text = "";
    try { text = await pdfToText(env, bytes); } catch { /* best effort */ }
    return { fullTextStatus:"Captured", fullTextKey:key, fullTextLicense:pdf.license || "unspecified", fullTextSource:pdf.url, fullTextOrigin:"Semantic Scholar", fullTextRestricted:!permissive, _text:text };
  } catch { return { fullTextStatus:reason }; }
}
const fullTextTier = 6; // bump when a new source is added so earlier "not found" results are tried once more
// A preprint of the same paper, when its own open licence allows storage (Europe PMC indexes bioRxiv, medRxiv and others). It may differ from the published version, so it is marked as a preprint.
const normTitle = t => String(t || "").toLowerCase().replace(/<[^>]+>/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
async function captureFromPreprint(env, article, reason) {
  const title = normTitle(article.title);
  if (title.length < 25) return { fullTextStatus:reason };
  const url = new URL(epmcBase + "/search");
  url.search = new URLSearchParams({ query:'TITLE:"' + String(article.title).replace(/["\\]/g, " ").slice(0, 200) + '" AND SRC:PPR', resultType:"core", format:"json", pageSize:"5" });
  const response = await fetch(url, { signal:AbortSignal.timeout(20000) });
  if (!response.ok) return { fullTextStatus:reason };
  const hit = ((await response.json()).resultList?.result || []).find(r => normTitle(r.title) === title && r.isOpenAccess === "Y" && /^PPR\d+$/.test(r.id || ""));
  const license = String(hit?.license || "").toLowerCase().trim().replace(/\s+/g, "-");
  if (!hit || !(env.ALLOW_RESTRICTED || openLicenses.includes(license))) return { fullTextStatus:reason };
  const file = await fetch(epmcBase + "/" + hit.id + "/fullTextXML", { signal:AbortSignal.timeout(25000) });
  if (!file.ok) return { fullTextStatus:reason };
  const bytes = await file.arrayBuffer(), xml = new TextDecoder().decode(bytes);
  if (bytes.byteLength > 15 * 1024 * 1024 || !/<article\b/.test(xml)) return { fullTextStatus:reason };
  const key = "evidence/" + article.id + "/preprint.xml";
  await env.BUCKET.put(key, bytes, { httpMetadata:{ contentType:"application/xml" } });
  return { fullTextStatus:"Captured", fullTextKey:key, fullTextLicense:license, fullTextSource:epmcBase + "/" + hit.id + "/fullTextXML", fullTextOrigin:"Preprint (Europe PMC)", fullTextVersion:"preprint", fullTextRestricted:!openLicenses.includes(license), _text:xmlToText(xml) };
}
const storeFile = async (env, article, name, bytes, type) => { const key = "evidence/" + article.id + "/" + name; await env.BUCKET.put(key, bytes, { httpMetadata:{ contentType:type } }); return key; };
// ---- Retrieval through official programme interfaces. Wiley and Elsevier text-mining APIs use the user's own token and only return what their institution is entitled to
// (design after paperscraper, MIT, Copyright (c) 2020 PhosphorylatedRabbits). CORE aggregates open repository copies. bioRxiv/medRxiv publish their own full-text XML. ----
const wileyDoi = doi => /^10\.(1002|1111)\//.test(doi || ""), elsevierDoi = doi => /^10\.(1016|1053)\//.test(doi || "");
async function captureFromWiley(env, article, reason) {
  if (!env.WILEY_TDM_TOKEN || !validDoi(article.doi) || !wileyDoi(article.doi)) return { fullTextStatus:reason };
  const response = await fetch("https://api.wiley.com/onlinelibrary/tdm/v1/articles/" + encodeURIComponent(article.doi), { headers:{ "Wiley-TDM-Client-Token":env.WILEY_TDM_TOKEN }, redirect:"follow", signal:AbortSignal.timeout(60000) });
  if (!response.ok) return { fullTextStatus:response.status === 403 || response.status === 401 ? "Not covered by your Wiley access" : reason };
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > maxPdfBytes || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") return { fullTextStatus:reason };
  const key = await storeFile(env, article, "wiley.pdf", bytes, "application/pdf");
  let text = ""; try { text = await pdfToText(env, bytes); } catch { /* best effort */ }
  return { fullTextStatus:"Captured", fullTextKey:key, fullTextLicense:"Publisher licence via your Wiley text-mining token", fullTextSource:"Wiley TDM API", fullTextOrigin:"Wiley TDM", fullTextRestricted:true, _text:text };
}
async function captureFromElsevier(env, article, reason) {
  if (!env.ELSEVIER_API_KEY || !validDoi(article.doi) || !elsevierDoi(article.doi)) return { fullTextStatus:reason };
  const response = await fetch("https://api.elsevier.com/content/article/doi/" + article.doi + "?httpAccept=text%2Fxml", { headers:{ "X-ELS-APIKey":env.ELSEVIER_API_KEY, ...(env.ELSEVIER_INSTTOKEN ? { "X-ELS-Insttoken":env.ELSEVIER_INSTTOKEN } : {}), Accept:"application/xml" }, signal:AbortSignal.timeout(60000) });
  if (!response.ok) return { fullTextStatus:response.status === 403 || response.status === 401 ? "Not covered by your Elsevier access" : reason };
  const bytes = await response.arrayBuffer(), xml = new TextDecoder().decode(bytes);
  // An entitlement problem returns a short abstract-only record; real full text has a body.
  if (bytes.byteLength > 15 * 1024 * 1024 || !/<full-text-retrieval-response\b/.test(xml) || !/<(ce:sections|xocs:rawtext|originalText)\b/.test(xml)) return { fullTextStatus:"Not covered by your Elsevier access" };
  const key = await storeFile(env, article, "elsevier.xml", bytes, "application/xml");
  return { fullTextStatus:"Captured", fullTextKey:key, fullTextLicense:"Publisher licence via your Elsevier text-mining key", fullTextSource:"Elsevier TDM API", fullTextOrigin:"Elsevier TDM", fullTextRestricted:true, _text:elsevierText(xml) };
}
async function captureFromCore(env, article, reason) {
  if (!env.CORE_API_KEY) return { fullTextStatus:reason };
  const title = normTitle(article.title), q = validDoi(article.doi) ? 'doi:"' + article.doi + '"' : title.length >= 25 ? 'title:"' + title.slice(0, 180) + '"' : "";
  if (!q) return { fullTextStatus:reason };
  const response = await fetch("https://api.core.ac.uk/v3/search/works?" + new URLSearchParams({ q, limit:"5" }), { headers:{ Authorization:"Bearer " + env.CORE_API_KEY }, signal:AbortSignal.timeout(25000) });
  if (!response.ok) return { fullTextStatus:reason }; // 401 bad key, 429 daily limit: not an error for the article
  const results = (await response.json()).results || [];
  const hit = results.find(r => (validDoi(article.doi) && String(r.doi || "").toLowerCase() === article.doi.toLowerCase()) || normTitle(r.title) === title);
  if (!hit) return { fullTextStatus:reason };
  const url = hit.downloadUrl || (hit.links || []).find(l => l.type === "download")?.url || "";
  if (/^https:\/\//.test(url)) {
    try {
      const file = await fetch(url, { signal:AbortSignal.timeout(30000), headers:{ Accept:"application/pdf" } }), bytes = await file.arrayBuffer();
      if (file.ok && bytes.byteLength <= maxPdfBytes && new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-") {
        const key = await storeFile(env, article, "core.pdf", bytes, "application/pdf");
        let text = String(hit.fullText || ""); if (text.length < 1500) { try { text = await pdfToText(env, bytes); } catch { /* best effort */ } }
        return { fullTextStatus:"Captured", fullTextKey:key, fullTextLicense:"Open repository copy (check the repository licence)", fullTextSource:url, fullTextOrigin:"CORE", fullTextRestricted:true, _text:text };
      }
    } catch { /* fall back to CORE's own text */ }
  }
  if (String(hit.fullText || "").length >= 1500) {
    const text = String(hit.fullText), key = await storeFile(env, article, "core.txt", new TextEncoder().encode(text), "text/plain; charset=utf-8");
    return { fullTextStatus:"Captured", fullTextKey:key, fullTextLicense:"Open repository copy (check the repository licence)", fullTextSource:"https://core.ac.uk/works/" + hit.id, fullTextOrigin:"CORE", fullTextRestricted:true, _text:text };
  }
  return { fullTextStatus:reason };
}
// bioRxiv and medRxiv DOIs (10.1101/...): their API names the JATS full-text XML of the preprint, with its licence.
async function captureFromRxiv(env, article, reason) {
  if (!validDoi(article.doi) || !/^10\.1101\//.test(article.doi)) return { fullTextStatus:reason };
  for (const server of ["biorxiv", "medrxiv"]) {
    const details = await fetch("https://api.biorxiv.org/details/" + server + "/" + article.doi + "/na/json", { signal:AbortSignal.timeout(20000) }).then(r => r.ok ? r.json() : null).catch(() => null);
    const item = details?.collection?.slice(-1)[0];
    if (!item?.jatsxml || !/^https:\/\//.test(item.jatsxml)) continue;
    const license = String(item.license || "").toLowerCase().replace(/_/g, "-").replace(/\s+/g, "-");
    if (!(env.ALLOW_RESTRICTED || openLicenses.includes(license))) continue;
    const file = await fetch(item.jatsxml, { signal:AbortSignal.timeout(30000) });
    if (!file.ok) continue;
    const bytes = await file.arrayBuffer(), xml = new TextDecoder().decode(bytes);
    if (bytes.byteLength > 15 * 1024 * 1024 || !/<article\b/.test(xml)) continue;
    const key = await storeFile(env, article, "rxiv.xml", bytes, "application/xml");
    return { fullTextStatus:"Captured", fullTextKey:key, fullTextLicense:license, fullTextSource:item.jatsxml, fullTextOrigin:server === "medrxiv" ? "medRxiv" : "bioRxiv", fullTextVersion:"preprint", fullTextRestricted:!openLicenses.includes(license), _text:xmlToText(xml) };
  }
  return { fullTextStatus:reason };
}
async function captureFullText(env, article, lookupOnce, coreOnce) {
  const pmc = await captureFromPmc(env, article);
  if (pmc.fullTextStatus === "Captured") return pmc;
  const europe = await captureFromEuropePmc(env, article, coreOnce, pmc.fullTextStatus);
  if (europe.fullTextStatus === "Captured") return europe;
  const unpaywall = await captureFromUnpaywall(env, article, pmc.fullTextStatus, lookupOnce);
  if (unpaywall.fullTextStatus === "Captured") return unpaywall;
  const scholar = await captureFromSemanticScholar(env, article, unpaywall.fullTextStatus).catch(() => ({ fullTextStatus:unpaywall.fullTextStatus }));
  if (scholar.fullTextStatus === "Captured") return scholar;
  // Optional tiers that need the user's own keys or apply to particular publishers; each failing one leaves the earlier reason in place.
  for (const tier of [captureFromWiley, captureFromElsevier, captureFromCore, captureFromRxiv]) {
    const result = await tier(env, article, unpaywall.fullTextStatus).catch(() => null);
    if (result?.fullTextStatus === "Captured") return result;
    if (result && /^Not covered by your/.test(result.fullTextStatus)) unpaywall.fullTextStatus = result.fullTextStatus;
  }
  const preprint = await captureFromPreprint(env, article, unpaywall.fullTextStatus).catch(() => ({ fullTextStatus:unpaywall.fullTextStatus }));
  return preprint.fullTextStatus === "Captured" ? preprint : unpaywall;
}
// Crossref update notices (publisher and Retraction Watch sources) for the article's DOI.
const noticeTypes = { retraction:"Retracted", withdrawal:"Retracted", removal:"Retracted",
  expression_of_concern:"Expression of concern", correction:"Correction", erratum:"Correction" };
const noticeRank = ["Retracted","Expression of concern","Correction"];
const retractionRecheckMs = 30 * 86400000;
async function checkRetraction(env, article) {
  const checked = { retractionCheckedAt:new Date().toISOString() };
  const flagged = article.pubmedRetracted ? "Retracted" : "";
  if (!/^10\.\d{4,9}\/\S+$/.test(article.doi)) return { ...checked, retractionStatus:flagged || "No DOI to check" };
  const url = new URL("https://api.crossref.org/works/" + encodeURIComponent(article.doi));
  const mailto = env.CROSSREF_EMAIL || env.UNPAYWALL_EMAIL;
  if (mailto) url.searchParams.set("mailto", mailto);
  const response = await fetch(url, { signal:AbortSignal.timeout(15000) });
  if (response.status === 404) return { ...checked, retractionStatus:flagged || "Not in Crossref" };
  if (!response.ok) throw new Error("Crossref returned HTTP " + response.status);
  const { message = {} } = await response.json();
  const seen = new Set();
  const notices = (message["updated-by"] || []).map(u => ({ label:noticeTypes[String(u.type || "").toLowerCase()],
    type:u.type, doi:u.DOI, source:u.source, date:(u.updated?.["date-time"] || "").slice(0,10) }))
    .filter(n => n.label && !seen.has(n.label + n.doi) && seen.add(n.label + n.doi));
  const worst = [flagged, ...notices.map(n => n.label)].filter(Boolean).sort((a,b) => noticeRank.indexOf(a) - noticeRank.indexOf(b))[0];
  return { ...checked, retractionStatus:worst || "None found", retractionNotices:notices.slice(0,10) };
}
// ---- PDF export (dependency-free): a cover page, then one section per article with its PubMed screenshot ----
const pdfPage = [595.28, 841.89], pdfMargin = 36, pdfMaxSlices = 4, pdfMaxArticles = 40;
const latin = value => String(value ?? "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
  .replace(/…/g, "...").replace(/[^\x20-\x7e\xa0-\xff]/g, c => c.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7e]/g, "?"));
const pdfEscape = value => latin(value).replace(/[\\()]/g, "\\$&");
const textBytes = value => Uint8Array.from(value, c => c.charCodeAt(0) & 255);
function textWidth(value, size, bold) {
  let units = 0;
  for (const c of latin(value)) units += "ijl.,;:'|!()[] tfI".includes(c) ? 0.28 : "mwMW@%".includes(c) ? 0.85 : /[A-Z]/.test(c) ? 0.68 : /[0-9]/.test(c) ? 0.556 : 0.5;
  return units * size * (bold ? 1.06 : 1);
}
function wrap(value, size, bold, width) {
  const lines = []; let line = "";
  for (const word of latin(value).split(/\s+/).filter(Boolean)) {
    const test = line ? line + " " + word : word;
    if (line && textWidth(test, size, bold) > width * 0.93) { lines.push(line); line = word; } else line = test;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}
async function pipeBytes(bytes, stream) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer()); }
// Reads an 8-bit non-interlaced PNG and returns data ready for a PDF FlateDecode image (alpha is flattened onto white).
async function readPng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 33 || view.getUint32(0) !== 0x89504e47) throw new Error("Not a PNG image.");
  let pos = 8, header, parts = [];
  while (pos + 8 <= bytes.length) {
    const length = view.getUint32(pos), type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8)), data = bytes.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") header = { width:view.getUint32(pos + 8), height:view.getUint32(pos + 12), depth:data[8], color:data[9], interlace:data[12] };
    if (type === "IDAT") parts.push(data);
    if (type === "IEND") break;
    pos += 12 + length;
  }
  if (!header || header.depth !== 8 || header.interlace || ![0, 2, 6].includes(header.color)) throw new Error("Unsupported PNG format.");
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((offset, p) => (joined.set(p, offset), offset + p.length), 0);
  const { width, height, color } = header;
  if (color !== 6) return { width, height, space:color === 2 ? "/DeviceRGB" : "/DeviceGray", columns:width, colors:color === 2 ? 3 : 1, data:joined, predictor:true };
  const raw = await pipeBytes(joined, new DecompressionStream("deflate")), stride = width * 4, rgb = new Uint8Array(width * height * 3);
  const prior = new Uint8Array(stride), row = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? row[i - 4] : 0, b = prior[i], c = i >= 4 ? prior[i - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predict = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      row[i] = (line[i] + predict) & 255;
    }
    for (let x = 0; x < width; x++) {
      const alpha = row[x * 4 + 3] / 255;
      for (let k = 0; k < 3; k++) rgb[(y * width + x) * 3 + k] = Math.round(row[x * 4 + k] * alpha + 255 * (1 - alpha));
    }
    prior.set(row);
  }
  return { width, height, space:"/DeviceRGB", columns:width, colors:3, data:await pipeBytes(rgb, new CompressionStream("deflate")), predictor:false };
}
async function buildPdf(title, subtitle, sections) {
  const objects = [null, null]; // 1 = catalog, 2 = page tree
  const add = parts => objects.push(parts) && objects.length;
  const regular = add(["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"]);
  const bold = add(["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"]);
  const pages = [], images = [];
  const newPage = () => { const page = { ops:[], xobjects:[] }; pages.push(page); return page; };
  const text = (page, x, y, value, size, isBold = false, gray = 0.1) =>
    page.ops.push(`BT ${gray} ${gray} ${gray} rg /F${isBold ? 2 : 1} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${pdfEscape(value)}) Tj ET`);
  const [pw, ph] = pdfPage, inner = pw - 2 * pdfMargin;
  const cover = newPage();
  text(cover, pdfMargin, ph - 90, title, 26, true);
  let y = ph - 122;
  for (const line of wrap(subtitle, 12, false, inner)) { text(cover, pdfMargin, y, line, 12, false, 0.35); y -= 17; }
  text(cover, pdfMargin, y - 10, sections.length + " article" + (sections.length === 1 ? "" : "s") + " · generated " + new Date().toISOString().slice(0, 10), 11, false, 0.35);
  for (const section of sections) {
    let page = newPage(), top = ph - pdfMargin;
    for (const line of wrap(section.title, 14, true, inner)) { text(page, pdfMargin, top - 14, line, 14, true); top -= 18; }
    top -= 4;
    for (const entry of section.lines) for (const line of wrap(entry, 9, false, inner)) { text(page, pdfMargin, top - 9, line, 9, false, 0.3); top -= 12.5; }
    top -= 8;
    let image;
    if (section.png) { try { image = await readPng(section.png); } catch { image = null; } }
    if (!image) { text(page, pdfMargin, top - 12, section.png ? "(Screenshot could not be embedded.)" : "(Screenshot not captured yet.)", 10, false, 0.5); continue; }
    const id = images.length; images.push(image);
    const scale = inner / image.width, fullHeight = image.height * scale;
    let offset = 0, slices = 0;
    while (offset < fullHeight && slices < pdfMaxSlices) {
      const windowHeight = Math.min(top - pdfMargin - 14, fullHeight - offset), bottom = top - windowHeight;
      page.ops.push(`q ${pdfMargin} ${bottom.toFixed(2)} ${inner.toFixed(2)} ${windowHeight.toFixed(2)} re W n ${inner.toFixed(2)} 0 0 ${fullHeight.toFixed(2)} ${pdfMargin} ${(top + offset - fullHeight).toFixed(2)} cm /Im${id} Do Q`);
      page.ops.push(`0.8 G ${pdfMargin} ${bottom.toFixed(2)} ${inner.toFixed(2)} ${windowHeight.toFixed(2)} re S`);
      if (!page.xobjects.includes(id)) page.xobjects.push(id);
      offset += windowHeight; slices++;
      if (offset < fullHeight && slices < pdfMaxSlices) { page = newPage(); top = ph - pdfMargin; }
    }
    if (offset < fullHeight) text(page, pdfMargin, pdfMargin - 4, "(Screenshot continues on PubMed; remaining part omitted.)", 8, false, 0.5);
  }
  const imageIds = images.map(image => {
    const dict = `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace ${image.space} /BitsPerComponent 8 /Filter /FlateDecode` +
      (image.predictor ? ` /DecodeParms << /Predictor 15 /Colors ${image.colors} /BitsPerComponent 8 /Columns ${image.columns} >>` : "") + ` /Length ${image.data.length} >>`;
    return add([dict + "\nstream\n", image.data, "\nendstream"]);
  });
  const pageIds = pages.map((page, index) => {
    text(page, pw - pdfMargin - 40, 18, "Page " + (index + 1), 8, false, 0.5);
    const content = textBytes(page.ops.join("\n"));
    const contentId = add([`<< /Length ${content.length} >>\nstream\n`, content, "\nendstream"]);
    const xobjects = page.xobjects.map(id => `/Im${id} ${imageIds[id]} 0 R`).join(" ");
    return add([`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> /XObject << ${xobjects} >> >> /Contents ${contentId} 0 R >>`]);
  });
  objects[0] = ["<< /Type /Catalog /Pages 2 0 R >>"];
  objects[1] = [`<< /Type /Pages /Kids [${pageIds.map(id => id + " 0 R").join(" ")}] /Count ${pageIds.length} >>`];
  const chunks = [], offsets = []; let length = 0;
  const push = piece => { const bytes = typeof piece === "string" ? textBytes(piece) : piece; chunks.push(bytes); length += bytes.length; };
  push("%PDF-1.4\n");
  objects.forEach((parts, index) => { offsets.push(length); push(`${index + 1} 0 obj\n`); parts.forEach(push); push("\nendobj\n"); });
  const xref = length;
  push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length); let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}
async function exportPdf(env, state, viewer, manager, body) {
  const wanted = [...new Set(Array.isArray(body.pmids) ? body.pmids.map(String) : [])].slice(0, pdfMaxArticles);
  const sections = [], numbering = new Map();
  if (body.layout === true || body.layout === "country") for (const e of libraryLayout(state, body.layout === "country" ? "country" : "range")) if (!numbering.has(e.pmid)) numbering.set(e.pmid, e);
  for (const id of wanted) {
    const article = state.articles[id];
    const item = state.assignments.find(a => a.pmid === id && (manager || a.reviewer === viewer.email));
    if (!article || !item) continue;
    // A PDF always carries an up-to-date snapshot: one made before the current record-card layout is taken again first (needs the screenshot service on the server).
    let fresh = article;
    if (env.SCREENSHOT_FN && article.source !== "Social media" && (!article.screenshotKey || article.screenshotKind !== "record2")) {
      try { const status = await captureScreenshot(env, article); await write(env, data => Object.assign(data.articles[id], status)); fresh = { ...article, ...status }; } catch { /* the earlier snapshot, if any, is used */ }
    }
    let png = null;
    if (fresh.screenshotKey) { const object = await env.BUCKET.get(fresh.screenshotKey); if (object) png = new Uint8Array(await object.arrayBuffer()); }
    const lines = ["Source: " + articleSource(article) + " · PMID " + id + " · " + [article.journal, article.date].filter(Boolean).join(" · "),
      "DOI: " + (article.doi || "-") + " · " + article.url,
      "Portfolio: " + item.portfolio + ((item.molecules || []).filter(m => m !== item.portfolio).length ? " · Molecules: " + item.molecules.join(", ") : ""),
      "Reviewer: " + (item.reviewer || "Unassigned") + " · Status: " + item.status + (item.note ? " · Note: " + item.note : ""),
      "Retraction check: " + (article.retractionStatus || "Pending") + " · Access: " + (article.oaStatus || "Pending") + " · Full text: " + (article.fullTextStatus || "Pending") +
        (article.citedBy !== undefined ? " · Cited by: " + article.citedBy : "")];
    if (article.pullQuery) lines.push("Search query: " + article.pullQuery + " · Date range: " + (article.pullRange || "-") + " · Retrieved: " + (article.pullAt ? article.pullAt.slice(0, 16).replace("T", " ") + " UTC" : "-"));
    if (fresh.screenshotAt) lines.push("Snapshot taken: " + fresh.screenshotAt.slice(0, 16).replace("T", " ") + " UTC");
    if ((article.authors || []).length) lines.push("Authors: " + article.authors.join(", "));
    if ((article.meshTerms || []).length) lines.push("MeSH: " + article.meshTerms.slice(0, 12).join("; "));
    if (article.abstract) lines.push("Abstract: " + article.abstract.replace(/\s+/g, " ").slice(0, 1800));
    for (const passage of (article.keyPassages || []).slice(0, 4)) lines.push("Key passage: " + passage);
    const entry = numbering.get(id);
    if (entry) lines.unshift("Library: " + entry.folder + " · No. " + libTag(entry));
    sections.push({ title:(entry ? "No. " + libTag(entry) + "  " : "") + article.title, lines, png });
  }
  if (!sections.length) return null;
  return buildPdf(String(body.title || "LiteraSift export").slice(0, 100), String(body.subtitle || "PubMed citations with page screenshots.").slice(0, 300), sections);
}
// ---- Countries: where the article's authors are, and where the patient was. Country drives regulator and marketing-authorisation checks. ----
// [name, ISO2, aliases, demonyms, regulator]. Matching is by whole words; ambiguous names (Georgia, Jordan, Chad) are left out on purpose.
const EU_NCA = "National competent authority (EU/EEA) via EudraVigilance";
const COUNTRIES = [
  ["United States","US",["usa","u.s.a.","u.s.","united states of america","united states"],["american"],"US FDA"],
  ["United Kingdom","GB",["uk","u.k.","england","scotland","wales","northern ireland","great britain","united kingdom"],["british","english","scottish","welsh"],"UK MHRA"],
  ["Canada","CA",["canada"],["canadian"],"Health Canada"],
  ["Germany","DE",["germany","deutschland"],["german"],EU_NCA],["France","FR",["france"],["french"],EU_NCA],["Italy","IT",["italy"],["italian"],EU_NCA],["Spain","ES",["spain"],["spanish"],EU_NCA],
  ["Netherlands","NL",["netherlands","the netherlands","holland"],["dutch"],EU_NCA],["Belgium","BE",["belgium"],["belgian"],EU_NCA],["Austria","AT",["austria"],["austrian"],EU_NCA],["Ireland","IE",["ireland"],["irish"],EU_NCA],
  ["Portugal","PT",["portugal"],["portuguese"],EU_NCA],["Greece","GR",["greece"],["greek"],EU_NCA],["Sweden","SE",["sweden"],["swedish"],EU_NCA],["Denmark","DK",["denmark"],["danish"],EU_NCA],["Finland","FI",["finland"],["finnish"],EU_NCA],
  ["Poland","PL",["poland"],["polish"],EU_NCA],["Czech Republic","CZ",["czech republic","czechia"],["czech"],EU_NCA],["Hungary","HU",["hungary"],["hungarian"],EU_NCA],["Romania","RO",["romania"],["romanian"],EU_NCA],
  ["Bulgaria","BG",["bulgaria"],["bulgarian"],EU_NCA],["Croatia","HR",["croatia"],["croatian"],EU_NCA],["Slovenia","SI",["slovenia"],["slovenian"],EU_NCA],["Slovakia","SK",["slovakia"],["slovak"],EU_NCA],
  ["Norway","NO",["norway"],["norwegian"],EU_NCA],["Iceland","IS",["iceland"],["icelandic"],EU_NCA],["Luxembourg","LU",["luxembourg"],[],EU_NCA],["Estonia","EE",["estonia"],["estonian"],EU_NCA],["Latvia","LV",["latvia"],["latvian"],EU_NCA],["Lithuania","LT",["lithuania"],["lithuanian"],EU_NCA],
  ["Switzerland","CH",["switzerland"],["swiss"],"Swissmedic"],["Japan","JP",["japan"],["japanese"],"PMDA / MHLW"],["China","CN",["china","p.r. china","pr china","people's republic of china","peoples republic of china"],["chinese"],"NMPA"],
  ["India","IN",["india"],["indian"],"CDSCO / PvPI"],["South Korea","KR",["south korea","republic of korea","korea"],["korean"],"MFDS"],["Taiwan","TW",["taiwan"],["taiwanese"],"TFDA"],["Hong Kong","HK",["hong kong"],[],"Department of Health (Hong Kong)"],
  ["Singapore","SG",["singapore"],["singaporean"],"HSA"],["Thailand","TH",["thailand"],["thai"],"Thai FDA"],["Malaysia","MY",["malaysia"],["malaysian"],"NPRA"],["Indonesia","ID",["indonesia"],["indonesian"],"BPOM"],
  ["Philippines","PH",["philippines"],["filipino","philippine"],"FDA Philippines"],["Vietnam","VN",["vietnam","viet nam"],["vietnamese"],"DAV"],["Pakistan","PK",["pakistan"],["pakistani"],"DRAP"],["Bangladesh","BD",["bangladesh"],["bangladeshi"],"DGDA"],
  ["Sri Lanka","LK",["sri lanka"],["sri lankan"],"NMRA"],["Nepal","NP",["nepal"],["nepalese"],"DDA Nepal"],["Australia","AU",["australia"],["australian"],"TGA"],["New Zealand","NZ",["new zealand"],["new zealander"],"Medsafe"],
  ["Brazil","BR",["brazil","brasil"],["brazilian"],"ANVISA"],["Mexico","MX",["mexico"],["mexican"],"COFEPRIS"],["Argentina","AR",["argentina"],["argentine","argentinian"],"ANMAT"],["Chile","CL",["chile"],["chilean"],"ISP Chile"],
  ["Colombia","CO",["colombia"],["colombian"],"INVIMA"],["Peru","PE",["peru"],["peruvian"],"DIGEMID"],["Turkey","TR",["turkey","turkiye","türkiye"],["turkish"],"TITCK"],["Israel","IL",["israel"],["israeli"],"Israel Ministry of Health"],
  ["Saudi Arabia","SA",["saudi arabia"],["saudi"],"SFDA"],["United Arab Emirates","AE",["united arab emirates","uae"],["emirati"],"UAE MOHAP / EDE"],["Iran","IR",["iran"],["iranian"],"Iran FDA"],["Egypt","EG",["egypt"],["egyptian"],"EDA"],
  ["South Africa","ZA",["south africa"],["south african"],"SAHPRA"],["Nigeria","NG",["nigeria"],["nigerian"],"NAFDAC"],["Kenya","KE",["kenya"],["kenyan"],"PPB Kenya"],["Ethiopia","ET",["ethiopia"],["ethiopian"],"EFDA"],
  ["Ghana","GH",["ghana"],["ghanaian"],"FDA Ghana"],["Tanzania","TZ",["tanzania"],["tanzanian"],"TMDA"],["Uganda","UG",["uganda"],["ugandan"],"NDA Uganda"],["Morocco","MA",["morocco"],["moroccan"],"DMP Morocco"],
  ["Tunisia","TN",["tunisia"],["tunisian"],"DPM Tunisia"],["Russia","RU",["russia","russian federation"],["russian"],"Roszdravnadzor"],["Ukraine","UA",["ukraine"],["ukrainian"],"State Expert Centre (Ukraine)"],
  ["Serbia","RS",["serbia"],["serbian"],"ALIMS"],["Lebanon","LB",["lebanon"],["lebanese"],"Lebanon Ministry of Public Health"],["Iraq","IQ",["iraq"],["iraqi"],"Iraq Ministry of Health"],["Qatar","QA",["qatar"],["qatari"],"MOPH Qatar"],
  ["Kuwait","KW",["kuwait"],["kuwaiti"],"Kuwait Ministry of Health"],["Cuba","CU",["cuba"],["cuban"],"CECMED"],["Venezuela","VE",["venezuela"],["venezuelan"],"INHRR"],["Ecuador","EC",["ecuador"],["ecuadorian"],"ARCSA"] ];
const COUNTRY_INDEX = new Map(), COUNTRY_BY_NAME = new Map();
for (const [name, iso, aliases, demonyms, regulator] of COUNTRIES) {
  const info = { name, iso, regulator };
  COUNTRY_BY_NAME.set(name.toLowerCase(), info);
  for (const alias of [name.toLowerCase(), ...aliases]) COUNTRY_INDEX.set(alias, { ...info, kind:"name" });
  for (const d of demonyms) COUNTRY_INDEX.set(d, { ...info, kind:"demonym" });
}
const countryRegex = new RegExp("(?<![a-z0-9])(" + [...COUNTRY_INDEX.keys()].sort((a, b) => b.length - a.length).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")(?![a-z0-9])", "gi");
// "Dept of X, Tokyo, Japan." -> Japan: the last country named in an affiliation.
function countryFromAffiliation(text) {
  const matches = [...String(text || "").replace(/[.;]+$/, "").matchAll(countryRegex)].filter(m => COUNTRY_INDEX.get(m[1].toLowerCase()).kind === "name");
  return matches.length ? COUNTRY_INDEX.get(matches[matches.length - 1][1].toLowerCase()) : null;
}
const patientWords = /\b(patient|man|woman|boy|girl|male|female|child|infant|neonate|newborn|toddler|adolescent|case|admitted|hospital|presented)\b/i;
// A country attached to the patient in a case-report sentence ("a 54-year-old Japanese man", "a patient from Brazil").
function patientCountryFrom(text) {
  for (const sentence of String(text || "").split(/(?<=[.!?])\s+/)) {
    if (!patientWords.test(sentence)) continue;
    for (const m of sentence.matchAll(countryRegex)) {
      const hit = COUNTRY_INDEX.get(m[1].toLowerCase()), before = sentence.slice(Math.max(0, m.index - 40), m.index).toLowerCase();
      if (hit.kind === "demonym" || /\b(in|from|of|at|to|across)\s+(the\s+)?$/.test(before) || /\b(patient|man|woman)\s+from\s+$/.test(before)) return { name:hit.name, iso:hit.iso, evidence:sentence.trim().slice(0, 240) };
    }
  }
  return null;
}
const countryInfo = name => COUNTRY_BY_NAME.get(String(name || "").toLowerCase()) || COUNTRY_INDEX.get(String(name || "").toLowerCase()) || null;
const articleCountry = a => a?.patientCountry?.name ? { name:a.patientCountry.name, basis:"patient" } : a?.affiliationCountry ? { name:a.affiliationCountry, basis:"author affiliation" } : a?.journalCountry ? { name:countryInfo(a.journalCountry)?.name || a.journalCountry, basis:"journal" } : { name:"Unknown", basis:"" };
// ---- Important Medical Events (IME) and automatic event detection ----
// The EMA IME list (MedDRA preferred terms) is loaded from storage, uploaded by a manager in Settings. It is NOT shipped in this repository:
// MedDRA content is licensed by the MSSO/ICH. Matching follows PV Nexus's lib/ime-list.ts (whole-phrase match, demoted PTs inherit the flag).
const imeNorm = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9\- ]+/g, " ").replace(/\s+/g, " ").trim();
function buildIme(json) {
  const terms = (json?.terms || []).filter(t => Array.isArray(t) && t[1]).map(([code, name, soc, added]) => ({ code:String(code || ""), name:String(name), soc:String(soc || ""), added:Boolean(added) }));
  const byName = new Map(terms.map(t => [imeNorm(t.name), t]).filter(([k]) => k));
  const demoted = new Map((json?.demoted || []).map(([code, name, soc, parent]) => [imeNorm(name), { code:String(code), name:String(name), soc:String(soc), parent:String(parent) }]));
  return { byName, demoted, maxWords:Math.max(1, ...[...byName.keys()].map(k => k.split(" ").length)),
    info:{ version:String(json?.version || ""), reference:String(json?.reference || ""), released:json?.released || null, title:String(json?.title || ""), count:byName.size, added:terms.filter(t => t.added).length, demoted:demoted.size,
      label:"EMA IME list, MedDRA " + (json?.version || "?") } };
}
// Accepts PV Nexus's ime-meddra.json, or a CSV/TXT with one preferred term per line (optional header "PT Name", "MedDRA Code", "SOC Name").
function parseImeUpload(text) {
  const raw = String(text || "").replace(/^﻿/, "").trim();
  if (raw.startsWith("{")) { const json = JSON.parse(raw); if (!Array.isArray(json.terms) || !json.terms.length) throw new Error("This JSON has no terms list."); return { terms:json.terms.slice(0, 30000), version:json.version, reference:json.reference, released:json.released, title:json.title, demoted:json.demoted || [] }; }
  const rows = raw.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith("#")).map(line => { const sep = line.includes("\t") ? "\t" : line.includes(";") && !line.includes(",") ? ";" : ","; const cells = []; let cur = "", q = false; for (const ch of line) { if (ch === '"') q = !q; else if (ch === sep && !q) { cells.push(cur); cur = ""; } else cur += ch; } cells.push(cur); return cells.map(c => c.replace(/\s+/g, " ").trim()); });
  let header = -1, cName = -1, cCode = -1, cSoc = -1, version = null, reference = null;
  rows.slice(0, 60).forEach((cells, i) => {
    version ||= /version\s+([\d.]+)/i.exec(cells.join(" "))?.[1] || null; reference ||= cells.find(c => /^EMA\//.test(c)) || null;
    const n = cells.findIndex(c => /^(pt[ _-]?name|preferred[ _-]?term|pt|term|event|name)$/i.test(c));
    if (n >= 0 && header < 0) { header = i; cName = n; cCode = cells.findIndex(c => /^(meddra[ _-]?code|pt[ _-]?code|code)$/i.test(c)); cSoc = cells.findIndex(c => /^(soc[ _-]?name|soc|system organ class)$/i.test(c)); }
  });
  const seen = new Set(), terms = [];
  for (let i = header + 1; i < rows.length && terms.length < 30000; i++) {
    const r = rows[i], name = header >= 0 ? r[cName] || "" : r.find(c => c && !/^\d{6,9}$/.test(c)) || "";
    if (name.length < 3 || name.length > 160 || /^\d+$/.test(name) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const code = header >= 0 && cCode >= 0 ? r[cCode] : r.find(c => /^\d{8}$/.test(c));
    terms.push([/^\d{6,9}$/.test(code || "") ? code : "", name, cSoc >= 0 ? r[cSoc] || "" : "", 0]);
  }
  if (!terms.length) throw new Error("No preferred terms found. Use one term per line, or a CSV with a \"PT Name\" column.");
  return { terms, version, reference, demoted:[] };
}
// ---- Spreadsheet (.xlsx) reading with no dependencies: a workbook is a zip of XML files, inflated with the platform's DecompressionStream. ----
async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function unzipEntries(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 70000); i--) if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error("This is not a zip or xlsx file.");
  const count = view.getUint16(end + 10, true), decoder = new TextDecoder(), entries = new Map();
  let pos = view.getUint32(end + 16, true);
  for (let n = 0; n < count && n < 500; n++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const method = view.getUint16(pos + 10, true), size = view.getUint32(pos + 20, true), nameLength = view.getUint16(pos + 28, true), extraLength = view.getUint16(pos + 30, true), commentLength = view.getUint16(pos + 32, true), local = view.getUint32(pos + 42, true);
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLength));
    pos += 46 + nameLength + extraLength + commentLength;
    if (!/^xl\/(workbook\.xml|sharedStrings\.xml|worksheets\/sheet\d+\.xml|_rels\/workbook\.xml\.rels)$/.test(name)) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true), data = bytes.subarray(start, start + size);
    entries.set(name, decoder.decode(method === 0 ? data : await inflateRaw(data)));
  }
  return entries;
}
const colIndex = letters => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
// Returns [{ name, rows: [[cell, ...], ...] }] with every cell as text.
async function readXlsx(buffer) {
  const files = await unzipEntries(buffer);
  const shared = [...(files.get("xl/sharedStrings.xml") || "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => decodeXml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join("")));
  const rels = new Map([...(files.get("xl/_rels/workbook.xml.rels") || "").matchAll(/<Relationship\b[^>]*>/g)].map(m => [/Id="([^"]+)"/.exec(m[0])?.[1], /Target="([^"]+)"/.exec(m[0])?.[1]]));
  const sheets = [];
  for (const m of (files.get("xl/workbook.xml") || "").matchAll(/<sheet\b[^>]*>/g)) {
    const name = decodeXml(/name="([^"]*)"/.exec(m[0])?.[1] || ""), target = String(rels.get(/r:id="([^"]+)"/.exec(m[0])?.[1]) || "").replace(/^\/?(xl\/)?/, "xl/"), xml = files.get(target);
    if (!xml) continue;
    const rows = [];
    for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const cells = [];
      for (const c of (row[1] || "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /r="([A-Z]+)\d+"/.exec(c[1]);
        if (!ref) continue;
        const inner = c[2] || "", v = /<v>([\s\S]*?)<\/v>/.exec(inner), inline = /<is>([\s\S]*?)<\/is>/.exec(inner);
        cells[colIndex(ref[1])] = /t="s"/.test(c[1]) && v ? shared[Number(v[1])] ?? "" : inline ? decodeXml([...inline[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join("")) : v ? decodeXml(v[1]) : "";
      }
      rows.push(Array.from(cells, c => c ?? ""));
    }
    sheets.push({ name, rows });
  }
  return sheets;
}
// The EMA IME workbook: a list sheet (MedDRA Code, PT Name, SOC Name, Comment, "Added in x", "Primary SOC Change") and a "Deleted PTs" sheet of demoted terms.
function parseImeWorkbook(sheets) {
  const norm = v => String(v ?? "").trim();
  const list = sheets.find(s => s.rows.some(r => r.some(c => /^pt name$/i.test(norm(c))))) || sheets[0];
  if (!list) throw new Error("The workbook has no sheets.");
  const head = list.rows.findIndex(r => r.some(c => /^pt name$/i.test(norm(c))));
  if (head < 0) throw new Error("No \"PT Name\" column found in the first sheet.");
  const col = re => list.rows[head].findIndex(c => re.test(norm(c))), cCode = col(/^meddra code$/i), cName = col(/^pt name$/i), cSoc = col(/^soc name$/i), cAdded = col(/^added in/i);
  const top = list.rows.slice(0, head).flat().map(norm).filter(Boolean), serial = Number(top.find(c => /^\d{5}$/.test(c)));
  const terms = [], seen = new Set();
  for (const r of list.rows.slice(head + 1)) {
    const name = norm(r[cName]);
    if (name.length < 3 || name.length > 160 || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    terms.push([/^\d{6,9}$/.test(norm(r[cCode])) ? norm(r[cCode]) : "", name, norm(r[cSoc]), cAdded >= 0 && norm(r[cAdded]) ? 1 : 0]);
  }
  const deleted = sheets.find(s => s !== list && /deleted|demoted/i.test(s.name)), demoted = [];
  if (deleted) {
    const h = deleted.rows.findIndex(r => r.some(c => /^term$/i.test(norm(c)))), d = deleted.rows[h] || [];
    for (const r of deleted.rows.slice(h + 1)) { const name = norm(r[d.findIndex(c => /^term$/i.test(norm(c)))]); if (name) demoted.push([norm(r[0]), name, norm(r[2]), /Demoted under PT (.+?),/.exec(norm(r[3]))?.[1] || ""]); }
  }
  if (!terms.length) throw new Error("No preferred terms found in the workbook.");
  const title = top.find(c => /important medical event/i.test(c)) || "";
  return { terms:terms.slice(0, 30000), demoted, title, version:/version\s+([\d.]+)/i.exec(title)?.[1] || null, reference:top.find(c => /^EMA\//.test(c)) || null,
    released:serial ? new Date(Date.UTC(1899, 11, 30) + serial * 86400000).toISOString().slice(0, 10) : null };
}
let imeCache = { at:0, value:null };
async function loadIme(env) {
  if (Date.now() - imeCache.at < 30000) return imeCache.value;
  let value = null;
  try { const object = await env.BUCKET.get("ime/current.json"); if (object) value = buildIme(await object.json()); } catch { /* treated as no list */ }
  imeCache = { at:Date.now(), value };
  return value;
}
const imeInvalidate = () => { imeCache = { at:0, value:null }; };
// ---- Negation (NegEx algorithm). Trigger lists are the English clinical term sets from negspacy (MIT, Copyright (c) 2019 Jeno Pizarro; see THIRD_PARTY_NOTICES.md). ----
const NEGEX = { pseudo:["gram negative", "might not", "no change", "no definite change", "no further", "no increase", "no interval change", "no significant change", "no significant interval change", "no suspicious change", "not able to be", "not been ruled out", "not cause", "not certain if", "not certain whether", "not drain", "not extend", "not necessarily", "not only", "not rule out", "not ruled out", "without any further", "without difficulty", "without further"],
  pre:["absence of", "aren't", "arent", "can't", "cannot", "cant", "couldn't", "couldnt", "declined", "denied", "denies", "denying", "did not exhibit", "didn't", "didnt", "doesn't", "doesnt", "don't", "dont", "doubt", "evaluate for", "fails to reveal", "free of", "isn't", "isnt", "negative for", "never", "never developed", "never had", "no", "no cause of", "no complaints of", "no evidence of", "no sign of", "no signs of", "not", "not demonstrate", "patient was not", "r/o", "ro", "rule her out", "rule him out", "rule out", "rule patient out", "rule the patient out", "ruled her out", "ruled him out", "ruled out", "ruled patient out", "ruled the patient out", "rules out", "symptoms atypical", "versus", "wasn't", "wasnt", "weren't", "werent", "without", "without any reactions or signs of", "without indication of", "without sign of", "without signs of"],
  post:["declined", "free", "unlikely", "was not", "was ruled out", "wasn't", "wasnt", "were not", "were ruled out", "weren't", "werent"],
  stop:["although", "apart from", "as there are", "aside from", "but", "cause for", "cause of", "causes for", "causes of", "etiology for", "etiology of", "except", "however", "involving", "nevertheless", "origin for", "origin of", "origins for", "origins of", "other possibilities of", "reason for", "reason of", "reasons for", "reasons of", "secondary to", "source for", "source of", "sources for", "sources of", "still", "though", "trigger event for", "which", "yet"] };
const negexRe = list => new RegExp("(?:^| )(" + [...new Set(list.map(imeNorm).filter(Boolean))].sort((a, b) => b.length - a.length).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")(?= |$)", "g");
const NEGEX_RE = { pseudo:negexRe(NEGEX.pseudo), pre:negexRe(NEGEX.pre), post:negexRe(NEGEX.post), stop:negexRe(NEGEX.stop) };
const negexScan = (text, re) => [...text.matchAll(re)].map(m => ({ at:m.index + (m[0].startsWith(" ") ? 1 : 0), len:m[1].length }));
const overlaps = (a, b) => a.at < b.at + b.len && b.at < a.at + a.len;
// True when the words [start, end) of a normalised sentence are negated: a trigger before or after them, with no scope-ending word in between.
function isNegated(words, start, end) {
  const before = words.slice(Math.max(0, start - 6), start).join(" "), after = words.slice(end, end + 4).join(" ");
  const pseudoBefore = negexScan(before, NEGEX_RE.pseudo), pre = negexScan(before, NEGEX_RE.pre).filter(t => !pseudoBefore.some(p => overlaps(t, p)));
  if (pre.length) { const last = pre[pre.length - 1]; if (!negexScan(before.slice(last.at + last.len), NEGEX_RE.stop).length) return true; }
  const pseudoAfter = negexScan(after, NEGEX_RE.pseudo), post = negexScan(after, NEGEX_RE.post).filter(t => !pseudoAfter.some(p => overlaps(t, p)));
  if (post.length && !negexScan(after.slice(0, post[0].at), NEGEX_RE.stop).length) return true;
  return false;
}

const EVENT_VERSION = 5;
// Candidate adverse events in the title and abstract, each with the sentence that supports it. IME terms come first.
// ---- Verbatim phraser: finds the exact words the article used for an event, the sentence around them and the section they sit in ----
const paperSentences = text => String(text || "").replace(/[ \t]+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z(\[])|\n+/).map(s => s.trim()).filter(s => s.length > 3);
const HEADING_RE = /^(abstract|introduction|background|case (report|presentation|description|summary|history)|patient (information|presentation)|clinical (course|presentation)|history of present illness|methods?|results?|discussion|conclusions?|outcome( and follow[- ]up)?|follow[- ]up|investigations?|diagnosis|treatment|timeline|references)\s*:?$/i;
const NARRATIVE_RE = /case|patient|clinical|history|course|presentation|outcome|follow|timeline|investigation|diagnos|treatment|results?$/i, SKIP_RE = /^(references|introduction|background|discussion|methods?|abstract|conclusions?)$/i;
const PATIENT_RE = /\b(patient|he|she|his|her|man|woman|boy|girl|infant|neonate|year[- ]old|month[- ]old|admitted|presented)\b/i;
function fullTextSections(text) {
  const out = []; let name = "Full text", buf = [];
  const flush = () => { if (buf.length) out.push({ name, text:buf.join("\n") }); buf = []; };
  for (const line of String(text || "").split(/\n/)) {
    const t = line.trim(), bare = t.replace(/^\d+(\.\d+)*\.?\s*/, "");
    if (t.length <= 60 && HEADING_RE.test(bare)) { flush(); name = bare.replace(/:$/, ""); } else if (t) buf.push(t);
  }
  flush();
  return out;
}
// The part of a full text that describes the patient: case sections if the paper has them, otherwise sentences about a patient or the drug.
function caseNarrative(text, molecules) {
  const names = (molecules || []).map(m => String(m).toLowerCase()).filter(Boolean);
  let parts = fullTextSections(text).filter(s => NARRATIVE_RE.test(s.name) && !SKIP_RE.test(s.name)).map(s => ({ section:s.name, text:s.text }));
  if (!parts.length) {
    const keep = paperSentences(text).filter(s => PATIENT_RE.test(s) || names.some(n => s.toLowerCase().includes(n)));
    if (keep.length) parts = [{ section:"Full text", text:keep.join("\n") }];
  }
  let budget = 24000;
  parts = parts.map(p => { const t = p.text.slice(0, Math.max(0, budget)); budget -= t.length; return { section:p.section, text:t }; }).filter(p => p.text);
  return { parts, text:parts.map(p => p.text).join("\n") };
}
// Returns { reported, quote, section } for a term: reported is the exact wording found in the source.
function verbatimPhrase(sources, term, evidence) {
  const words = imeNorm(term).split(" ").filter(Boolean);
  if (!words.length) return null;
  const re = new RegExp("\\b" + words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s-]+") + "[a-z]*", "i"), hint = String(evidence || "").slice(0, 50);
  let fallback = null;
  for (const source of sources) for (const sentence of paperSentences(source.text)) {
    const m = re.exec(sentence);
    if (!m) continue;
    const hit = { reported:m[0], quote:sentence.slice(0, 400), section:source.section };
    if (!hint || sentence.includes(hint)) return hit;
    fallback ||= hit;
  }
  return fallback;
}
function detectEvents(article, molecules, ime, promotions, exclude) {
  const text = (article.title || "") + ". " + (article.abstract || ""), names = new Set((molecules || []).map(imeNorm).filter(Boolean));
  // Conditions the patient already had (history, comorbidities) are not adverse events.
  const prior = new Set((exclude || []).map(imeNorm).filter(Boolean));
  const promoted = new Map((promotions || []).map(p => [imeNorm(p.pt_name), p])), found = new Map();
  const seriousHints = s => ({ death:/\b(died|death|fatal|deceased)\b/.test(s), hospitalization:/\bhospitali[sz]/.test(s), life_threatening:/life[- ]threatening|intensive care|\bicu\b/.test(s) });
  const add = (term, kind, sentence, extra = {}) => {
    const key = imeNorm(term), entry = found.get(key) || { term, kinds:[], evidence:"", withDrug:false, ime:null, serious:{} };
    if (!entry.kinds.includes(kind)) entry.kinds.push(kind);
    if (!entry.evidence && sentence) entry.evidence = sentence.trim().slice(0, 260);
    const lower = imeNorm(sentence || "");
    if ([...names].some(n => n && lower.includes(n))) entry.withDrug = true;
    Object.assign(entry.serious, Object.fromEntries(Object.entries(seriousHints(String(sentence || "").toLowerCase())).filter(([, v]) => v)));
    if (extra.ime) entry.ime = extra.ime;
    found.set(key, entry);
  };
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const words = imeNorm(sentence).split(" ").filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      for (let n = Math.min(ime?.maxWords || 4, words.length - i); n >= 1; n--) {
        const phrase = words.slice(i, i + n).join(" ");
        const hit = ime?.byName.get(phrase), promo = promoted.get(phrase), demoted = ime?.demoted.get(phrase);
        if (!hit && !promo && !demoted) continue;
        if (names.has(phrase) || prior.has(phrase)) { i += n - 1; break; }
        if (isNegated(words, i, i + n)) { i += n - 1; break; }
        add(hit?.name || phrase, "IME", sentence, { ime:hit ? { code:hit.code, soc:hit.soc, added:hit.added || undefined, provenance:ime.info.label } : promo ? { provenance:"Reviewer-promoted" + (promo.note ? ": " + promo.note : "") } : { code:demoted.code, soc:demoted.soc, provenance:ime.info.label + ': "' + demoted.name + '" is demoted under the listed PT "' + demoted.parent + '"' } });
        i += n - 1;
        break;
      }
    }
  }
  for (const m of article.aeMesh || []) add(m, "MeSH adverse-effect indexing", "MeSH heading indexed as drug-induced: " + m);
  for (const d of article.entities?.diseases || []) {
    if (found.has(imeNorm(d)) || names.has(imeNorm(d)) || prior.has(imeNorm(d))) continue;
    const sentence = text.split(/(?<=[.!?])\s+/).find(s => imeNorm(s).includes(imeNorm(d))) || "";
    const norm = imeNorm(sentence), index = norm.indexOf(imeNorm(d)), first = index < 0 ? 0 : norm.slice(0, index).split(" ").filter(Boolean).length;
    if (sentence && !isNegated(norm.split(" ").filter(Boolean), first, first + imeNorm(d).split(" ").length)) add(d, "PubTator condition", sentence);
  }
  const rank = e => (e.ime ? 0 : 4) + (e.withDrug ? 0 : 2) + (e.kinds.includes("MeSH adverse-effect indexing") ? 0 : 1);
  // Every event carries a confidence and the reasons for it, so a reviewer can see why it was picked (idea after DrishtiAI's explainable adverse-event scoring).
  for (const e of found.values()) {
    const why = []; let c = 0.15;
    if (e.ime) { c += 0.3; why.push("on the EMA IME list"); }
    if (e.withDrug) { c += 0.25; why.push("in the same sentence as the drug"); }
    if (/\b(after|following|induced|associated with|due to|caused by|secondary to|attributed to|developed|experienced|occurred)\b/i.test(e.evidence || "")) { c += 0.15; why.push("causal or temporal wording"); }
    if (Object.keys(e.serious).length) { c += 0.1; why.push("seriousness wording"); }
    if (e.kinds.includes("MeSH adverse-effect indexing")) { c += 0.2; why.push("indexed as a drug adverse effect in MeSH"); }
    if (e.kinds.includes("PubTator condition")) { c += 0.05; why.push("condition found by PubTator"); }
    e.confidence = Math.min(1, Number(c.toFixed(2))); e.why = why;
  }
  return [...found.values()].sort((a, b) => rank(a) - rank(b) || b.confidence - a.confidence).slice(0, 12);
}
// Country and event detection are pure functions of stored data, so they are recomputed whenever the inputs or the IME list change.
const detectKey = (a, ime) => [EVENT_VERSION, ime?.info.version || "none", ime?.info.count || 0, a.abstract ? 1 : 0, a.fullTextTextKey ? 1 : 0, (a.entities?.diseases || []).length, (a.aeMesh || []).length, a.affiliation ? 1 : 0].join("|");
function applyDetection(article, molecules, ime, promotions, fullText = "") {
  // With a stored full text, events and case facts are read from the abstract plus the part of the paper that describes the patient.
  const narrative = fullText ? caseNarrative(fullText, molecules) : null, used = Boolean(narrative?.text);
  const source = used ? { ...article, abstract:[article.abstract || "", narrative.text].filter(Boolean).join("\n") } : article;
  const history = extractCaseFacts({ ...source, events:[] }, molecules, source.pubTypes).patient.history || [];
  const found = detectEvents(source, molecules, ime, promotions, history);
  const sources = [{ section:"Title", text:article.title || "" }, { section:"Abstract", text:article.abstract || "" }, ...(narrative?.parts || [])];
  const events = found.map(e => ({ ...e, verbatim:verbatimPhrase(sources, e.term, e.evidence) || undefined }));
  const caseLike = /case report/i.test((source.pubTypes || []).join(" ")) || /\b(a|an|the)\b[^.]{0,50}\b(\d+[- ]year[- ]old|man|woman|boy|girl|patient)\b/i.test(source.abstract || "");
  const caseFacts = extractCaseFacts({ ...source, events }, molecules, source.pubTypes);
  return { events, caseFacts, imeCount:events.filter(e => e.ime).length, affiliationCountry:countryFromAffiliation(article.affiliation)?.name || "", detectedFrom:used ? "Full text and abstract" : "Abstract",
    patientCountry:caseLike ? patientCountryFrom((source.title || "") + ". " + (source.abstract || "")) : null, eventsKey:detectKey(article, ime) };
}
// ---- Case facts from the article text: patient, dechallenge, rechallenge, action taken, treatment, concomitants, confounders ----
// Approach follows PV Nexus's literature extractor (lib/literature-pv.ts, itself modelled on Lixplore) and is deterministic: every value carries
// the sentence it came from, and nothing is a final answer; a reviewer confirms it.
const STOP_RE = /\b(discontinu\w*|withdr[ae]w\w*|withdrawn|stopp\w*|ceas\w*|cessation|interrupt\w*|suspend\w*|held|omitted|terminat\w*)\b/i;
const IMPROVE_RE = /\b(resolv\w*|improv\w*|recover\w*|abat\w*|subsid\w*|normali[sz]\w*|disappear\w*|remit\w*|cleared|regress\w*|ameliorat\w*|reversed|reversal)\b/i;
const WORSEN_RE = /\b(persist\w*|did not (?:improve|resolve|recover)|no (?:improvement|resolution)|worsen\w*|progress\w*|continued to deteriorate|remained)\b/i;
const TREATMENT_ITEM = /\b(ha?emodia?lysis|dialysis|ha?emodiafiltration|plasma ?exchange|plasmapheresis|activated charcoal|gastric lavage|antidote|naloxone|flumazenil|acetylcysteine|n-acetylcysteine|adrenaline|epinephrine|corticosteroids?|steroids?|prednisol\w+|methylprednisol\w+|dexamethasone|hydrocortisone|antihistamines?|immunoglobulins?|ivig|intravenous fluids?|hydration|vasopressors?|benzodiazepines?|diazepam|lorazepam|haloperidol|antibiotics?|oxygen|ventilat\w+|intubat\w+|transfusion|surgery|chemotherapy|supportive care|rehydration|alkali?nization|sodium bicarbonate|physiotherapy)\b/ig;
const TREATMENT_TEST = new RegExp(TREATMENT_ITEM.source, "i"); // non-global copy: safe for .test()
const sentencesOf = text => String(text || "").replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z0-9(])/).map(s => s.trim()).filter(Boolean);
const cleanItem = v => String(v).replace(/^(?:the|a|an)\s+/i, "").replace(/[()]/g, "").replace(/\s+/g, " ").trim();
function splitList(value) { return String(value).replace(/^(?:medications?|drugs?|treatments?|therapies|agents?|other)\s+(?:included|include|were|was|are|such as|including)\s+/i, "").split(/,|;|\band\b|\bplus\b|\bas well as\b/i).map(cleanItem).filter(x => x.length > 2 && x.length < 70); }
const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, sept:9, oct:10, nov:11, dec:12 };
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
// "3 March 2021", "March 3, 2021" and "2021-03-03". Day/month/year numbers such as 03/04/2021 are ambiguous and are left for the reviewer.
const DATE_RE = new RegExp("\\b(?:(\\d{1,2})(?:st|nd|rd|th)?\\s+" + MONTH_RE + "\\.?,?\\s+(\\d{4})|" + MONTH_RE + "\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})|(\\d{4})-(\\d{2})-(\\d{2}))\\b", "gi");
function isoFromParts(m) {
  let y, mo, d;
  if (m[1]) { d = Number(m[1]); mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; y = Number(m[3]); }
  else if (m[4]) { mo = MONTHS[m[4].slice(0, 3).toLowerCase()]; d = Number(m[5]); y = Number(m[6]); }
  else { y = Number(m[7]); mo = Number(m[8]); d = Number(m[9]); }
  if (!(y >= 1950 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(Date.UTC(y, mo, 0)).getUTCDate())) return "";
  return y + "-" + String(mo).padStart(2, "0") + "-" + String(d).padStart(2, "0");
}
function extractCaseFacts(article, molecules, pubTypes) {
  const title = String(article.title || ""), abstract = String(article.abstract || ""), text = title + ". " + abstract, sents = sentencesOf(abstract || title);
  const names = (molecules || []).map(m => String(m).toLowerCase()).filter(Boolean), isDrug = s => names.some(n => s.toLowerCase().includes(n));
  const findSentence = re => sents.find(s => re.test(s)) || "";
  const facts = { patient:{}, dechallenge:null, rechallenge:null, actionTaken:null, treatment:[], concomitants:[], confounders:[] };
  // --- patient ---
  const UNIT = { yr:"year", y:"year", mo:"month", wk:"week" };
  const ageRaw = text.match(/\b(\d{1,3})\s*-?\s*(year|yr|month|mo|week|wk|day)s?\s*-?\s*(?:old|of age)\b/i) || text.match(/\b(\d{1,3})\s*-?\s*(y)\s*\/?\s*o\b/i) || text.match(/\b(\d{1,3})\s*-?\s*(y)\.?o\.?(?=\W)/i) || text.match(/\baged?\s*[:\-]?\s*(\d{1,3})\s*(year|yr|month|week|day)?s?\b/i);
  const ageM = ageRaw && ageRaw[1] && Number(ageRaw[1]) <= 120 ? [ageRaw[0], ageRaw[1], ageRaw[2] ? (UNIT[ageRaw[2].toLowerCase()] || ageRaw[2].toLowerCase()) : ""] : null;
  const decade = text.match(/\bin (?:his|her|their) (\d0)s\b/i), baby = text.match(/\b(neonate|newborn|infant|toddler|adolescent|elderly|older adult|pa?ediatric)\b/i);
  const patient = facts.patient;
  if (ageM) { patient.age = ageM[1]; patient.age_unit = (ageM[2] || "year").toLowerCase() + "s"; }
  else if (decade) patient.age_group = decade[1] + "s"; else if (baby) patient.age_group = baby[1].toLowerCase();
  const descriptor = text.match(/\b\d{1,3}\s*-?\s*(?:year|yr|month|week|day)s?\s*-?\s*old\s+(?:\w+\s+)?(man|woman|male|female|boy|girl|gentleman|lady)\b/i) || text.match(/\b(?:a|an|one)\s+(?:\w+\s+){0,2}?(man|woman|male|female|boy|girl|gentleman|lady)\b/i);
  const word = descriptor?.[1].toLowerCase();
  if (word) patient.sex = /^(woman|female|girl|lady)$/.test(word) ? "Female" : "Male";
  else { const she = (text.match(/\b(she|her|hers)\b/gi) || []).length, he = (text.match(/\b(he|his|him)\b/gi) || []).length; if (she !== he) patient.sex = she > he ? "Female" : "Male"; }
  if (/\bpregnan\w*|\bgestation\w*/i.test(text)) { patient.pregnancy = true; patient.sex ||= "Female"; const g = text.match(/(\d{1,2})\s*weeks?(?:'?\s*of)?\s*gestation/i); if (g) patient.gestation_weeks = g[1]; }
  const weight = text.match(/(?:weigh\w*|body weight|bw)[^.\d]{0,20}(\d{2,3}(?:\.\d)?)\s*kg|(\d{2,3}(?:\.\d)?)\s*kg\b/i);
  if (weight) patient.weight = weight[1] || weight[2];
  const history = [];
  for (const m of text.matchAll(/\b(?:(?:past |previous |prior |medical )?history of|known (?:case of|to have)|suffering from|comorbidit\w+ (?:including|such as|of)|background of|with (?:a )?(?:chronic|long-standing))\s+([^.;:]+?)(?=[.;:]|\bwho\b|\bpresented\b|\bwas\b|\bdeveloped\b|\bafter\b|\bbefore\b| on |$)/gi)) for (const item of splitList(m[1])) history.push(item);
  patient.history = [...new Set(history)].slice(0, 8);
  const count = text.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:patients|cases)\b/i);
  const WORDS = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10 };
  patient.count = count ? (WORDS[count[1].toLowerCase()] ?? Number(count[1])) : (ageM || descriptor ? 1 : null);
  patient.evidence = findSentence(/\b(\d{1,3}[- ](?:year|month|week|day)s?[- ]old|aged?\s+\d|\b(?:man|woman|boy|girl|patient)\b)/i).slice(0, 240);
  // --- action taken, dechallenge ---
  const drugStop = sents.map((s, i) => ({ s, i })).find(x => STOP_RE.test(x.s) && (isDrug(x.s) || /\b(drug|treatment|therapy|medication|dose)\b/i.test(x.s)));
  const continued = findSentence(/\b(continued|continuing|maintained|resumed)\b[^.]{0,40}\b(despite|without|unchanged|same dose)\b|\bdespite (?:continued|continuing)\b/i);
  const reduced = findSentence(/\b(dose|dosage)\b[^.]{0,30}\b(reduc\w*|lower\w*|decreas\w*|tapered)\b|\b(reduc\w*|lower\w*|tapered)\b[^.]{0,20}\b(dose|dosage)\b/i);
  const increased = findSentence(/\b(dose|dosage)\b[^.]{0,30}\b(increas\w*|escalat\w*|up-?titrat\w*)\b/i);
  const interrupted = findSentence(/\b(interrupt\w*|temporar\w+ (?:held|stopped|suspended)|held)\b/i);
  if (drugStop && !/\binterrupt\w*|\bheld\b/i.test(drugStop.s)) facts.actionTaken = { value:"Drug withdrawn", evidence:drugStop.s.slice(0, 240) };
  else if (reduced) facts.actionTaken = { value:"Dose reduced", evidence:reduced.slice(0, 240) };
  else if (interrupted && isDrug(interrupted)) facts.actionTaken = { value:"Drug interrupted", evidence:interrupted.slice(0, 240) };
  else if (increased) facts.actionTaken = { value:"Dose increased", evidence:increased.slice(0, 240) };
  else if (continued) facts.actionTaken = { value:"Dose not changed", evidence:continued.slice(0, 240) };
  // --- treatment given for the event: known treatments in sentences that describe care being given ---
  const treatSet = new Map();
  for (const s of sents) {
    if (!/\b(treat\w*|manag\w*|given|administer\w*|receiv\w*|underwent|required|needed|started|commenced|initiated|performed)\b/i.test(s)) continue;
    for (const m of s.matchAll(TREATMENT_ITEM)) treatSet.set(m[0].toLowerCase(), { text:m[0], evidence:s.slice(0, 240) });
  }
  facts.treatment = [...treatSet.values()].slice(0, 6);
  // --- dechallenge ---
  const reducedIndex = reduced ? sents.indexOf(reduced) : -1;
  const trigger = drugStop ? { s:drugStop.s, i:drugStop.i, how:"" } : reduced ? { s:reduced, i:reducedIndex, how:" after dose reduction" } : null;
  if (trigger) {
    const after = sents.slice(trigger.i, trigger.i + 3).join(" ");
    const outcomeIn = IMPROVE_RE.test(after) ? "Positive" : WORSEN_RE.test(after) ? "Negative" : "";
    const evidence = (sents.slice(trigger.i, trigger.i + 3).find(s => (outcomeIn === "Positive" ? IMPROVE_RE : WORSEN_RE).test(s)) || trigger.s).slice(0, 240);
    if (outcomeIn) {
      const confounded = outcomeIn === "Positive" && facts.treatment.length > 0;
      facts.dechallenge = { value:outcomeIn + trigger.how + (confounded ? " (confounded by treatment: " + facts.treatment.map(t => t.text).slice(0, 3).join(", ") + ")" : ""), result:outcomeIn, confounded, evidence };
    } else facts.dechallenge = { value:"Unknown (" + (drugStop ? "drug stopped" : "dose reduced") + ", course not reported)", result:"Unknown", confounded:false, evidence:trigger.s.slice(0, 240) };
  } else if (continued) facts.dechallenge = { value:"Not applicable (drug continued)", result:"Not applicable", confounded:false, evidence:continued.slice(0, 240) };
  // --- rechallenge ---
  const rechSent = findSentence(/\b(re-?challeng\w*|re-?introduc\w*|re-?administ\w*|re-?start\w*|re-?expos\w*|re-?treat\w*|resum\w*|re-?initiat\w*)\b/i);
  if (rechSent) {
    const notDone = /\b(no|not|without|never)\b[^.]{0,30}\b(re-?challeng\w*|re-?introduc\w*|re-?administ\w*|re-?start\w*)/i.test(rechSent) || /\b(re-?challeng\w*|re-?introduc\w*)\b[^.]{0,30}\b(was|were) not\b/i.test(rechSent);
    const idx = sents.indexOf(rechSent), window = sents.slice(idx, idx + 2).join(" ");
    const recurred = /\b(recur\w*|reappear\w*|relaps\w*|returned|again|re-?develop\w*|positive)\b/i.test(window), none = /\b(no|without)\s+(recurrence|relapse|reaction|symptoms)|did not (?:recur|reappear|relapse)|tolerated\b/i.test(window);
    facts.rechallenge = notDone ? { value:"Not done", result:"Not done", evidence:rechSent.slice(0, 240) } : none ? { value:"Negative", result:"Negative", evidence:rechSent.slice(0, 240) } : recurred ? { value:"Positive", result:"Positive", evidence:rechSent.slice(0, 240) } : { value:"Unknown (re-exposure mentioned, outcome not reported)", result:"Unknown", evidence:rechSent.slice(0, 240) };
  }
  // --- concomitant drugs (only where the text signals co-medication) ---
  const concomitant = new Map();
  for (const s of sents) for (const m of s.matchAll(/\b(?:concomitant(?:ly)?|co-?administ\w*|co-?medicat\w*|concurrent(?:ly)?|also (?:taking|receiving|on|prescribed)|was taking|were taking|taking|on long-?term|on regular|receiving|prescribed|medications? (?:included|were|was)|current medications?(?: include\w*)?)\s*(?:of\s+|with\s+|use of\s+|treatment with\s+|therapy with\s+|:)?\s*([^.;]{3,120}?)(?=[.;]|\bwhen\b|\bafter\b|\bbut\b|\bwhich\b|$)/gi))
    for (const item of splitList(m[1])) if (!names.some(n => item.toLowerCase().includes(n)) && !TREATMENT_TEST.test(item) && /^[A-Za-z][A-Za-z0-9\- ]{2,40}$/.test(item) && item.split(" ").length <= 4 && !/^(the|his|her|their|this|that|these|those|which|patient|dose|day|days|week|weeks|month|months|year|years)\b/i.test(item)) { concomitant.set(item.toLowerCase(), { name:item, evidence:s.slice(0, 240) }); }
  for (const c of article.entities?.chemicals || []) { const k = String(c).toLowerCase(); if (!names.some(n => k.includes(n) || n.includes(k)) && !concomitant.has(k) && !TREATMENT_TEST.test(c)) { const s = sents.find(x => x.toLowerCase().includes(k) && /\b(concomitant|also|co-?|taking|receiv|combin|plus|with)\b/i.test(x)); if (s) concomitant.set(k, { name:c, evidence:s.slice(0, 240) }); } }
  facts.concomitants = [...concomitant.values()].slice(0, 8);
  // --- confounders and other causes ---
  const add = (type, textValue, evidence) => facts.confounders.push({ type, text:textValue, evidence:String(evidence || "").slice(0, 240) });
  facts.concomitants.forEach(c => add("Concomitant drug", c.name, c.evidence));
  const organ = /\b(renal|kidney|hepatic|liver|cardiac|heart|dialysis|diabet\w*|epilep\w*|dementia|alcohol\w*|obes\w*|infection|sepsis|malignan\w*|cancer|immunosuppress\w*|hiv)\b/i;
  patient.history.filter(h => organ.test(h)).forEach(h => add("Comorbidity", h, patient.evidence));
  if (facts.dechallenge?.confounded) add("Treatment given", facts.treatment.map(t => t.text).join(", "), facts.treatment[0]?.evidence);
  const alt = findSentence(/\b(alternative (?:cause|etiolog\w*|aetiolog\w*|explanation)|other causes?|cannot be excluded|confound\w*)\b/i);
  if (alt) add(/\bexclud\w*|ruled out/i.test(alt) && !/cannot be excluded/i.test(alt) ? "Other causes excluded" : "Other cause not excluded", alt.slice(0, 120), alt);
  // --- outcome, seriousness, minimum-criteria summary ---
  facts.outcome = /\b(died|death|fatal)\b/i.test(text) ? "Fatal" : /\b(fully recovered|complete(?:ly)? (?:recovery|resolution)|resolved)\b/i.test(text) ? "Recovered/resolved" : /\b(improv\w*|recovering)\b/i.test(text) ? "Recovering/resolving" : /\b(sequel\w*|permanent|irreversible)\b/i.test(text) ? "Recovered with sequelae" : "";
  const LATENCY_RE = /\b(?:(?:within|after|following)\s+(?:about\s+|approximately\s+|nearly\s+)?(?:\d+(?:\s*(?:-|to)\s*\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|several|a few)\s*(?:hours?|days?|weeks?|months?)(?:\s+(?:of|after|from|on)\s+(?:starting|initiation|treatment|therapy|the first dose|admission|administration|commencing|beginning)[^.;,]{0,40})?|(?:on|at)\s+(?:day|week)\s+\d+\s+of\s+(?:treatment|therapy|admission)|(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:hours?|days?|weeks?|months?)\s+(?:after|following)\s+(?:starting|initiation|the start|the first dose|commencing|beginning)[^.;,]{0,40})/i;
  const latent = sents.map(x => ({ x, m:LATENCY_RE.exec(x) })).find(r => r.m && (isDrug(r.x) || /treat|therap|dose|start|initiat|admin|infus|began|commenc/i.test(r.x)));
  facts.latency = latent ? { value:latent.m[0].trim().slice(0, 80), evidence:latent.x.slice(0, 240) } : null;
  // Calendar dates the article gives for starting the drug and for the event (only full dates: day, month and year).
  const dateIn = text => { const found = []; for (const m of String(text).matchAll(DATE_RE)) { const iso = isoFromParts(m); if (iso) found.push({ iso, at:m.index }); } return found; };
  const startSent = sents.find(x => /\b(start\w*|initiat\w*|commenc\w*|began|prescribed|introduced|treatment with|admission)\b/i.test(x) && isDrug(x) && dateIn(x).length);
  if (startSent) facts.startDate = { value:dateIn(startSent)[0].iso, evidence:startSent.slice(0, 240) };
  const onsetSent = sents.find(x => x !== startSent && /\b(develop\w*|onset|presented|admitted|experienced|noted|occurred|appeared)\b/i.test(x) && dateIn(x).length);
  if (onsetSent) facts.onsetDate = { value:dateIn(onsetSent)[0].iso, evidence:onsetSent.slice(0, 240) };
  facts.temporal = /\b(after|following|within)\s+(?:\d+|one|two|three|several|a few)?\s*(?:days?|weeks?|months?|hours?|doses?|cycles?)\b|\b(after|following)\s+(?:the\s+)?(?:initiation|start|starting|administration|first dose|infusion|treatment with)\b/i.test(text);
  facts.caseReport = (pubTypes || []).some(t => /case report/i.test(t)) || /\bcase (report|presentation|description|series)\b|\bwe (report|describe|present)\b/i.test(text);
  const single = patient.count != null && patient.count <= 1;
  facts.minimum = { patient:Boolean(patient.age || patient.age_group || patient.sex || /\b(a|one)\s+(?:\w+\s+){0,2}?(patient|man|woman|boy|girl|infant|child)\b/i.test(text)), reporter:Boolean((article.authors || []).length || article.title), drug:names.length > 0 && names.some(n => text.toLowerCase().includes(n)),
    event:(article.events || []).length > 0, single, literatureReference:Boolean(article.title && (article.journal || article.doi || article.id)) };
  facts.minimum.score = ["patient", "reporter", "drug", "event"].filter(k => facts.minimum[k]).length;
  facts.minimum.verdict = facts.minimum.score === 4 && (facts.caseReport || (patient.count != null && patient.count <= 10)) ? "Valid ICSR candidate" : facts.minimum.score >= 3 ? "Possible: needs more detail" : "Not an ICSR";
  facts.series = patient.count != null && patient.count > 1;
  return facts;
}
// ---- Marketing authorisations by country (managed by a manager; there is no open worldwide source) ----
function parseMaText(text) {
  const rows = String(text || "").split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#")).slice(0, 3000), out = [], errors = [];
  rows.forEach((line, i) => {
    const sep = line.includes("\t") ? "\t" : ",", cells = line.split(sep).map(c => c.replace(/^"|"$/g, "").trim());
    if (i === 0 && /^molecule/i.test(cells[0])) return;
    const country = countryInfo(cells[1]);
    if (!cells[0] || !country) { errors.push("Line " + (i + 1) + ": " + (cells[1] ? "unknown country \"" + cells[1] + "\"" : "needs molecule and country")); return; }
    const raw = (cells[2] || "").toLowerCase(), status = /withdraw|suspend|revok|cancel/.test(raw) ? "Withdrawn" : /not\s+auth|none|^no\b|never/.test(raw) ? "Not authorised" : /review|pending|submitted|filed/.test(raw) ? "Under review" : /auth|market|approv|licen|yes/.test(raw) ? "Authorised" : (cells[2] || "Unknown");
    const days = v => { const n = Number(v); return Number.isInteger(n) && n > 0 && n <= 365 ? n : null; };
    out.push({ molecule:cells[0].slice(0, 100), country:country.name, status, mah:(cells[3] || "").slice(0, 120), number:(cells[4] || "").slice(0, 60), serious_days:days(cells[5]), nonserious_days:days(cells[6]) });
  });
  return { entries:out, errors };
}
const maFor = (list, molecule, country) => (list || []).find(e => imeNorm(e.molecule) === imeNorm(molecule) && e.country === (countryInfo(country)?.name || country)) || null;
const addDaysIso = (date, days) => { const d = new Date(date); return Number.isNaN(d.getTime()) ? "" : new Date(d.getTime() + days * 86400000).toISOString().slice(0, 10); };
function regulatoryContext(maList, data, molecule) {
  const country = data.patient?.country?.value || data.reporter?.country?.value || "", info = countryInfo(country), ma = country ? maFor(maList, molecule, country) : null;
  const serious = (data.events || []).some(e => Object.values(e.seriousness || {}).some(Boolean));
  const days = serious ? ma?.serious_days || 15 : ma?.nonserious_days || 90, day0 = data.receipt_date || "";
  return { country:info?.name || country || "", regulator:info?.regulator || (country ? "Local competent authority" : ""), ma, serious, days, day0, due:day0 ? addDaysIso(day0, days) : "",
    note:!country ? "Set the country where the event occurred; it decides the regulator, marketing-authorisation status and reporting clock." : !ma ? "No marketing-authorisation record for " + molecule + " in " + (info?.name || country) + ". Add one in Settings, or confirm local obligations." : ma.status !== "Authorised" ? "Marketing authorisation status in " + ma.country + ": " + ma.status + "." : "",
    clock:"Default clock: " + (serious ? "15 days for serious" : "90 days for non-serious") + " cases unless the authorisation record sets its own; confirm with local regulations." };
}
// ---- ICSR case processing: a port of the deterministic engine in PV Nexus (backend/app/services.py) ----
// Cases use the same shape as PV Nexus's ICSRExtraction schema, so they can be sent to or checked by a PV Nexus backend as they are.
const icsrField = (value, state = "edited", evidence = []) => ({ value:value === "" || value == null ? null : String(value), normalized_value:null, state, evidence });
const FIELDS = {
  patient:["identifier", "age", "age_unit", "age_group", "sex", "weight", "country"], reporter:["identifier", "qualification", "country", "contactable", "organisation", "department", "address", "email", "phone"],
  sender:["type", "organisation", "name", "email", "phone", "address", "country"],
  product:["name", "dose", "frequency", "route", "indication", "start_date", "stop_date", "action_taken", "dechallenge", "rechallenge"],
  event:["verbatim", "onset_date", "stop_date", "outcome", "expectedness", "coded_term", "time_to_onset", "llt", "pt", "pt_code", "hlt", "hlgt", "soc", "meddra_version", "coding_status",
    "causality_reporter", "causality_reviewer", "causality_method", "temporal_relationship", "alternative_causes", "concomitant_factors", "objective_evidence", "listedness", "assessed_term", "rsi", "causality_rationale", "reviewer_comment"] };
const WHO_UMC = ["Certain", "Probable/Likely", "Possible", "Unlikely", "Conditional/Unclassified", "Unassessable/Unclassifiable"];
const AGE_GROUPS = ["Foetus", "Neonate", "Infant", "Child", "Adolescent", "Adult", "Elderly"];
// ICH E2B(R3) D.2.3 age groups, from an age in years (neonate to 27 days, infant to 23 months, child to 11, adolescent to 17, adult to 64).
function ageGroupFrom(age, unit) {
  const n = Number(age);
  if (!(n >= 0) || !String(age ?? "").trim()) return "";
  const u = String(unit || "years").toLowerCase(), days = /hour/.test(u) ? n / 24 : /day/.test(u) ? n : /week/.test(u) ? n * 7 : /month/.test(u) ? n * 30.4 : n * 365.25;
  return days <= 27 ? "Neonate" : days < 730 ? "Infant" : days < 4383 ? "Child" : days < 6575 ? "Adolescent" : days < 23376 ? "Adult" : "Elderly";
}
const groupFromWord = w => {
  const word = String(w || "").toLowerCase(), decade = /^(\d)0s$/.exec(word);
  if (decade) return Number(decade[1]) >= 7 ? "Elderly" : Number(decade[1]) >= 2 ? "Adult" : Number(decade[1]) === 1 ? "Adolescent" : "Child";
  return { neonate:"Neonate", newborn:"Neonate", infant:"Infant", toddler:"Infant", child:"Child", paediatric:"Child", pediatric:"Child", adolescent:"Adolescent", elderly:"Elderly", "older adult":"Elderly" }[word] || "";
};
const SERIOUS_FLAGS = ["serious", "death", "life_threatening", "hospitalization", "disability", "congenital_anomaly", "other_medically_important"];
function normalizeCase(input) {
  const data = input && typeof input === "object" ? input : {};
  const fixField = f => icsrField(f?.value, ["proposed", "accepted", "edited", "rejected"].includes(f?.state) ? f.state : "edited", Array.isArray(f?.evidence) ? f.evidence.slice(0, 5) : []);
  const group = (obj, names, extra = {}) => ({ ...Object.fromEntries(names.map(n => [n, fixField(obj?.[n])])), ...extra });
  const out = {
    case_id:data.case_id ?? null, receipt_date:data.receipt_date || null,
    patient:group(data.patient, FIELDS.patient, { medical_history:(data.patient?.medical_history || []).slice(0, 50).map(fixField) }),
    reporter:group(data.reporter, FIELDS.reporter), sender:group(data.sender, FIELDS.sender),
    source_type:data.source_type === "social" ? "social" : "literature", source_platform:String(data.source_platform || "").slice(0, 60),
    general_comments:String(data.general_comments || "").slice(0, 4000), sender_comments:String(data.sender_comments || "").slice(0, 4000),
    products:(data.products || []).slice(0, 30).map(p => ({ ...group(p, FIELDS.product), role:["suspect", "concomitant", "interacting"].includes(p?.role) ? p.role : "suspect", start_not_reported:p?.start_not_reported === true })),
    events:(data.events || []).slice(0, 30).map(e => ({ ...group(e, FIELDS.event), onset_not_reported:e?.onset_not_reported === true, seriousness:Object.fromEntries(SERIOUS_FLAGS.map(k => [k, Boolean(e?.seriousness?.[k])])) })),
    labs:Array.isArray(data.labs) ? data.labs.slice(0, 100) : [], source_documents:(data.source_documents || []).slice(0, 20).map(d => ({ filename:String(d?.filename || "").slice(0, 200), media_type:d?.media_type || null, size_bytes:Number(d?.size_bytes) || 0, source_type:d?.source_type || "unknown" })),
    source_summary:String(data.source_summary || "").slice(0, 20000), warnings:(data.warnings || []).map(String).slice(0, 20), special_situations:(data.special_situations || []).map(String).slice(0, 30),
    // LiteraSift extensions (PV Nexus ignores unknown keys): care given for the event, and factors that confound the assessment.
    treatment_given:(data.treatment_given || []).map(String).map(t => t.slice(0, 200)).slice(0, 20),
    confounders:(data.confounders || []).map(c => typeof c === "string" ? { type:"Other", text:c.slice(0, 200), evidence:"" } : { type:String(c?.type || "Other").slice(0, 60), text:String(c?.text || "").slice(0, 200), evidence:String(c?.evidence || "").slice(0, 300) }).filter(c => c.text).slice(0, 30) };
  if (!out.patient.age_unit.value) out.patient.age_unit.value = "years";
  // The age group is derived from the age when the article gives an age but no group.
  if (!out.patient.age_group.value) { const group = ageGroupFrom(out.patient.age.value, out.patient.age_unit.value); if (group) { out.patient.age_group.value = group; out.patient.age_group.state = "proposed"; } }
  return out;
}
const hasVal = f => Boolean(f && f.value != null && String(f.value).trim());
const firstSuspect = c => c.products.find(p => p.role === "suspect");
function icsrValidity(c) {
  const patient = hasVal(c.patient.identifier) || hasVal(c.patient.age) || hasVal(c.patient.sex);
  const reporter = hasVal(c.reporter.identifier) || hasVal(c.reporter.qualification);
  const suspect = c.products.some(p => p.role === "suspect" && hasVal(p.name));
  const event = c.events.some(e => hasVal(e.verbatim));
  const checks = { "Identifiable patient":patient, "Identifiable reporter":reporter, "Suspect product":suspect, "Adverse event":event };
  return { identifiable_patient:patient, identifiable_reporter:reporter, suspect_product:suspect, adverse_event:event, valid_icsr:Object.values(checks).every(Boolean),
    missing:Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name) };
}
function icsrQc(c) {
  const findings = [], validity = icsrValidity(c), add = (severity, category, field_path, title, detail, suggested_action) => findings.push({ id:crypto.randomUUID(), severity, category, field_path, title, detail, suggested_action });
  for (const missing of validity.missing) add("critical", "Validity", null, "Missing " + missing.toLowerCase(), "A minimum ICSR criterion is not sufficiently documented.", "Obtain or verify the missing minimum criterion before case acceptance.");
  const suspect = firstSuspect(c), event = c.events[0];
  if (suspect && !hasVal(suspect.indication)) add("minor", "Product", "products[0].indication", "Indication not documented", "The suspect product indication is unavailable.", "Request indication if clinically or procedurally relevant.");
  if (suspect && !hasVal(suspect.start_date)) add("major", "Chronology", "products[0].start_date", "Therapy start date missing", "Drug-to-event latency cannot be reliably assessed without a therapy start date.", "Obtain or verify the therapy start date.");
  if (event && !hasVal(event.onset_date)) add("major", "Chronology", "events[0].onset_date", "Event onset date missing", "Temporal relationship cannot be fully assessed.", "Obtain the event onset date or document that it is unknown.");
  if (event && !hasVal(event.outcome)) add("minor", "Event", "events[0].outcome", "Outcome not documented", "The current clinical status of the adverse event is unknown.", "Obtain current outcome on follow-up.");
  if (event && !hasVal(event.expectedness)) add("major", "Expectedness", "events[0].expectedness", "Expectedness not assessed", "Expectedness should be assessed against an approved reference safety source.", "Review the applicable RSI/label and record the human-confirmed assessment.");
  const penalties = { critical:25, major:10, minor:4, info:0 };
  return { score:Math.max(0, 100 - findings.reduce((n, f) => n + penalties[f.severity], 0)), findings, ready_for_medical_review:validity.valid_icsr && !findings.some(f => f.severity === "critical" || f.severity === "major") };
}
function icsrCausality(c) {
  const suspect = firstSuspect(c), event = c.events[0], rationale = [];
  if (!suspect || !event) return { category:"Unassessable / Unclassifiable", rationale:["A suspect product and adverse event are required for a meaningful assessment."], confidence:"low", reviewer_confirmation_required:true };
  const chronology = hasVal(suspect.start_date) && hasVal(event.onset_date);
  rationale.push(chronology ? "Exposure and event dates are available for temporal assessment." : "Chronology is incomplete, limiting temporal assessment.");
  const dechallenge = String(suspect.dechallenge.value || "").toLowerCase(), rechallenge = String(suspect.rechallenge.value || "").toLowerCase();
  if (dechallenge.includes("positive")) rationale.push("Positive dechallenge supports an association."); else if (!dechallenge) rationale.push("Dechallenge information is unavailable.");
  if (rechallenge.includes("positive")) rationale.push("Positive rechallenge strongly supports an association.");
  rationale.push(c.patient.medical_history.length || c.products.length > 1 ? "Medical history/concomitant therapies require review for alternative etiologies." : "Alternative etiologies are not well documented in the current case data.");
  let category = "Unassessable / Unclassifiable", confidence = "low";
  if (rechallenge.includes("positive") && chronology) { category = "Probable / Likely"; confidence = "moderate"; }
  else if (dechallenge.includes("positive") && chronology) { category = "Probable / Likely"; confidence = "moderate"; }
  else if (chronology) { category = "Possible"; confidence = "moderate"; }
  return { category, rationale, confidence, reviewer_confirmation_required:true };
}
function icsrFollowUp(c) {
  const questions = [], suspect = firstSuspect(c), event = c.events[0], ask = (priority, question, reason) => questions.push({ priority, question, reason });
  if (!hasVal(c.reporter.identifier) && !hasVal(c.reporter.contactable)) ask("high", "Please provide information that allows the reporter to be identified or contacted.", "Reporter identifiability is required for a valid ICSR.");
  if (suspect && !hasVal(suspect.start_date)) ask("high", "What was the start date of " + (suspect.name.value || "the suspect product") + "?", "Required to establish drug-event chronology.");
  if (event && !hasVal(event.onset_date)) ask("high", "What was the exact onset date of " + (event.verbatim.value || "the adverse event") + "?", "Required to assess temporal association.");
  if (suspect && !hasVal(suspect.action_taken)) ask("medium", "What action was taken with the suspect product after the event occurred?", "Action taken supports dechallenge and case assessment.");
  if (event && !hasVal(event.outcome)) ask("medium", "What is the current outcome of the adverse event?", "Outcome is clinically relevant and important for case completeness.");
  if (!c.patient.medical_history.length) ask("low", "Please provide relevant medical history, allergies, and prior similar reactions if known.", "Helps assess confounding and alternative etiologies.");
  return { questions };
}
const withRegulatory = (assessment, state, record) => ({ ...assessment, regulatory:regulatoryContext(state.settings?.marketAuth || [], record.data || record, record.molecule || "") });
// Literature-specific checks that sit beside PV Nexus's rules (they do not change its validity or QC score).
function literatureChecks(c) {
  const out = [], add = (severity, title, detail, suggested_action) => out.push({ severity, title, detail, suggested_action }), suspect = firstSuspect(c);
  if (c.source_type === "social") add("major", "Reporter cannot be followed up", "Social media reports usually give no identifiable or contactable reporter, so the reporter criterion is met only formally.", "Record the platform and the post in the source summary, and decide with your SOP whether the case is reportable.");
  else if (!String(c.source_summary || "").trim()) add("critical", "Literature reference missing", "A case from published literature needs the article reference (E2B(R3) C.4.r.1).", "Keep the citation in the source summary.");
  if (suspect && String(suspect.dechallenge.value || "").toLowerCase().includes("confounded")) add("major", "Dechallenge confounded by treatment", suspect.dechallenge.value, "Do not count the dechallenge as supportive on its own; document the treatment and weigh the evidence.");
  if (c.treatment_given.length && !c.confounders.some(x => /treatment/i.test(x.type))) add("minor", "Treatment given for the event is not listed as a confounder", c.treatment_given.join(", "), "Record whether the treatment could explain the improvement.");
  if (suspect && !hasVal(suspect.dechallenge) && !hasVal(suspect.rechallenge)) add("info", "No dechallenge or rechallenge information", "The article does not say what happened when the drug was stopped or re-introduced.", "Check the full text, or ask the author in follow-up.");
  if (c.confounders.length) add("info", c.confounders.length + " potential confounder" + (c.confounders.length === 1 ? "" : "s") + " documented", c.confounders.slice(0, 4).map(x => x.type + ": " + x.text).join("; "), "Weigh them in the causality assessment.");
  if (!hasVal(c.patient.country) && !hasVal(c.reporter.country)) add("minor", "Country not recorded", "The country decides the regulator, marketing-authorisation status and reporting clock.", "Set the country where the event occurred.");
  return out;
}
// Articles rarely give therapy start or onset dates. When a reviewer confirms a date is not reported, it stops counting as a gap (LiteraSift rule).
function adjustForUnreportedDates(out, c) {
  const suspect = firstSuspect(c), event = c.events[0];
  const startOk = Boolean(suspect && !hasVal(suspect.start_date) && suspect.start_not_reported), onsetOk = Boolean(event && !hasVal(event.onset_date) && event.onset_not_reported);
  if (!startOk && !onsetOk) return out;
  const penalties = { critical:25, major:10, minor:4, info:0 }, settled = (startOk || hasVal(suspect?.start_date)) && (onsetOk || hasVal(event?.onset_date));
  const findings = (out.qc?.findings || []).map(f => (startOk && f.field_path === "products[0].start_date") || (onsetOk && f.field_path === "events[0].onset_date")
    ? { ...f, severity:"info", title:String(f.title).replace(/ missing$/, " not reported in the article"), detail:"Not reported in the article and confirmed as unknown by the reviewer. Published reports rarely give exposure dates.", suggested_action:"Use the time to onset if the article states one." } : f);
  out.qc = { ...out.qc, findings, score:Math.max(0, 100 - findings.reduce((n, f) => n + (penalties[f.severity] ?? 0), 0)), ready_for_medical_review:Boolean(out.validity?.valid_icsr) && !findings.some(f => f.severity === "critical" || f.severity === "major") };
  const skip = q => (startOk && /start date/i.test(q.question)) || (onsetOk && /onset date/i.test(q.question));
  out.follow_up = { ...out.follow_up, questions:(out.follow_up?.questions || []).filter(q => !skip(q)) };
  if (out.causality) {
    const note = "Exposure or onset dates are not reported in the article and were confirmed as unknown by the reviewer (LiteraSift rule).";
    const dech = String(suspect?.dechallenge.value || "").toLowerCase(), rech = String(suspect?.rechallenge.value || "").toLowerCase();
    if (settled && hasVal(event?.time_to_onset) && out.causality.category === "Unassessable / Unclassifiable") {
      const strong = rech.includes("positive") || (dech.includes("positive") && !dech.includes("confounded"));
      out.causality = { ...out.causality, category:strong ? "Probable / Likely" : "Possible", confidence:"low", rationale:[...out.causality.rationale, note, "The article gives a time to onset (" + event.time_to_onset.value + "), which was used for the temporal assessment."] };
    } else out.causality = { ...out.causality, rationale:[...out.causality.rationale, note] };
  }
  return out;
}
function applyLiteratureRules(assessment, c) {
  const suspect = firstSuspect(c), out = adjustForUnreportedDates({ ...assessment, literature_checks:literatureChecks(c) }, c);
  if (out.causality?.category === "Probable / Likely" && suspect && String(suspect.dechallenge.value || "").toLowerCase().includes("confounded") && !String(suspect.rechallenge.value || "").toLowerCase().includes("positive"))
    out.causality = { ...out.causality, category:"Possible", confidence:"low", rationale:[...out.causality.rationale, "Positive dechallenge is confounded by treatment, so it cannot support a Probable assessment on its own (LiteraSift rule)."] };
  return out;
}
const localAssessment = data => { const c = normalizeCase(data); return applyLiteratureRules({ validity:icsrValidity(c), qc:icsrQc(c), causality:icsrCausality(c), follow_up:icsrFollowUp(c), engine:"LiteraSift (PV Nexus rules)" }, c); };
// Optional: run the same checks on a real PV Nexus backend (FastAPI /icsr/*); falls back to the local port if it is unreachable.
async function assessCase(env, data) {
  const local = localAssessment(data), url = String(env.PV_NEXUS_URL || "").replace(/\/+$/, "");
  if (!url) return local;
  try {
    const headers = { "Content-Type":"application/json", ...(env.PV_NEXUS_TOKEN ? { Authorization:"Bearer " + env.PV_NEXUS_TOKEN } : {}) }, body = JSON.stringify(normalizeCase(data));
    const call = async path => { const r = await fetch(url + path, { method:"POST", headers, body, signal:AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(path + " returned HTTP " + r.status); return r.json(); };
    const [validity, qc, causality, follow_up] = await Promise.all([call("/icsr/validate"), call("/icsr/qc"), call("/icsr/causality/suggest"), call("/icsr/follow-up")]);
    return applyLiteratureRules({ validity, qc, causality, follow_up:follow_up.questions ? follow_up : { questions:follow_up }, engine:"PV Nexus API" }, normalizeCase(data));
  } catch (error) { return { ...local, engine:"LiteraSift (PV Nexus rules)", remoteError:error.message }; }
}
const specialSituationHints = [[/pregnan/, "Pregnancy exposure"], [/neonat|newborn/, "Neonatal exposure"], [/\b(child|children|paediatric|pediatric|infant)/, "Paediatric patient"], [/elderly|older adult/, "Elderly patient"],
  [/overdose/, "Overdose"], [/misuse|abuse/, "Misuse / abuse"], [/lack of (efficacy|effect)|ineffective|treatment failure/, "Lack of effect"], [/off-label/, "Off-label use"], [/interaction/, "Drug interaction"], [/medication error|wrong dose/, "Medication error"]];
// A starting point built from the published article. Every value is proposed and needs human review.
const eventOutcome = t => /\b(died|death|fatal)\b/i.test(t) ? "Fatal" : /\b(not (?:yet )?recovered|unresolved|persist\w*|ongoing)\b/i.test(t) ? "Not recovered/not resolved" : /\b(sequel\w*|permanent)\b/i.test(t) ? "Recovered with sequelae" : /\b(improv\w*|recovering|resolving)\b/i.test(t) ? "Recovering/resolving" : /\b(recovered|resolved|resolution|subsided|disappeared)\b/i.test(t) ? "Recovered/resolved" : "";
const eventDate = t => { for (const m of String(t).matchAll(DATE_RE)) { const iso = isoFromParts(m); if (iso) return iso; } return ""; };
// Published articles do not name patients, so the patient is identified by age and sex (an identifiable-patient criterion in itself).
function patientIdentity(p, ev) {
  if (!p) return icsrField("");
  const age = p.age ? p.age + "-" + String(p.age_unit || "years").replace(/s$/, "") + "-old" : p.age_group ? "age group " + p.age_group : "", who = [age, p.sex ? p.sex.toLowerCase() : ""].filter(Boolean).join(" ");
  return who ? icsrField(who + " (name withheld in the publication)", "proposed", ev(who, p.evidence)) : icsrField("");
}
function caseFromArticle(article, assignment, settings = {}) {
  const authors = article.authors || [], cite = (authors.slice(0, 3).join(", ") + (authors.length > 3 ? " et al" : "")) + ". " + article.title + " " + (article.journal || "") + ". " + (article.date || "") + ". PMID " + article.id + (article.doi ? ". doi:" + article.doi : "");
  const ev = (text, excerpt) => [{ source_file:"PMID " + article.id, excerpt:String(excerpt || text).slice(0, 300), confidence:0.5 }];
  const text = ((article.title || "") + " " + (article.abstract || "")).toLowerCase();
  const molecule = (assignment?.molecules || [])[0] || "";
  const condition = (article.entities?.diseases || [])[0] || "";
  const picked = (article.events || []).slice(0, 12), facts = article.caseFacts || null;
  const fe = (value, f) => icsrField(value || "", "proposed", f?.evidence ? ev(f.evidence) : []);
  const history = (facts?.patient?.history || []).map(h => icsrField(h, "proposed", ev(facts.patient.evidence || h)));
  const events = picked.length ? picked.map(e => { const s = { ...e.serious, other_medically_important:Boolean(e.ime) }; s.serious = Object.values(s).some(Boolean);
    const quote = e.verbatim ? "[" + e.verbatim.section + "] " + e.verbatim.quote : e.evidence;
    const evc = [{ ...ev(e.term, quote)[0], confidence:e.confidence ?? 0.5, why:(e.why || []).join("; ") }];
    return { verbatim:icsrField(e.verbatim?.reported || e.term, "proposed", evc), coded_term:e.ime ? icsrField(e.term, "proposed", ev(e.ime.provenance + (e.ime.code ? " (PT " + e.ime.code + ")" : ""), quote)) : icsrField(""),
      pt:e.ime ? icsrField(e.term, "proposed", ev(e.ime.provenance, quote)) : icsrField(""), pt_code:e.ime?.code ? icsrField(e.ime.code, "proposed") : icsrField(""), soc:e.ime?.soc ? icsrField(e.ime.soc, "proposed") : icsrField(""),
      coding_status:e.ime ? icsrField("Proposed (IME list)", "proposed") : icsrField(""), seriousness:s,
      // Each event keeps its own outcome and onset date when its own sentence gives them.
      ...(eventOutcome(quote) ? { outcome:icsrField(eventOutcome(quote), "proposed", ev(e.term, quote)) } : {}),
      ...(eventDate(quote) ? { onset_date:icsrField(eventDate(quote), "proposed", ev(e.term, quote)) } : {}) }; })
    : [{ verbatim:icsrField(condition, "proposed", condition ? ev(condition, article.abstract) : []) }];
  const social = article.source === "Social media";
  const built = normalizeCase({ source_type:social ? "social" : "literature", source_platform:social ? article.platform || "" : "", receipt_date:new Date().toISOString().slice(0, 10),
    patient:{ identifier:patientIdentity(facts?.patient, ev), country:icsrField(article.patientCountry?.name || "", "proposed", article.patientCountry ? ev(article.patientCountry.evidence) : []),
      age:fe(facts?.patient?.age, { evidence:facts?.patient?.evidence }), age_unit:icsrField(facts?.patient?.age_unit || "years", "proposed"), age_group:icsrField(facts?.patient?.age ? "" : groupFromWord(facts?.patient?.age_group), "proposed", facts?.patient?.evidence ? ev(facts.patient.evidence) : []), sex:fe(facts?.patient?.sex, { evidence:facts?.patient?.evidence }),
      weight:fe(facts?.patient?.weight, { evidence:facts?.patient?.evidence }), medical_history:history },
    reporter:{ identifier:icsrField(social ? "Social media user (name withheld)" : authors[0] ? authors[0] + " (first author)" : "", "proposed", ev(cite)), qualification:icsrField(social ? "Consumer or other non-health professional" : "Health professional (published literature)", "proposed", ev(cite)),
      country:icsrField(article.affiliationCountry || "", "proposed", article.affiliation ? ev(article.affiliation) : []), organisation:icsrField(String(article.affiliation || "").slice(0, 300), "proposed", article.affiliation ? ev(article.affiliation) : []) },
    sender:{ type:icsrField(settings.senderType || "Pharmaceutical company", "proposed"), organisation:icsrField(settings.senderOrg || ""), name:icsrField(settings.senderName || ""), email:icsrField(settings.senderEmail || ""), phone:icsrField(settings.senderPhone || ""), country:icsrField(settings.senderCountry || "") },
    products:[{ role:"suspect", name:icsrField(molecule, "proposed", ev(cite)), start_date:fe(facts?.startDate?.value, facts?.startDate), action_taken:fe(facts?.actionTaken?.value, facts?.actionTaken), dechallenge:fe(facts?.dechallenge?.value, facts?.dechallenge), rechallenge:fe(facts?.rechallenge?.value, facts?.rechallenge) },
      ...(facts?.concomitants || []).slice(0, 6).map(c => ({ role:"concomitant", name:icsrField(c.name, "proposed", ev(c.evidence)) }))],
    events:events.map((e, i) => i === 0 && facts?.latency && !hasVal(e.time_to_onset) ? { ...e, time_to_onset:icsrField(facts.latency.value, "proposed", ev(facts.latency.value, facts.latency.evidence)) } : e).map((e, i) => i === 0 && facts?.onsetDate && !hasVal(e.onset_date) ? { ...e, onset_date:icsrField(facts.onsetDate.value, "proposed", ev(facts.onsetDate.value, facts.onsetDate.evidence)) } : e).map((e, i) => i === 0 && picked.length <= 1 && facts?.outcome && !hasVal(e.outcome) ? { ...e, outcome:icsrField(facts.outcome, "proposed", facts.patient?.evidence ? ev(facts.patient.evidence) : []) } : e),
    treatment_given:(facts?.treatment || []).map(t => t.text), confounders:facts?.confounders || [],
    source_documents:[{ filename:article.fullTextKey ? "PMID_" + article.id + "." + (/\.(\w+)$/.exec(article.fullTextKey)?.[1] || "pdf") : "PMID " + article.id + " citation and abstract", media_type:article.fullTextKey ? "application/pdf" : "text/plain", source_type:article.fullTextKey ? "pdf" : "text" }],
    source_summary:social ? "Social media post (" + (article.platform || "platform") + ", " + (article.date || "") + ")" + (article.url ? " " + article.url : "") + "\n\nPost (personal data masked): " + (article.abstract || "") : cite + (article.abstract ? "\n\nAbstract: " + article.abstract : ""),
    special_situations:[...new Set([...specialSituationHints.filter(([re]) => re.test(text)).map(([, label]) => label), ...(facts?.patient?.pregnancy ? ["Pregnancy exposure"] : [])])],
    warnings:[...(social ? ["Patient-reported post: the report is unverified, the reporter cannot be identified or contacted, and personal data was masked before storage. Check whether it meets your minimum criteria."] : []), "Pre-filled from the published article by LiteraSift. Patient details are usually only partly reported in literature; every value needs human review.",
      ...(picked.some(e => e.ime) ? ["Events matching the EMA IME list are pre-ticked as other medically important (ICH E2A criterion 6). Confirm each one."] : []),
      ...(facts?.dechallenge?.confounded ? ["Dechallenge looks positive but treatment was given (" + facts.treatment.map(t => t.text).join(", ") + "), so it is confounded. Weigh it cautiously."] : []),
      "Patients are not named in published articles, so the patient is identified by age and sex. Therapy start and event onset dates are rarely given: if the article does not give them, tick \"not reported in the article\" once you have checked, and use the time to onset if it states one.",
      ...(facts?.series ? ["The article reports more than one patient. Each patient may need its own ICSR."] : [])] });
  // Each event gets its own suggested WHO-UMC causality, worked out from that event and the suspect product alone.
  built.events.forEach((e, i) => {
    if (!hasVal(e.verbatim)) return;
    const one = localAssessment({ ...built, events:[e] }).causality, mapped = { "Probable / Likely":"Probable/Likely", Possible:"Possible", "Unassessable / Unclassifiable":"Unassessable/Unclassifiable" }[one.category] || "Unassessable/Unclassifiable";
    e.causality_reviewer = icsrField(mapped, "proposed", [{ source_file:"LiteraSift", excerpt:one.rationale.join(" ").slice(0, 300), confidence:0.4 }]);
    e.causality_method = icsrField("WHO-UMC", "proposed"); e.causality_rationale = icsrField("WHO-UMC " + mapped.toLowerCase() + ". " + one.rationale.join(" ") + " Suggestion only: a medical reviewer must confirm.", "proposed");
    e.assessed_term = icsrField(v(e.pt) || v(e.verbatim), "proposed");
    if (i === 0 || hasVal(built.products[0]?.start_date)) e.temporal_relationship = icsrField(hasVal(built.products[0]?.start_date) && hasVal(e.onset_date) ? "Onset " + v(e.onset_date) + ", therapy start " + v(built.products[0].start_date) : hasVal(e.time_to_onset) ? v(e.time_to_onset) : "", "proposed");
    if (built.confounders.length) e.alternative_causes = icsrField(built.confounders.map(x => x.type + ": " + x.text).join("; "), "proposed");
    if (built.products.some(x => x.role !== "suspect" && hasVal(x.name))) e.concomitant_factors = icsrField(built.products.filter(x => x.role !== "suspect" && hasVal(x.name)).map(x => v(x.name)).join(", "), "proposed");
  });
  return built;
}
const caseClosed = c => c.status === "Sent to PV Nexus" || c.status === "Closed: not a valid ICSR";
// Who should take a new case: the molecule's owner, else the active reviewer (matching the portfolio) with the fewest open cases and room left, else a manager.
function pickCaseAssignee(data, rec) {
  const owned = data.watches.find(w => w.owner && w.portfolio === rec.portfolio && (!w.molecule || w.molecule === rec.molecule));
  if (owned && data.profiles.some(p => p.email === owned.owner && p.active)) return owned.owner;
  const open = p => (data.cases || []).filter(c => c.assignee === p.email && !caseClosed(c)).length;
  const fits = p => p.active && (!p.portfolio || p.portfolio.toLowerCase() === String(rec.portfolio || "").toLowerCase());
  let pool = data.profiles.filter(p => p.role === "reviewer" && fits(p));
  if (!data.profiles.some(p => p.role === "reviewer" && p.active)) pool = data.profiles.filter(p => p.role === "manager" && p.active).map(p => ({ ...p, capacity:Infinity }));
  const best = pool.map(p => ({ p, n:open(p) })).filter(x => x.n < (x.p.capacity ?? Infinity)).sort((a, b) => a.n - b.n || a.p.email.localeCompare(b.p.email))[0];
  return best?.p.email || "";
}
// Reporting due date from the case's country, seriousness and marketing-authorisation record (15 days serious / 90 days non-serious by default).
function refreshDue(data, rec) { rec.dueAt = regulatoryContext(data.settings?.marketAuth || [], rec.data, rec.molecule).due || ""; }
function makeCase(data, article, item, by, intake, assignTo = "") {
  const year = new Date().getFullYear(), at = new Date().toISOString(), counters = data.caseSeq ||= {};
  const seq = (counters[year] ?? Math.max(0, ...(data.cases || []).filter(c => c.number.startsWith("LS-" + year)).map(c => Number(c.number.split("-")[2]) || 0))) + 1;
  counters[year] = seq;
  const created = { id:crypto.randomUUID(), number:"LS-" + year + "-" + String(seq).padStart(4, "0"), pmid:article.id, portfolio:item.portfolio, molecule:(item.molecules || [])[0] || "", status:"Draft", notes:"",
    data:caseFromArticle(article, item, data.settings || {}), createdBy:by, createdAt:at, updatedAt:at, intake,
    history:[{ at, by, action:(intake === "automatic" ? "added automatically from the full text of PMID " : "created from PMID ") + article.id }] };
  created.data.case_id = created.number;
  (data.cases ||= []).push(created);
  const assignee = assignTo || (data.settings?.autoAssignCases === false ? "" : pickCaseAssignee(data, created));
  if (assignee) { created.assignee = assignee; created.assignedAt = at; created.history.push({ at, by:"system", action:"assigned to " + assignee + (assignTo ? "" : " (automatic)") }); }
  refreshDue(data, created);
  return created;
}
// Adds a draft case for every article whose full text is stored and that has detected events (one case per article).
function icsrIntake(data, by, scope, limit = 1000, assignTo = "") {
  const out = { created:[], existing:0, noEvents:0 }, have = new Set((data.cases || []).map(c => c.pmid));
  for (const article of Object.values(data.articles)) {
    if (article.fullTextStatus !== "Captured" || !article.fullTextKey) continue;
    const item = data.assignments.find(a => a.pmid === article.id && scope(a));
    if (!item) continue;
    if (have.has(article.id)) { out.existing++; continue; }
    if (!(article.events || []).length) { out.noEvents++; continue; }
    if (out.created.length >= limit) break;
    out.created.push(makeCase(data, article, item, by, by === "system" ? "automatic" : "manual", assignTo).number);
    have.add(article.id);
  }
  return out;
}
// ---- Synchrony exports: narrative, E2B(R3) XML (ICH ICSR, HL7 v3), CIOMS I, FHIR R4, line listing ----
const v = f => (f && f.value != null ? String(f.value).trim() : "");
const ageText = p => v(p.age) ? v(p.age) + " " + (v(p.age_unit) || "years") : "";
// A case narrative written only from the case fields, so every statement can be traced to a value the reviewer confirmed.
function caseNarrativeText(c, citation) {
  const p = c.patient, suspect = firstSuspect(c), events = c.events.filter(e => hasVal(e.verbatim)), out = [];
  const who = [v(p.age) ? v(p.age) + "-" + (v(p.age_unit) || "years").replace(/s$/, "") + "-old" : "", v(p.sex).toLowerCase()].filter(Boolean).join(" ") || "patient of unspecified age and sex";
  out.push((c.source_type === "social" ? "This case was reported by a patient or consumer in a " + (c.source_platform || "social media") + " post (not verified)" : "This case was reported in the published literature") + (citation ? " (" + citation + ")" : "") + ". It concerns a " + who + (v(p.country) ? " from " + v(p.country) : "") + (v(p.weight) ? ", weight " + v(p.weight) + " kg" : "") + ".");
  if (c.patient.medical_history.length) out.push("Relevant medical history: " + c.patient.medical_history.map(h => v(h)).filter(Boolean).join("; ") + ".");
  if (suspect && hasVal(suspect.name)) out.push("The patient received " + v(suspect.name) + (v(suspect.dose) ? " " + v(suspect.dose) : "") + (v(suspect.route) ? " by the " + v(suspect.route) + " route" : "") + (v(suspect.frequency) ? ", " + v(suspect.frequency) : "") + (v(suspect.indication) ? " for " + v(suspect.indication) : "") + (v(suspect.start_date) ? ", started on " + v(suspect.start_date) : suspect.start_not_reported ? "; the start date was not reported in the article" : "") + ".");
  const others = c.products.filter(x => x.role !== "suspect" && hasVal(x.name)).map(x => v(x.name));
  if (others.length) out.push("Other medicines mentioned: " + others.join(", ") + ".");
  events.forEach((e, i) => {
    const flags = Object.entries(e.seriousness || {}).filter(([k, on]) => on && k !== "serious").map(([k]) => k.replace(/_/g, " "));
    out.push((i === 0 ? "The patient experienced " : "The patient also experienced ") + v(e.verbatim) + (hasVal(e.pt) && v(e.pt).toLowerCase() !== v(e.verbatim).toLowerCase() ? " (coded as " + v(e.pt) + ")" : "") +
      (v(e.onset_date) ? ", with onset on " + v(e.onset_date) : v(e.time_to_onset) ? ", with onset " + v(e.time_to_onset) : e.onset_not_reported ? "; the onset date was not reported in the article" : "") +
      (e.seriousness?.serious ? ". The event was considered serious" + (flags.length ? " (" + flags.join(", ") + ")" : "") : "") + (v(e.outcome) ? ". Outcome: " + v(e.outcome) : "") + ".");
  });
  if (suspect) {
    if (hasVal(suspect.action_taken)) out.push("Action taken with " + (v(suspect.name) || "the suspect product") + ": " + v(suspect.action_taken) + ".");
    if (hasVal(suspect.dechallenge)) out.push("Dechallenge: " + v(suspect.dechallenge) + ".");
    if (hasVal(suspect.rechallenge)) out.push("Rechallenge: " + v(suspect.rechallenge) + ".");
  }
  if (c.treatment_given.length) out.push("Treatment given for the event: " + c.treatment_given.join(", ") + ".");
  if (c.confounders.length) out.push("Potential confounders: " + c.confounders.map(x => x.type + ": " + x.text).join("; ") + ".");
  return out.join(" ");
}
const xmlEsc = value => String(value ?? "").replace(/[&<>"]/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[ch]));
const hl7Date = value => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || "")); return m ? m[1] + m[2] + m[3] : ""; };
const hl7Now = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const UCUM_AGE = { years:"a", year:"a", months:"mo", month:"mo", weeks:"wk", week:"wk", days:"d", day:"d", hours:"h", hour:"h" };
// E2B(R3) code lists used below (ICH E2B(R3) Implementation Guide): outcome E.i.7, action taken G.k.8, seriousness criteria E.i.3.2.
const E2B_OUTCOME = [[/fatal/i, "5"], [/not recovered|unresolved|ongoing/i, "2"], [/sequel/i, "4"], [/recovering|improv|resolving/i, "3"], [/recovered|resolved/i, "1"]];
const E2B_ACTION = [[/withdrawn|stopped|discontinu/i, "1"], [/reduc/i, "2"], [/increas/i, "3"], [/not changed|continued/i, "4"], [/not applicable/i, "9"]];
const E2B_SERIOUS = { death:["34", "results in death"], life_threatening:["21", "life threatening"], hospitalization:["33", "caused / prolonged hospitalisation"], disability:["35", "disabling / incapacitating"], congenital_anomaly:["12", "congenital anomaly / birth defect"], other_medically_important:["26", "other medically important condition"] };
const codeFrom = (table, text) => (table.find(([re]) => re.test(String(text || ""))) || [])[1] || "";
const OID = { c11:"2.16.840.1.113883.3.989.2.1.3.1", c181:"2.16.840.1.113883.3.989.2.1.3.2", obs:"2.16.840.1.113883.3.989.2.1.1.19", meddra:"2.16.840.1.113883.6.163", batch:"2.16.840.1.113883.3.989.2.1.3.22",
  msgSender:"2.16.840.1.113883.3.989.2.1.3.11", msgReceiver:"2.16.840.1.113883.3.989.2.1.3.12", sender:"2.16.840.1.113883.3.989.2.1.3.13", receiver:"2.16.840.1.113883.3.989.2.1.3.14", patient:"2.16.840.1.113883.3.989.2.1.3.7" };
function e2bCase(rec, article, opts = {}) {
  const c = normalizeCase(rec.data), p = c.patient, suspect = firstSuspect(c), narrative = caseNarrativeText(c, rec.data.source_summary ? String(rec.data.source_summary).split("\n")[0] : "");
  const uid = () => crypto.randomUUID(), obs = (code, name, valueXml, extra = "") => `<observation classCode="OBS" moodCode="EVN"><code code="${code}" codeSystem="${OID.obs}" displayName="${xmlEsc(name)}"/>${extra}${valueXml}</observation>`;
  const sexCode = /^male$/i.test(v(p.sex)) ? "1" : /^female$/i.test(v(p.sex)) ? "2" : "";
  const evs = c.events.filter(e => hasVal(e.verbatim)), reactionIds = evs.map(() => uid()), drugList = c.products.filter(x => hasVal(x.name)), drugIds = drugList.map(() => uid());
  const reactions = evs.map((e, ei) => {
    const crit = Object.entries(E2B_SERIOUS).filter(([k]) => e.seriousness?.[k]).map(([k, [code, name]]) => obs(code, name, '<value xsi:type="BL" value="true"/>')).join("");
    const outcome = codeFrom(E2B_OUTCOME, v(e.outcome));
    const start = hl7Date(v(e.onset_date)), stop = hl7Date(v(e.stop_date));
    return `<subjectOf2 typeCode="SBJ"><observation classCode="OBS" moodCode="EVN"><id root="${reactionIds[ei]}"/><code code="29" codeSystem="${OID.obs}" displayName="reaction"/>` +
      (start || stop ? `<effectiveTime xsi:type="IVL_TS">${start ? `<low value="${start}"/>` : ""}${stop ? `<high value="${stop}"/>` : ""}</effectiveTime>` : "") +
      `<value xsi:type="CE"${hasVal(e.pt_code) ? ` code="${xmlEsc(v(e.pt_code))}" codeSystem="${OID.meddra}"${hasVal(e.meddra_version) ? ` codeSystemVersion="${xmlEsc(v(e.meddra_version))}"` : ""}` : ""}><originalText>${xmlEsc(v(e.verbatim))}</originalText></value>` +
      (crit || outcome ? `<outboundRelationship2 typeCode="PERT">${outcome ? obs("27", "outcome", `<value xsi:type="CE" code="${outcome}" codeSystem="2.16.840.1.113883.3.989.2.1.1.11"/>`) : ""}</outboundRelationship2>` : "") + `</observation></subjectOf2>` + (crit ? crit.split("</observation>").filter(Boolean).map(o => `<subjectOf2 typeCode="SBJ">${o}</observation></subjectOf2>`).join("") : "");
  }).join("");
  const drugs = drugList.map((x, di) => {
    const role = x.role === "suspect" ? "1" : x.role === "interacting" ? "3" : "2", action = codeFrom(E2B_ACTION, v(x.action_taken)), start = hl7Date(v(x.start_date)), stop = hl7Date(v(x.stop_date));
    return `<component typeCode="COMP"><substanceAdministration classCode="SBADM" moodCode="EVN"><id root="${drugIds[di]}"/>` +
      (start || stop ? `<effectiveTime xsi:type="IVL_TS">${start ? `<low value="${start}"/>` : ""}${stop ? `<high value="${stop}"/>` : ""}</effectiveTime>` : "") +
      `<consumable typeCode="CSM"><instanceOfKind classCode="INST"><kindOfProduct classCode="MMAT" determinerCode="KIND"><name>${xmlEsc(v(x.name))}</name></kindOfProduct></instanceOfKind></consumable>` +
      `<outboundRelationship2 typeCode="COMP">${obs("24", "drugCharacterization", `<value xsi:type="CE" code="${role}" codeSystem="2.16.840.1.113883.3.989.2.1.1.13"/>`)}</outboundRelationship2>` +
      (action ? `<outboundRelationship2 typeCode="PERT">${obs("9", "actionTaken", `<value xsi:type="CE" code="${action}" codeSystem="2.16.840.1.113883.3.989.2.1.1.15"/>`)}</outboundRelationship2>` : "") + `</substanceAdministration></component>`;
  }).join("");
  const history = p.medical_history.map(h => v(h)).filter(Boolean).map(h => `<component typeCode="COMP"><observation classCode="OBS" moodCode="EVN"><code code="1" codeSystem="${OID.obs}" displayName="relevantMedicalHistoryAndConcurrentConditions"/><value xsi:type="ED">${xmlEsc(h)}</value></observation></component>`).join("");
  const age = v(p.age) ? `<subjectOf2 typeCode="SBJ">${obs("3", "age", `<value xsi:type="PQ" value="${xmlEsc(v(p.age))}" unit="${UCUM_AGE[(v(p.age_unit) || "years").toLowerCase()] || "a"}"/>`)}</subjectOf2>` : "";
  const ageGroup = AGE_GROUPS.indexOf(v(p.age_group)) >= 0 ? `<subjectOf2 typeCode="SBJ">${obs("4", "ageGroup", `<value xsi:type="CE" code="${AGE_GROUPS.indexOf(v(p.age_group))}" codeSystem="2.16.840.1.113883.3.989.2.1.1.9"/>`)}</subjectOf2>` : "";
  // One causality assessment per reaction and suspect drug (E2B(R3) G.k.9.i), with the method and the reviewer's result.
  const causality = evs.flatMap((e, ei) => drugList.map((x, di) => x.role === "suspect" && (hasVal(e.causality_reviewer) || hasVal(e.causality_reporter)) ? `<component typeCode="COMP"><causalityAssessment classCode="OBS" moodCode="EVN"><code code="39" codeSystem="${OID.obs}" displayName="causality"/>` +
    `<value xsi:type="ST">${xmlEsc([hasVal(e.causality_reporter) ? "Reporter: " + v(e.causality_reporter) : "", hasVal(e.causality_reviewer) ? "Reviewer: " + v(e.causality_reviewer) : ""].filter(Boolean).join("; "))}</value>` +
    (hasVal(e.causality_method) ? `<methodCode><originalText>${xmlEsc(v(e.causality_method))}</originalText></methodCode>` : "") +
    `<subject1 typeCode="SUBJ"><adverseEffectReference classCode="OBS" moodCode="EVN"><id root="${reactionIds[ei]}"/></adverseEffectReference></subject1><subject2 typeCode="SUBJ"><productUseReference classCode="SBADM" moodCode="EVN"><id root="${drugIds[di]}"/></productUseReference></subject2></causalityAssessment></component>` : "").filter(Boolean)).join("");
  const qualCode = { physician:"1", pharmacist:"2", lawyer:"4", consumer:"5" }, qualText = v(c.reporter.qualification).toLowerCase(), qual = Object.entries(qualCode).find(([k]) => qualText.includes(k))?.[1] || (qualText ? "3" : "");
  const person = (name, org, email, phone, addr, country, code) => `<assignedEntity classCode="ASSIGNED">${code ? `<code code="${code}" codeSystem="2.16.840.1.113883.3.989.2.1.1.6"/>` : ""}${addr || country ? `<addr>${addr ? `<streetAddressLine>${xmlEsc(addr)}</streetAddressLine>` : ""}${country ? `<country>${xmlEsc(country)}</country>` : ""}</addr>` : ""}${phone ? `<telecom value="tel:${xmlEsc(phone)}"/>` : ""}${email ? `<telecom value="mailto:${xmlEsc(email)}"/>` : ""}${name ? `<assignedPerson classCode="PSN" determinerCode="INSTANCE"><name>${xmlEsc(name)}</name></assignedPerson>` : ""}${org ? `<representedOrganization classCode="ORG" determinerCode="INSTANCE"><name>${xmlEsc(org)}</name></representedOrganization>` : ""}</assignedEntity>`;
  const reporterXml = hasVal(c.reporter.identifier) || hasVal(c.reporter.organisation) ? `<outboundRelationship typeCode="SPRT"><relatedInvestigation classCode="INVSTG" moodCode="EVN"><code code="1" codeSystem="2.16.840.1.113883.3.989.2.1.1.22" displayName="sourceReport"/><subjectOf2 typeCode="SUBJ"><controlActEvent classCode="CACT" moodCode="EVN"><author typeCode="AUT">${person(v(c.reporter.identifier), v(c.reporter.organisation), v(c.reporter.email), v(c.reporter.phone), [v(c.reporter.department), v(c.reporter.address)].filter(Boolean).join(", "), v(c.reporter.country), qual)}</author></controlActEvent></subjectOf2></relatedInvestigation></outboundRelationship>` : "";
  const senderXml = hasVal(c.sender.organisation) || hasVal(c.sender.name) ? `<subjectOf1 typeCode="SUBJ"><controlActEvent classCode="CACT" moodCode="EVN"><author typeCode="AUT">${person(v(c.sender.name), v(c.sender.organisation), v(c.sender.email), v(c.sender.phone), v(c.sender.address), v(c.sender.country), "")}</author></controlActEvent></subjectOf1>` : "";
  const commentXml = (code, name, value) => value ? `<component typeCode="COMP"><observationEvent classCode="OBS" moodCode="EVN"><code code="${code}" codeSystem="${OID.obs}" displayName="${name}"/><value xsi:type="ED">${xmlEsc(value)}</value></observationEvent></component>` : "";
  const weight = v(p.weight) ? `<subjectOf2 typeCode="SBJ">${obs("7", "bodyWeight", `<value xsi:type="PQ" value="${xmlEsc(v(p.weight))}" unit="kg"/>`)}</subjectOf2>` : "";
  const received = hl7Date(rec.data.receipt_date) || hl7Date(rec.createdAt);
  const message = `<PORR_IN049016UV><id root="${OID.msgSender}" extension="${xmlEsc(rec.number)}"/><creationTime value="${hl7Now()}"/><interactionId root="2.16.840.1.113883.1.6" extension="PORR_IN049016UV"/><processingCode code="P"/><processingModeCode code="T"/><acceptAckCode code="AL"/>` +
    `<receiver typeCode="RCV"><device classCode="DEV" determinerCode="INSTANCE"><id root="${OID.msgReceiver}" extension="${xmlEsc(opts.receiver || "RECEIVER")}"/></device></receiver><sender typeCode="SND"><device classCode="DEV" determinerCode="INSTANCE"><id root="${OID.msgSender}" extension="${xmlEsc(opts.sender || "LITERASIFT")}"/></device></sender>` +
    `<controlActProcess classCode="CACT" moodCode="EVN"><code code="PORR_TE049016UV" codeSystem="2.16.840.1.113883.1.18"/><subject typeCode="SUBJ"><investigationEvent classCode="INVSTG" moodCode="EVN">` +
    `<id root="${OID.c11}" extension="${xmlEsc(rec.number)}"/><id root="${OID.c181}" extension="${xmlEsc(rec.number)}"/><code code="PAT_ADV_EVNT" codeSystem="2.16.840.1.113883.5.4"/><text>${xmlEsc(narrative)}</text><statusCode code="active"/>` +
    (received ? `<effectiveTime><low value="${received}"/></effectiveTime><availabilityTime value="${received}"/>` : "") +
    (rec.data.source_summary && c.source_type !== "social" ? `<reference typeCode="REFR"><document classCode="DOC" moodCode="EVN"><code code="2" codeSystem="2.16.840.1.113883.3.989.2.1.1.4" displayName="literatureReference"/><bibliographicDesignationText>${xmlEsc(String(rec.data.source_summary).split("\n")[0].slice(0, 500))}</bibliographicDesignationText></document></reference>` : "") +
    `<component typeCode="COMP"><adverseEventAssessment classCode="INVSTG" moodCode="EVN"><subject1 typeCode="SBJ"><primaryRole classCode="INVSBJ"><id root="${OID.patient}" extension="${xmlEsc(rec.number)}-P"/>` +
    `<player1 classCode="PSN" determinerCode="INSTANCE">${v(p.identifier) ? `<name>${xmlEsc(v(p.identifier))}</name>` : ""}${sexCode ? `<administrativeGenderCode code="${sexCode}" codeSystem="1.0.5218"/>` : ""}</player1>` +
    age + ageGroup + weight + reactions + (drugs ? `<subjectOf2 typeCode="SBJ"><organizer classCode="CATEGORY" moodCode="EVN"><code code="4" codeSystem="${OID.obs}" displayName="drugInformation"/>${drugs}</organizer></subjectOf2>` : "") +
    (history ? `<subjectOf2 typeCode="SBJ"><organizer classCode="CATEGORY" moodCode="EVN"><code code="1" codeSystem="${OID.obs}" displayName="relevantMedicalHistoryAndConcurrentConditions"/>${history}</organizer></subjectOf2>` : "") +
    `</primaryRole></subject1>${causality}</adverseEventAssessment></component>` + commentXml("10", "reportersComments", c.general_comments) + commentXml("2", "sendersComments", c.sender_comments) + reporterXml + senderXml + `</investigationEvent></subject></controlActProcess></PORR_IN049016UV>`;
  return message;
}
function e2bBatch(records, articles, opts = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<MCCI_IN200100UV01 ITSVersion="XML_1.0" xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><id root="${OID.batch}" extension="${xmlEsc(opts.batchId || "LS-" + hl7Now())}"/><creationTime value="${hl7Now()}"/><responseModeCode code="D"/><interactionId root="2.16.840.1.113883.1.6" extension="MCCI_IN200100UV01"/>` +
    `<name code="1" codeSystem="2.16.840.1.113883.3.989.2.1.1.1"/>` + records.map(r => e2bCase(r, articles[r.pmid], opts)).join("") +
    `<receiver typeCode="RCV"><device classCode="DEV" determinerCode="INSTANCE"><id root="${OID.receiver}" extension="${xmlEsc(opts.receiver || "RECEIVER")}"/></device></receiver><sender typeCode="SND"><device classCode="DEV" determinerCode="INSTANCE"><id root="${OID.sender}" extension="${xmlEsc(opts.sender || "LITERASIFT")}"/></device></sender></MCCI_IN200100UV01>\n`;
}
// CIOMS I report in the layout used by PV Nexus exports: sections 0 to X, a frame and running header on every page, navy section bars, labelled cells, one row per event.
function ciomsPdf(rec, article) {
  const c = normalizeCase(rec.data), p = c.patient, events = c.events.filter(e => hasVal(e.verbatim)), suspects = c.products.filter(x => x.role === "suspect" && hasVal(x.name)), others = c.products.filter(x => x.role !== "suspect" && hasVal(x.name));
  const assessment = localAssessment(c), reg = regulatoryContext([], c, rec.molecule), signature = activeSignature(rec);
  const [pw, ph] = pdfPage, left = 44, width = pw - 88, top0 = ph - 58, bottom = 56, NAVY = [0.12, 0.23, 0.54], GRAY = [0.45, 0.47, 0.52], DARK = [0.1, 0.1, 0.12];
  const pages = []; let ops, y;
  const dash = value => (value == null || String(value).trim() === "" ? "-" : String(value));
  const text = (x, yy, value, size = 9, bold = false, color = DARK) => ops.push(`BT ${color[0]} ${color[1]} ${color[2]} rg /F${bold ? 2 : 1} ${size} Tf ${x.toFixed(2)} ${yy.toFixed(2)} Td (${pdfEscape(value)}) Tj ET`);
  const rect = (x, yy, w, h, { fill, stroke, line = 0.6 } = {}) => ops.push((fill ? `${fill[0]} ${fill[1]} ${fill[2]} rg ` : "") + (stroke ? `${stroke[0]} ${stroke[1]} ${stroke[2]} RG ${line} w ` : "") + `${x.toFixed(2)} ${yy.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re ${fill && stroke ? "B" : fill ? "f" : "S"}`);
  const newPage = () => {
    ops = []; pages.push(ops); y = top0;
    rect(30, 30, pw - 60, ph - 60, { stroke:[0.78, 0.8, 0.86] });
    text(left - 2, ph - 44, "CIOMS I · INDIVIDUAL CASE SAFETY REPORT", 8, false, NAVY);
    ops.push(`0.12 0.23 0.54 RG 0.6 w ${left - 2} ${ph - 49} m ${pw - left + 2} ${ph - 49} l S`);
  };
  const need = h => { if (y - h < bottom) newPage(); };
  const lines = (value, size, w, bold) => wrap(dash(value), size, bold, w);
  const band = title => { need(40); y -= 8; rect(left, y - 20, width, 20, { fill:NAVY }); text(left + 8, y - 14, title, 10, false, [1, 1, 1]); y -= 24; };
  const caption = value => { need(70); text(left, y - 9, value, 8.5, false, GRAY); y -= 16; };
  const cells = (items, minH = 36) => {
    const total = items.reduce((n, i) => n + (i.w || 1), 0), cellH = Math.max(minH, ...items.map(i => 20 + lines(i.value, 10, (i.w || 1) / total * width - 12).length * 12.5));
    need(cellH + 8); let x = left;
    for (const item of items) {
      const w = (item.w || 1) / total * width - 6;
      rect(x, y - cellH, w, cellH, { stroke:[0.8, 0.82, 0.88] }); text(x + 6, y - 11, item.label, 7.5, false, GRAY);
      lines(item.value, 10, w - 12).forEach((line, i) => text(x + 6, y - 25 - i * 12.5, line, 10));
      x += w + 6;
    }
    y -= cellH + 6;
  };
  const table = (headers, widths, rows, empty = "Not recorded.") => {
    const total = widths.reduce((a, b) => a + b, 0), cols = widths.map(w => w / total * width);
    need(34); rect(left, y - 17, width, 17, { fill:[0.93, 0.94, 0.97] });
    let x = left; headers.forEach((h, i) => { text(x + 6, y - 12, h, 8, false, GRAY); x += cols[i]; }); y -= 17;
    if (!rows.length) { need(20); text(left + 6, y - 14, empty, 10); y -= 22; return; }
    for (const row of rows) {
      const wrapped = row.map((cell, i) => lines(cell, 9.5, cols[i] - 10)), h = Math.max(...wrapped.map(l => l.length)) * 12 + 8;
      need(h + 2); x = left;
      wrapped.forEach((cellLines, i) => { cellLines.forEach((line, j) => text(x + 6, y - 14 - j * 12, line, 9.5)); x += cols[i]; });
      ops.push(`0.85 0.86 0.9 RG 0.4 w ${left} ${y - h} m ${left + width} ${y - h} l S`); y -= h;
    }
    y -= 4;
  };
  const box = (value, size = 10, fill) => {
    const all = String(value || "-").split("\n").flatMap(part => wrap(part || " ", size, false, width - 20)), lineH = size + 3;
    let done = 0;
    while (done < all.length) {
      need(lineH * 3 + 16); const fit = Math.max(1, Math.min(all.length - done, Math.floor((y - bottom - 12) / lineH))), h = fit * lineH + 12;
      rect(left, y - h, width, h, { stroke:[0.8, 0.82, 0.88], fill });
      all.slice(done, done + fit).forEach((line, i) => text(left + 10, y - 14 - i * lineH, line, size));
      y -= h + 6; done += fit;
    }
  };
  const warn = value => { const all = wrap(value, 9, false, width - 20), h = all.length * 12 + 12; need(h + 8); rect(left, y - h, width, h, { fill:[1, 0.97, 0.87], stroke:[0.93, 0.8, 0.45] }); all.forEach((line, i) => text(left + 10, y - 15 - i * 12, line, 9, false, [0.55, 0.35, 0.05])); y -= h + 8; };
  const checks = flags => {
    const items = [["death", "Death"], ["life_threatening", "Life-threatening"], ["hospitalization", "Hospitalization / prolongation"], ["disability", "Persistent or significant disability/incapacity"], ["congenital_anomaly", "Congenital anomaly / birth defect"], ["other_medically_important", "Other medically important condition"]];
    need(56);
    items.forEach(([key, label], i) => { const x = left + (i % 2) * (width / 2), yy = y - Math.floor(i / 2) * 20; rect(x, yy - 10, 10, 10, { stroke:[0.3, 0.3, 0.35], line:0.8 }); if (flags[key]) { text(x + 1.8, yy - 8.5, "x", 9, true); } text(x + 17, yy - 9, label, 10); });
    y -= 64;
  };
  newPage();
  text(left, y - 22, "INDIVIDUAL CASE SAFETY REPORT", 24, false); text(left, y - 40, "CIOMS I form · Suspect Adverse Reaction Report", 11, false, GRAY);
  text(left, y - 56, [v(suspects[0]?.name), v(events[0]?.verbatim)].filter(Boolean).join(" · "), 10.5, false, NAVY); y -= 66;
  ops.push(`0.12 0.23 0.54 RG 1 w ${left} ${y} m ${left + width} ${y} l S`); y -= 12;
  warn("Causality, seriousness, dechallenge, rechallenge and expectedness reflect the latest saved case data" + (signature ? ", signed by " + signature.signer_name + " on " + signature.signed_at.slice(0, 10) + "." : "; a human-confirmed medical assessment has not yet been recorded for this case."));
  if (c.warnings.length && !signature) warn("Values marked as proposed were filled from the article and have not been confirmed by a reviewer yet.");
  band("0. ADMINISTRATIVE INFORMATION");
  cells([{ label:"Sender case identifier", value:rec.number }, { label:"Report type", value:"initial" }, { label:"Source type", value:c.source_type === "social" ? "social media (patient-reported)" : "literature" }]);
  cells([{ label:"Day 0 / receipt date", value:c.receipt_date }, { label:"Validity status", value:assessment.validity.valid_icsr ? "valid" : "incomplete: " + assessment.validity.missing.join(", ") }, { label:"Country of incidence", value:v(p.country) }]);
  band("I. PATIENT INFORMATION");
  cells([{ label:"1 Patient identifier", value:v(p.identifier) }, { label:"2 Age at onset", value:ageText(p) }, { label:"2a Age group", value:v(p.age_group) }, { label:"3 Sex", value:v(p.sex).toLowerCase() }, { label:"Weight (kg)", value:v(p.weight) }, { label:"Country", value:v(p.country) }]);
  band("II. ADVERSE REACTION INFORMATION");
  const first = events[0] || {}, merged = {}; for (const e of events) for (const [k, on] of Object.entries(e.seriousness || {})) if (on) merged[k] = true;
  cells([{ label:"4 Reaction onset date", value:v(first.onset_date) || v(first.time_to_onset) || (first.onset_not_reported ? "not reported in the article" : "") }, { label:"5 Reaction outcome", value:v(first.outcome) || "unknown" }, { label:"7 Date received (Day 0)", value:c.receipt_date }]);
  caption("6. Seriousness criteria (check all that apply)"); checks(merged);
  caption("Reaction/event terms (" + events.length + ")");
  table(["Verbatim term", "Coded term", "Onset", "Stop", "Outcome", "Seriousness"], [2, 1.9, 1.2, 1.2, 2.2, 1.6], events.map(e => [v(e.verbatim), [v(e.pt), v(e.pt_code)].filter(Boolean).join(" ") || "-", v(e.onset_date) || v(e.time_to_onset) || "-", v(e.stop_date) || "-", v(e.outcome) || "unknown", e.seriousness?.serious ? "serious" : "non-serious"]));
  band("III. SUSPECT DRUG(S) INFORMATION");
  table(["12. Suspect drug", "13. Dose/frequency", "Route", "15. Indication", "Batch/lot"], [2.2, 1.8, 1.2, 1.8, 1.2], suspects.map(x => [v(x.name), [v(x.dose), v(x.frequency)].filter(Boolean).join(", ") || "-", v(x.route) || "-", v(x.indication) || "-", "-"]));
  caption("14. Exposure dates & 16/17. Dechallenge / rechallenge");
  table(["12. Suspect drug", "Start date", "Stop date", "16. Dechallenge", "17. Rechallenge", "Action taken"], [2, 1.3, 1.3, 1.6, 1.6, 1.6], suspects.map(x => [v(x.name), v(x.start_date) || (x.start_not_reported ? "not reported in the article" : "-"), v(x.stop_date) || "-", v(x.dechallenge) || "-", v(x.rechallenge) || "-", v(x.action_taken) || "-"]));
  band("IV. CONCOMITANT DRUG(S), HISTORY & INVESTIGATIONS");
  caption("18. Concomitant drugs");
  table(["Drug", "Dose/frequency", "Route", "Start", "Stop", "Indication"], [2, 1.6, 1.1, 1.1, 1.1, 1.6], others.map(x => [v(x.name), [v(x.dose), v(x.frequency)].filter(Boolean).join(", ") || "-", v(x.route) || "-", v(x.start_date) || "-", v(x.stop_date) || "-", v(x.indication) || "-"]));
  caption("19. Other relevant history (allergies, pregnancy, pre-existing conditions)");
  table(["Condition", "Start", "End", "Ongoing"], [4, 1.4, 1.4, 1.2], p.medical_history.filter(hasVal).map(h => [v(h), "-", "-", "-"]));
  caption("Relevant investigations / laboratory results");
  table(["Test", "Result", "Unit", "Reference range", "Date"], [2.2, 1.4, 1, 1.6, 1.2], (c.labs || []).slice(0, 30).map(l => [l.test || l.name, l.result || l.value, l.unit, l.reference_range || l.range, l.date]));
  band("V. MEDICAL ASSESSMENT");
  (events.length ? events : [{}]).forEach((e, i) => {
    if (events.length > 1) { caption("Event " + (i + 1) + " of " + events.length + ": " + v(e.verbatim)); }
    cells([{ label:"Reporter causality", value:v(e.causality_reporter) }, { label:"Reviewer causality (WHO-UMC)", value:v(e.causality_reviewer) }, { label:"Assessment method", value:v(e.causality_method) }]);
    cells([{ label:"Temporal relationship", value:v(e.temporal_relationship) }, { label:"Alternative causes", value:v(e.alternative_causes) }, { label:"Concomitant factors", value:v(e.concomitant_factors) }, { label:"Objective evidence", value:v(e.objective_evidence) }]);
    cells([{ label:"Listedness / expectedness", value:v(e.expectedness) || v(e.listedness) }, { label:"Assessed reaction term", value:v(e.assessed_term) || v(e.pt) || v(e.verbatim) }, { label:"Reference safety information", value:v(e.rsi) }]);
    caption("Causality rationale"); box(v(e.causality_rationale) || "-");
    caption("Medical reviewer comment"); box(v(e.reviewer_comment) || " ");
  });
  band("VI. NARRATIVE SUMMARY"); box(caseNarrativeText(c, ""));
  band("VII. REPORTER AND SENDER INFORMATION");
  table(["30. Qualification", "Type", "31. Country", "Organization", "Primary"], [2, 1.2, 1.2, 2.6, 0.9], [[v(c.reporter.qualification) || v(c.reporter.identifier), c.source_type === "social" ? "consumer" : "literature", v(c.reporter.country), v(c.reporter.organisation), "Yes"]]);
  cells([{ label:"Reporter (first author)", value:v(c.reporter.identifier) }, { label:"Reporter e-mail / phone", value:[v(c.reporter.email), v(c.reporter.phone)].filter(Boolean).join(" · ") }, { label:"Reporter address", value:[v(c.reporter.department), v(c.reporter.address)].filter(Boolean).join(", ") }]);
  cells([{ label:"Sender type", value:v(c.sender.type) }, { label:"Sender organisation", value:v(c.sender.organisation) }, { label:"Sender contact", value:[v(c.sender.name), v(c.sender.email), v(c.sender.phone)].filter(Boolean).join(" · ") }]);
  band("VIII. CASE NARRATIVE");
  box((c.source_type === "social" ? "Patient-reported post: " : "Literature report: ") + String(rec.data.source_summary || "").split("\n")[0] + (article?.doi ? " DOI " + article.doi + "." : "") + (article?.id ? " PMID " + article.id + "." : ""));
  if (c.general_comments) { caption("General comments (reporter)"); box(c.general_comments); }
  if (c.sender_comments) { caption("Sender's comments"); box(c.sender_comments); }
  band("IX. QUALITY CONTROL SUMMARY");
  const blocking = assessment.qc.findings.filter(f => f.severity === "critical" || f.severity === "major"), grade = assessment.qc.score >= 90 ? "A" : assessment.qc.score >= 75 ? "B" : assessment.qc.score >= 60 ? "C" : "D";
  cells([{ label:"Latest QC score", value:assessment.qc.score + " / 100" }, { label:"Grade", value:grade }, { label:"Blocking findings", value:blocking.length ? "Yes (" + blocking.length + ")" : "No" }, { label:"Open findings", value:String(assessment.qc.findings.length) }, { label:"Source documents", value:String(c.source_documents.length) }], 36);
  if (blocking.length) box(blocking.map(f => "- " + f.title).join("\n"), 9);
  band("X. FEATURE COVERAGE & EXPORT MAP");
  box("This appendix maps every case-workbench capability to the section or companion artifact that carries it. Record counts reflect the saved case at generation time.", 10);
  const state = (n, ok) => n ? ok : "Not recorded";
  table(["Workbench feature", "Status", "Records", "Export destination"], [2.6, 1.6, 0.9, 3], [
    ["Source evidence & full-text intake", article?.fullTextKey ? "Captured" : "Abstract only", String(c.source_documents.length), "Administrative fields & source register"],
    ["Products, reactions & clinical data", events.length ? "Captured" : "Pending", String(events.length + c.products.length), "Sections II-IV"],
    ["Medical assessment (WHO-UMC)", events.some(e => v(e.causality_reviewer)) ? "Suggested: confirm" : "Pending", String(events.filter(e => v(e.causality_reviewer)).length), "Section V"],
    ["MedDRA coding", state(events.filter(e => hasVal(e.pt)).length, "Coded"), String(events.filter(e => hasVal(e.pt)).length), "Section II"],
    ["Narrative", "Generated from case fields", "1", "Sections VI and VIII"],
    ["Follow-up questions", assessment.follow_up.questions.length + " open", String(assessment.follow_up.questions.length), "Operational appendix"],
    ["Quality control", assessment.qc.score + " / 100", String(assessment.qc.findings.length), "Section IX"],
    ["Assignment & reporting due date", (rec.assignee || "Unassigned") + (rec.dueAt ? ", due " + rec.dueAt : ""), "1", "Regulatory appendix"],
    ["Electronic signature", signature ? "Signed" : "Not signed", String((rec.signatures || []).length), "SIGNATURES.txt"],
    ["Audit trail", "Hash-chained", String((rec.history || []).length), "Governance appendix"],
    ["Regulatory reporting & E2B", reg.country ? "Due " + (reg.due || "-") : "Country needed", "0", "E2B(R3) XML"]]);
  // running footer with page numbers
  pages.forEach((page, i) => {
    ops = page;
    text(left - 2, 40, "DRAFT - pending human-confirmed medical assessment" + (signature ? " (signed " + signature.signed_at.slice(0, 10) + ")" : ""), 8, false, [0.8, 0.4, 0.1]);
    text(pw - left - 120, 40, rec.number + "  |  Page " + (i + 1) + " of " + pages.length, 8, false, GRAY);
  });
  const objects = [["<< /Type /Catalog /Pages 2 0 R >>"], [`<< /Type /Pages /Kids [${pages.map((_, i) => 5 + i * 2 + " 0 R").join(" ")}] /Count ${pages.length} >>`], ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"], ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"]];
  for (const page of pages) {
    const content = textBytes(page.join("\n")), contentId = objects.length + 2;
    objects.push([`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`]);
    objects.push([`<< /Length ${content.length} >>\nstream\n`, content, "\nendstream"]);
  }
  const chunks = [], offsets = []; let length = 0;
  const push = piece => { const bytes = typeof piece === "string" ? textBytes(piece) : piece; chunks.push(bytes); length += bytes.length; };
  push("%PDF-1.4\n");
  objects.forEach((parts, i) => { offsets.push(length); push(`${i + 1} 0 obj\n`); parts.forEach(push); push("\nendobj\n"); });
  const xref = length;
  push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("") + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length); let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}
// HL7 FHIR R4 Bundle: Patient, Medication (contained) and AdverseEvent resources.
function fhirBundle(rec, article) {
  const c = normalizeCase(rec.data), p = c.patient, suspect = firstSuspect(c), events = c.events.filter(e => hasVal(e.verbatim));
  const patientId = "patient-" + rec.number, entries = [{ fullUrl:"urn:uuid:" + patientId, resource:{ resourceType:"Patient", id:patientId, gender:/^male$/i.test(v(p.sex)) ? "male" : /^female$/i.test(v(p.sex)) ? "female" : "unknown",
    ...(v(p.identifier) ? { name:[{ text:v(p.identifier) }] } : {}), extension:[...(v(p.age) ? [{ url:"http://literasift.tech/fhir/age", valueQuantity:{ value:Number(v(p.age)), unit:v(p.age_unit) || "years" } }] : []), ...(v(p.country) ? [{ url:"http://literasift.tech/fhir/country", valueString:v(p.country) }] : [])] } }];
  events.forEach((e, i) => entries.push({ fullUrl:"urn:uuid:ae-" + rec.number + "-" + (i + 1), resource:{ resourceType:"AdverseEvent", id:"ae-" + rec.number + "-" + (i + 1), actuality:"actual", event:{ text:v(e.verbatim), ...(hasVal(e.pt_code) ? { coding:[{ system:"http://terminology.hl7.org/CodeSystem/mdr", code:v(e.pt_code), display:v(e.pt) }] } : {}) },
    subject:{ reference:"urn:uuid:" + patientId }, ...(v(e.onset_date) ? { date:v(e.onset_date) } : {}), seriousness:{ text:e.seriousness?.serious ? "Serious" : "Non-serious" }, ...(hasVal(e.outcome) ? { outcome:{ text:v(e.outcome) } } : {}),
    ...(suspect && hasVal(suspect.name) ? { suspectEntity:[{ instance:{ display:v(suspect.name) } }] } : {}), note:[{ text:caseNarrativeText(c, "") }] } }));
  return { resourceType:"Bundle", type:"collection", identifier:{ system:"http://literasift.tech/case", value:rec.number }, timestamp:new Date().toISOString(), entry:entries };
}
// Line listing: one row per case and event (the layout used for periodic reports and spreadsheets).
function lineListing(records, articles) {
  const head = ["Case", "PMID", "Status", "Assignee", "Due", "Country", "Age", "Age group", "Sex", "Suspect product", "Event (verbatim)", "PT", "PT code", "SOC", "Serious", "Onset", "Outcome", "Causality (WHO-UMC)", "Action taken", "Reference"];
  const rows = [];
  for (const r of records) {
    const c = normalizeCase(r.data), s = firstSuspect(c) || {}, events = c.events.filter(e => hasVal(e.verbatim));
    for (const e of events.length ? events : [{}]) rows.push([r.number, r.pmid, r.status, r.assignee || "", r.dueAt || "", v(c.patient.country), ageText(c.patient), v(c.patient.age_group), v(c.patient.sex), v(s.name), v(e.verbatim), v(e.pt), v(e.pt_code), v(e.soc), e.seriousness?.serious ? "Yes" : "No", v(e.onset_date), v(e.outcome), v(e.causality_reviewer), v(s.action_taken), String(r.data.source_summary || "").split("\n")[0]]);
  }
  return [head, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
// ---- Case series summary and trend check. Every figure is counted from the case fields, and each one lists the cases it counts, so nothing is estimated or
// written by a model. The median + MAD hike rule follows pharmacovigilance-verified-safety-report-agent (MIT, Copyright (c) 2026 NiharNandala): a mean and standard
// deviation can be pulled up by the very spike they should find, while the median and MAD cannot. ----
const medianOf = list => { const a = [...list].sort((x, y) => x - y), m = a.length >> 1; return a.length ? (a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) : 0; };
function robustHikes(rows) {
  const counts = rows.map(r => r.count), median = medianOf(counts), mad = medianOf(counts.map(x => Math.abs(x - median))), scaled = mad * 1.4826;
  // A perfectly flat series has no spread, so a floor of 1 stops every one-case rise being called a hike.
  const upper = median + 2 * Math.max(scaled, 1);
  return { median, mad:Number(scaled.toFixed(2)), upper:Number(upper.toFixed(2)), hikes:rows.filter(r => r.count > upper) };
}
function seriesSummary(cases) {
  const list = cases.filter(c => c.status !== "Closed: not a valid ICSR"), tally = (keyOf, limit = 8) => {
    const map = new Map();
    for (const c of list) for (const key of new Set([].concat(keyOf(c)).filter(Boolean))) (map.get(key) || map.set(key, []).get(key)).push(c.number);
    return [...map].map(([key, nums]) => ({ key, count:nums.length, cases:nums })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)).slice(0, limit);
  };
  const norm = c => normalizeCase(c.data), serious = c => norm(c).events.some(e => Object.values(e.seriousness || {}).some(Boolean)), fatal = c => norm(c).events.some(e => e.seriousness?.death);
  const band = c => { const p = norm(c).patient, n = Number(v(p.age)); if (!v(p.age)) return "Unknown"; const years = /month/i.test(v(p.age_unit)) ? n / 12 : /week/i.test(v(p.age_unit)) ? n / 52 : /day|hour/i.test(v(p.age_unit)) ? n / 365 : n; return years < 18 ? "Under 18" : years < 65 ? "18 to 64" : "65 and over"; };
  const month = c => String(c.data.receipt_date || c.createdAt || "").slice(0, 7);
  const monthly = tally(month, 1000).sort((a, b) => a.key.localeCompare(b.key)).map(r => ({ month:r.key, count:r.count, cases:r.cases }));
  const trend = robustHikes(monthly);
  return { total:list.length, serious:list.filter(serious).map(c => c.number), fatal:list.filter(fatal).map(c => c.number),
    events:tally(c => norm(c).events.map(e => v(e.pt) || v(e.verbatim)).filter(Boolean)), products:tally(c => v(firstSuspect(norm(c))?.name)), countries:tally(c => v(norm(c).patient.country)), sex:tally(c => v(norm(c).patient.sex) || "Unknown"), ages:tally(band),
    monthly, trend:{ ...trend, hikes:trend.hikes.map(h => h.month), basis:monthly.length < 4 ? "Too few months to judge a trend (needs at least 4)." : "Months above the upper limit are flagged." } };
}
// Coding memory: MedDRA codings a reviewer marked "Reviewed" in earlier cases, offered as hints in the event picker. It is derived from cases, so deleting it never changes a case:
// a clear date and a list of removed entries decide what still counts. Every deletion is written to the audit trail.
const memoryKey = (c, e) => c.id + "|" + imeNorm(v(e.verbatim)) + "|" + imeNorm(v(e.pt));
function memoryEntries(state) {
  const cleared = state.codingMemory?.clearedAt || "", removed = new Set(state.codingMemory?.removed || []), out = [];
  for (const c of state.cases || []) {
    if (cleared && String(c.updatedAt || "") <= cleared) continue;
    for (const e of c.data?.events || []) {
      if (e.coding_status?.value !== "Reviewed" || !hasVal(e.pt) || !hasVal(e.verbatim)) continue;
      const key = memoryKey(c, e);
      if (!removed.has(key)) out.push({ key, case:c.number, caseId:c.id, createdBy:c.createdBy, assignee:c.assignee, verbatim:v(e.verbatim), llt:v(e.llt), pt:v(e.pt), pt_code:v(e.pt_code), hlt:v(e.hlt), hlgt:v(e.hlgt), soc:v(e.soc), version:v(e.meddra_version), at:c.updatedAt });
    }
  }
  return out;
}
const caseStatuses = ["Draft", "Ready for medical review", "Sent to PV Nexus", "Closed: not a valid ICSR"];
// ---- Electronic signatures (21 CFR Part 11 pattern, design from argus-auditable-rag, MIT): signer, meaning, time, and a hash that binds the
// signature to exactly what was signed. The server recomputes that hash, so a signature over different content is rejected. ----
const SIGN_MEANINGS = {
  case_approve:{ label:"Approve for medical review", statement:"I have reviewed the article, the proposed case values and the assessment, and I approve this case for medical review.", status:"Ready for medical review", approval:true },
  case_invalid:{ label:"Not a valid ICSR", statement:"I have reviewed the article and I confirm that this is not a valid ICSR, for the reason recorded in the notes.", status:"Closed: not a valid ICSR", approval:true },
  screening:{ label:"Screening decision", statement:"I have read this article and I record the screening decision and notes as my own.", status:"Complete", approval:false } };
// What the signer saw: the citation, abstract, detected events and the stored full-text reference. A change to any of it invalidates the review.
const evidenceHash = article => sha256(canonicalJson({ id:article?.id, title:article?.title, abstract:article?.abstract, doi:article?.doi, authors:article?.authors, journal:article?.journal, date:article?.date,
  events:(article?.events || []).map(e => e.term), fullText:[article?.fullTextKey, article?.fullTextStatus, article?.fullTextSource], keyPassages:article?.keyPassages || [] }));
async function signContent(kind, record, article, meaningCode) {
  const meaning = SIGN_MEANINGS[meaningCode], evidence = await evidenceHash(article);
  const content = kind === "case" ? { kind, case_id:record.id, number:record.number, pmid:record.pmid, meaning:meaningCode, signed_status:meaning.status, data:normalizeCase(record.data), notes:record.notes || "", evidence_sha256:evidence }
    : { kind, assignment_id:record.id, pmid:record.pmid, portfolio:record.portfolio, molecules:record.molecules || [], meaning:meaningCode, signed_status:meaning.status, note:record.note || "", evidence_sha256:evidence };
  return { content, content_sha256:await sha256(canonicalJson(content)), evidence_sha256:evidence };
}
const activeSignature = record => [...(record?.signatures || [])].reverse().find(s => !s.superseded) || null;
// True while the record still matches what was signed; null when there is no active signature.
async function signatureIntact(kind, record, article) {
  const sig = activeSignature(record);
  if (!sig) return null;
  return (await signContent(kind, record, article, sig.meaning)).content_sha256 === sig.content_sha256;
}
function signPolicyProblems(state, kind, record, meaning, viewer, manager) {
  const problems = [], settings = state.settings || {};
  if (activeSignature(record)) problems.push("Already signed. A manager must supersede the signature before it can change.");
  if (meaning.approval && (settings.esignApprovers || "manager") === "manager" && !manager) problems.push("Only managers may sign approvals (this can be changed in Settings).");
  if (kind === "case" && meaning.approval && settings.esignFourEyes === true && record.createdBy === viewer.email) problems.push("Four-eyes rule: the person who created the case cannot approve it.");
  if (kind === "case") {
    const local = localAssessment(record.data);
    if (meaning.status === "Ready for medical review" && !local.qc.ready_for_medical_review) problems.push("Not ready for medical review yet. " + (local.validity.missing.length ? "Missing: " + local.validity.missing.join(", ") + ". " : "") + local.qc.findings.filter(f => f.severity === "major" || f.severity === "critical").slice(0, 3).map(f => f.title).join("; "));
    if (meaning.status === "Closed: not a valid ICSR" && !String(record.notes || "").trim()) problems.push("Add a note explaining why this is not a valid ICSR.");
  }
  return problems;
}
const signatureText = s => "Signed by " + s.signer_name + " (" + s.signer_id + ") on " + s.signed_at + " UTC.\nMeaning: " + s.meaning_text + "\nAuthentication: " + s.auth + "\nContent SHA-256: " + s.content_sha256 + "\nEvidence SHA-256: " + s.evidence_sha256 + (s.superseded ? "\nSUPERSEDED " + s.superseded.at + " by " + s.superseded.by + ": " + s.superseded.reason : "") + "\n";
// ---- Sources: PubMed literature is kept separate from other government agency material ----
const sourceRegistry = [
  { id:"PubMed", label:"PubMed (NLM / NIH)", kind:"literature", active:true, note:"Biomedical literature citations, abstracts and open full text." },
  { id:"FDA", label:"US FDA", kind:"agency", active:false, note:"Drug safety communications and labelling changes." },
  { id:"EMA", label:"EU EMA", kind:"agency", active:false, note:"Pharmacovigilance (PRAC) recommendations and safety updates." },
  { id:"MHRA", label:"UK MHRA", kind:"agency", active:false, note:"Drug Safety Update bulletins." },
  { id:"WHO", label:"WHO", kind:"agency", active:false, note:"Pharmacovigilance alerts and safety communications." },
  { id:"Health Canada", label:"Health Canada", kind:"agency", active:false, note:"Advisories and recalls." },
  { id:"CDSCO", label:"CDSCO India", kind:"agency", active:false, note:"Drug alerts and safety notices." } ];
const articleSource = a => a?.source || "PubMed";
// ---- Library: a folder per molecule and a subfolder per pull's date range ----
const safeName = value => String(value || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 80) || "unnamed";
// Folders are Source / Molecule / Date range. Each article sits in the first (oldest) date range that imported it, once per source and molecule.
function libraryLayout(state, by = "range") {
  const seen = new Set(), out = [];
  for (const run of [...state.runs].reverse()) {
    if (run.status !== "Imported") continue;
    const source = safeName(run.source || "PubMed"), molecule = safeName(run.molecule || run.portfolio), range = run.from + "_to_" + run.to;
    for (const pmid of run.ids) {
      if (seen.has(pmid + "|" + source + "|" + molecule)) continue;
      seen.add(pmid + "|" + source + "|" + molecule);
      const c = articleCountry(state.articles[pmid]), country = safeName(c.name);
      out.push({ pmid, source, molecule, range, country, basis:c.basis, folder:by === "country" ? source + "/" + country + "/" + molecule : source + "/" + molecule + "/" + range });
    }
  }
  // Numbers are stable: a folder's membership is fixed when its pull imports, and articles are numbered by PMID within it.
  const byFolder = new Map();
  for (const e of out) (byFolder.get(e.folder) || byFolder.set(e.folder, []).get(e.folder)).push(e);
  for (const list of byFolder.values()) {
    list.sort((a, b) => Number(a.pmid) - Number(b.pmid) || a.pmid.localeCompare(b.pmid));
    list.forEach((e, i) => { e.n = i + 1; e.width = Math.max(3, String(list.length).length); });
  }
  return out.sort((a, b) => a.folder.localeCompare(b.folder) || a.n - b.n);
}
const libTag = e => String(e.n).padStart(e.width, "0");
// ---- ZIP (stored, no compression) for bulk full-text download ----
const crcTable = (() => { const table = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } return table; })();
const crc32 = bytes => { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zipFiles(files) {
  const encoder = new TextEncoder(), now = new Date(), parts = [], central = [];
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1), dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  let offset = 0, centralSize = 0;
  for (const file of files) {
    const name = encoder.encode(file.name), crc = crc32(file.data), local = new DataView(new ArrayBuffer(30));
    [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, dosTime, 2], [12, dosDate, 2], [14, crc, 4], [18, file.data.length, 4], [22, file.data.length, 4], [26, name.length, 4]]
      .forEach(([at, value, size]) => size === 4 && at !== 26 ? local.setUint32(at, value, true) : local.setUint16(at, value, true));
    parts.push(new Uint8Array(local.buffer), name, file.data);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true); entry.setUint16(4, 20, true); entry.setUint16(6, 20, true); entry.setUint16(8, 0x0800, true); entry.setUint16(10, 0, true);
    entry.setUint16(12, dosTime, true); entry.setUint16(14, dosDate, true); entry.setUint32(16, crc, true); entry.setUint32(20, file.data.length, true);
    entry.setUint32(24, file.data.length, true); entry.setUint16(28, name.length, true); entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + file.data.length; centralSize += 46 + name.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)], out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  all.reduce((at, piece) => (out.set(piece, at), at + piece.length), 0);
  return out;
}
const csvCell = value => '"' + String(value ?? "").replace(/^[=+@\-]/, "'$&").replaceAll('"', '""') + '"';
async function exportFullTexts(env, state, viewer, manager, body) {
  const ids = [...new Set(Array.isArray(body.pmids) ? body.pmids.map(String) : [])].slice(0, pdfMaxArticles);
  const files = [], rows = [["Folder", "No.", "Source", "PMID", "Title", "DOI", "Full text status", "Full-text source", "Licence", "Source URL", "Access", "Files"]];
  let total = 0;
  // With layout, files go into Molecule/DateRange/ subfolders (an article in two molecules appears in both).
  const folders = new Map();
  if (body.layout === true || body.layout === "country") for (const e of libraryLayout(state, body.layout === "country" ? "country" : "range")) (folders.get(e.pmid) || folders.set(e.pmid, []).get(e.pmid)).push({ prefix:e.folder + "/", tag:libTag(e) + "_" });
  for (const id of ids) {
    const article = state.articles[id];
    if (!article || !state.assignments.some(a => a.pmid === id && (manager || a.reviewer === viewer.email))) continue;
    for (const { prefix, tag } of folders.size ? (folders.get(id) || [{ prefix:"Unfiled/", tag:"" }]) : [{ prefix:"", tag:"" }]) {
      const names = [];
      for (const [key, name] of [[article.fullTextKey, tag + "PMID_" + id + "." + (/\.(\w+)$/.exec(article.fullTextKey || "")?.[1] || "bin")], [article.fullTextTextKey, tag + "PMID_" + id + "_text.txt"]]) {
        if (!key) continue;
        const object = await env.BUCKET.get(key);
        if (!object) continue;
        const data = new Uint8Array(await object.arrayBuffer());
        total += data.length;
        if (total > 150 * 1024 * 1024) throw new Error("Selection too large for one ZIP; export fewer articles.");
        files.push({ name:prefix + name, data }); names.push(name);
      }
      rows.push([prefix.replace(/\/$/, ""), tag.replace(/_$/, ""), articleSource(article), id, article.title, article.doi, article.fullTextStatus || "Pending", article.fullTextOrigin || "", article.fullTextLicense || "", article.fullTextSource || article.fullTextLink || "", article.oaStatus || "", names.join(" ")]);
    }
  }
  if (!files.length) return null;
  files.push({ name:"manifest.csv", data:new TextEncoder().encode(rows.map(r => r.map(csvCell).join(",")).join("\r\n")) });
  if (ids.some(id => state.articles[id]?.fullTextRestricted)) files.push({ name:"NOTICE.txt", data:new TextEncoder().encode("Some documents in this archive are open-access copies under licences that restrict reuse (for example CC BY-NC, publisher terms, or no stated licence). They are included for internal literature screening only. Check the Licence column in manifest.csv and do not redistribute them.\r\n") });
  return zipFiles(files);
}
async function captureScreenshot(env, article) {
  if (env.SCREENSHOT_FN) {
    const shot = await env.SCREENSHOT_FN(article);
    const key = "evidence/" + article.id + "/pubmed.png";
    await env.BUCKET.put(key, shot.bytes, {httpMetadata:{contentType:"image/png"}});
    return { screenshotKey:key, screenshotStatus:"Captured", screenshotKind:shot.kind, screenshotAt:new Date().toISOString() };
  }
  const endpoint = new URL(env.SCREENSHOT_ENDPOINT);
  if (endpoint.protocol !== "https:") throw new Error("Screenshot endpoint must use HTTPS.");
  endpoint.searchParams.set("token",env.SCREENSHOT_TOKEN);
  const response = await fetch(endpoint, {method:"POST",redirect:"error",signal:AbortSignal.timeout(30000),
    headers:{"Content-Type":"application/json"},body:JSON.stringify({url:article.url,options:{fullPage:true,type:"png"}})});
  if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("image/png")) {
    throw new Error("Screenshot service returned HTTP " + response.status);
  }
  const key = "evidence/" + article.id + "/pubmed.png";
  await env.BUCKET.put(key,response.body,{httpMetadata:{contentType:"image/png"}});
  return { screenshotKey:key, screenshotStatus:"Captured", screenshotAt:new Date().toISOString() };
}
async function collectEvidence(baseEnv, ids) {
  const {state} = await load(baseEnv);
  const env = withSettings(baseEnv, state);
  const ime = await loadIme(baseEnv), promotions = state.settings?.imePromotions || [];
  const moleculesOf = id => [...new Set(state.assignments.filter(a => a.pmid === id).flatMap(a => a.molecules || []))];
  const articles = ids ? ids.map(id=>state.articles[id]).filter(Boolean) : Object.values(state.articles);
  const enabled = Boolean(env.SCREENSHOT_FN || (env.SCREENSHOT_ENDPOINT && env.SCREENSHOT_TOKEN));
  const needsFullText = a => !a.fullTextStatus || a.fullTextStatus === "Retry needed" ||
    (Boolean(env.UNPAYWALL_EMAIL) && ["No PMC record","No eligible PMC file"].includes(a.fullTextStatus)) ||
    (!a.fullTextKey && (a.fullTextTier || 0) < fullTextTier) || (Boolean(a.doi) && /^No DOI/.test(a.fullTextStatus || ""));
  // Local captures made before screenshotKind existed may be saved error pages, so they are taken again.
  const needsScreen = a => enabled && a.source !== "Social media" && (!a.screenshotKey || (Boolean(env.SCREENSHOT_FN) && a.screenshotKind !== "record2"));
  // PDFs stored before a text reader was available are read once (pdf.js on the host, or GROBID).
  const needsPdfText = a => Boolean(env.PDF_TEXT_FN || env.GROBID_URL) && Boolean(a.fullTextKey) && /\.pdf$/i.test(a.fullTextKey) && !a.fullTextTextKey && !a.pdfTextTried;
  const needsEnrich = a => !a.enrichedAt || (a.enrichVersion || 0) < 2;
  const needsEntities = a => !a.entitiesCheckedAt;
  const needsLinks = a => !a.linksCheckedAt;
  const needsOa = a => Boolean(env.UNPAYWALL_EMAIL) && (!a.oaCheckedAt || (a.oaStatus === "No DOI" && Boolean(a.doi)) ||
    (!a.oaIsOpen && Date.now() - Date.parse(a.oaCheckedAt) > oaRecheckMs));
  const needsRetraction = a => !a.retractionCheckedAt || (a.retractionStatus === "No DOI to check" && Boolean(a.doi)) || Date.now() - Date.parse(a.retractionCheckedAt) > retractionRecheckMs;
  // Event and country detection reads stored data only, so a batch is done per call, before the slower network work.
  const needsDetect = a => a.eventsKey !== detectKey(a, ime);
  const detectBatch = articles.filter(needsDetect).slice(0, 300);
  if (detectBatch.length) {
    const results = [];
    for (const a of detectBatch) {
      const object = a.fullTextTextKey ? await env.BUCKET.get(a.fullTextTextKey) : null;
      results.push([a.id, applyDetection(a, moleculesOf(a.id), ime, promotions, object ? await object.text() : "")]);
    }
    results.forEach(([id, r]) => Object.assign(state.articles[id], r));
    await write(env, data => results.forEach(([id, r]) => data.articles[id] && Object.assign(data.articles[id], r)));
  }
  const pending = articles.filter(a=>needsFullText(a) || needsScreen(a) || needsRetraction(a) || needsOa(a) || needsEnrich(a) || needsEntities(a) || needsLinks(a) || needsPdfText(a))
    .sort((a,b)=>String(a.evidenceAttempt || "").localeCompare(String(b.evidenceAttempt || ""))).slice(0,4);
  for (let article of pending) {
    const status = {evidenceAttempt:new Date().toISOString()};
    let lookup; // at most one Unpaywall request per article per pass
    const lookupOnce = async () => (lookup ||= await unpaywallLookup(env,article));
    let core;
    const coreOnce = async () => (core ||= { value:await europePmcCore(article).catch(() => null) }).value;
    if (needsEnrich(article)) {
      try { Object.assign(status,await enrichMetadata(env,article,coreOnce)); }
      catch (error) { status.enrichError = error.message; }
    }
    if (status.doi) article = { ...article, doi:status.doi };
    if (needsLinks(article)) {
      try { Object.assign(status,await fetchLinks(env,article)); }
      catch (error) { status.linksError = error.message; }
    }
    if (needsEntities(article)) {
      try { Object.assign(status,await fetchEntities(article)); }
      catch (error) { status.entitiesError = error.message; }
    }
    if (needsFullText(article)) {
      try { Object.assign(status,await captureFullText(env,article,lookupOnce,coreOnce)); status.fullTextTier = fullTextTier; }
      catch (error) { Object.assign(status,{fullTextStatus:"Retry needed",fullTextError:error.message}); }
    }
    if (needsOa(article)) {
      try { Object.assign(status,oaFields(await lookupOnce())); }
      catch (error) { status.oaError = error.message; }
    }
    if (needsRetraction(article)) {
      try { Object.assign(status,await checkRetraction(env,article)); }
      catch (error) { status.retractionError = error.message; }
    }
    if (needsScreen(article)) {
      try { Object.assign(status,await captureScreenshot(env,{...article,...status})); }
      catch { status.screenshotStatus="Retry needed"; }
    }
    if (needsPdfText(article) && !status._text) {
      status.pdfTextTried = new Date().toISOString();
      try { const object = await env.BUCKET.get(article.fullTextKey); if (object) status._text = await pdfToText(env, await object.arrayBuffer()); }
      catch (error) { status.pdfTextError = String(error.message || error).slice(0, 200); }
    }
    if (status._text) {
      const molecules = [...new Set(state.assignments.filter(a => a.pmid === article.id).flatMap(a => a.molecules || []))];
      try {
        const textKey = "evidence/" + article.id + "/fulltext.txt";
        await env.BUCKET.put(textKey, status._text.slice(0, 2_000_000), { httpMetadata:{ contentType:"text/plain; charset=utf-8" } });
        status.fullTextTextKey = textKey;
        status.keyPassages = keyPassages(status._text, molecules);
      } catch { /* best effort */ }
    }
    const capturedText = status._text || "";
    delete status._text;
    Object.assign(status, applyDetection({ ...article, ...status }, moleculesOf(article.id), ime, promotions, capturedText));
    await write(env, data => Object.assign(data.articles[article.id],status));
  }
  if (state.assignments.some(a => !a.reviewer)) await write(env, data => data.assignments.filter(a => !a.reviewer).forEach(a => allocate(data, a)));
  if (state.settings?.autoIcsr !== false) {
    const intake = await write(env, data => icsrIntake(data, "system", () => true, 50));
    if (intake.created.length) await audit(env, { by:"system", action:"case.intake", target:intake.created.length + " cases", detail:{ cases:intake.created.join(", "), source:"automatic, articles with stored full text" } });
  }
  const queued = articles.filter(a=>needsFullText(a) || needsScreen(a) || needsRetraction(a) || needsOa(a) || needsEntities(a) || needsLinks(a) || needsPdfText(a) || needsDetect(a)).length;
  return {processed:pending.length, queued, unattempted:articles.filter(a=>!a.evidenceAttempt).length,
    screenshotConfigured:enabled, unpaywallConfigured:Boolean(env.UNPAYWALL_EMAIL), grobidConfigured:Boolean(env.GROBID_URL)};
}

// ---- Relevance ranking (transparent, rule-based): higher = more likely to need attention in safety screening ----
const severeTerms = ["fatal","death","died","anaphyla","hepatotox","failure","overdose","hospitali","serious","life-threatening","stevens-johnson","toxic epidermal","necrosis"];
const populationTerms = ["pregnan","neonat","infant","child","pediatric","paediatric","elderly","renal impairment","hepatic impairment","breastfeeding","lactation"];
const termLabels = { hospitali:"hospitalisation", anaphyla:"anaphylaxis", hepatotox:"hepatotoxicity", nephrotox:"nephrotoxicity", cardiotox:"cardiotoxicity", neurotox:"neurotoxicity",
  pregnan:"pregnancy", contraindicat:"contraindication", discontinu:"discontinuation", neonat:"neonate", "adverse":"adverse event", pediatric:"paediatric" };
const termLabel = t => termLabels[t] || t;
const termPatterns = new Map();
// Terms match at the start of a word ("hepatotox" matches "hepatotoxicity", but "harm" does not match "pharmacokinetics").
const hasTerm = (text, term) => (termPatterns.get(term) || termPatterns.set(term, new RegExp("\\b" + term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).get(term)).test(text);
const termHitsIn = (text, terms) => { const hits = terms.filter(t => hasTerm(text, t)); return hits.filter(t => !hits.some(o => o !== t && o.startsWith(t))); };
function scoreArticle(article, molecules) {
  const a = article || {}, title = String(a.title || "").toLowerCase();
  // Negated mentions ("no hepatic failure", "without seizures") must not raise the score.
  const abstract = String(a.abstract || "").toLowerCase().replace(/\b(no|not|without|denied|denies|absence of|negative for|free of|never)\b[^.;,]{0,40}/g, " ");
  const names = (molecules || []).map(m => String(m).toLowerCase()).filter(Boolean), why = [];
  let score = 0;
  if (names.some(n => title.includes(n))) { score += 25; why.push("molecule in title"); }
  else if (names.some(n => abstract.includes(n))) { score += 15; why.push("molecule in abstract"); }
  const titleHits = termHitsIn(title, safetyTerms), abstractHits = termHitsIn(abstract, safetyTerms).filter(t => !titleHits.includes(t));
  const safetyPoints = Math.min(titleHits.length * 6, 18) + Math.min(abstractHits.length * 3, 21);
  if (safetyPoints) { score += safetyPoints; why.push("safety terms: " + [...titleHits, ...abstractHits].slice(0, 4).map(termLabel).join(", ")); }
  const severe = termHitsIn(title + " " + abstract, severeTerms);
  if (severe.length) { score += Math.min(severe.length * 5, 15); why.push("serious outcome: " + severe.slice(0, 3).map(termLabel).join(", ")); }
  const types = (a.pubTypes || []).join(" ").toLowerCase();
  if (/case report/.test(types)) { score += 12; why.push("case report"); }
  else if (/randomi[sz]ed|clinical trial/.test(types)) score += 4;
  else if (/meta-analysis|review/.test(types)) score -= 3;
  else if (/editorial|comment|letter|news/.test(types)) { score -= 8; why.push("editorial or letter"); }
  const population = termHitsIn(title + " " + abstract + " " + (a.meshTerms || []).join(" ").toLowerCase(), populationTerms);
  if (population.length) { score += 5; why.push("special population: " + termLabel(population[0])); }
  const imeEvents = (a.events || []).filter(e => e.ime);
  if (imeEvents.length) { score += Math.min(12 + (imeEvents.some(e => e.withDrug) ? 5 : 0), 17); why.push("important medical event: " + imeEvents[0].term); }
  else if ((a.aeMesh || []).length || a.aeIndexed) { score += 6; why.push("indexed as an adverse effect (MeSH)"); }
  const facts = a.caseFacts;
  if (facts?.rechallenge?.result === "Positive") { score += 6; why.push("positive rechallenge"); }
  if (facts?.dechallenge?.result === "Positive") { score += facts.dechallenge.confounded ? 2 : 4; why.push(facts.dechallenge.confounded ? "dechallenge (confounded by treatment)" : "positive dechallenge"); }
  if (facts?.minimum?.verdict === "Valid ICSR candidate") { score += 8; why.push("meets minimum ICSR criteria"); }
  const conditions = (a.entities?.diseases || []).length;
  if (conditions) score += Math.min(conditions, 5) * 1.5;
  const passages = (a.keyPassages || []).length;
  if (passages) { score += Math.min(passages, 4) * 2; why.push(passages + " key passage" + (passages === 1 ? "" : "s")); }
  if (!abstract) { score -= 5; why.push("no abstract yet"); }
  if (["Retracted", "Expression of concern"].includes(a.retractionStatus)) { score += 20; why.push(a.retractionStatus.toLowerCase()); }
  if (a.citedBy > 0) score += Math.min(Math.round(Math.log10(a.citedBy + 1) * 2), 4);
  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, level:score >= 60 ? "High" : score >= 30 ? "Medium" : "Low", why };
}
// The open assignments of one watchlist in a chosen order; positions (1, 2, 3…) are what "assign by number" refers to.
function rankedList(state, portfolio, molecule, order, pool) {
  let list = state.assignments.filter(a => a.portfolio === portfolio && a.status !== "Complete" && (!molecule || (a.molecules || []).includes(molecule)));
  if (pool === "unassigned") list = list.filter(a => !a.reviewer);
  const ranked = list.map(a => ({ a, ...scoreArticle(state.articles[a.pmid], a.molecules) })), num = x => Number(x.a.pmid) || 0;
  ranked.sort(order === "newest" ? (x, y) => num(y) - num(x) : order === "oldest" ? (x, y) => num(x) - num(y) : (x, y) => y.score - x.score || num(y) - num(x));
  return ranked;
}
// ---- Audit trail v2 ----
// Design ported from argus-auditable-rag (MIT, Copyright (c) 2026 Yashwanth Ravva): one hash-chained, append-only chain with contiguous sequence numbers,
// canonical-JSON hashing (sha256(prev_hash + canonical payload)), actor and entity attribution, chain verification that says where and why it breaks,
// and a head record so truncation is detected. Tamper-EVIDENT; the host also refuses non-append writes at the storage layer (server/storage.mjs).
const AUDIT_GENESIS = "0".repeat(64), AUDIT_SCHEMA = 2, AUDIT_HEAD = "audit2/head.json";
const auditMonthKey = month => "audit2/" + month + ".ndjson";
const sha256 = async text => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, "0")).join("");
const sortKeys = v => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v;
// Sorted keys, no whitespace, non-ASCII escaped (Python json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=True)).
const canonicalJson = v => JSON.stringify(sortKeys(v)).replace(/[\u0080-￿]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
const auditPayload = e => canonicalJson({ sequence:e.sequence, occurred_at:e.occurred_at, actor:e.actor, action:e.action, entity_type:e.entity_type, entity_id:e.entity_id, detail:e.detail, schema_version:e.schema_version });
const auditEntryHash = e => sha256(e.prev_hash + auditPayload(e));
const auditActor = by => { const s = String(by || "system"); return s === "system" ? "system:literasift" : s === "anonymous" ? "anonymous" : s.includes("@") ? "user:" + s.toLowerCase() : s.slice(0, 120); };
const entityTypes = { case:"Case", review:"Assignment", "bulk-status":"Assignment", assign:"Assignment", molecule:"Watchlist", pull:"Watchlist", import:"Watchlist", watch:"Watchlist", scheduled:"Watchlist", export:"Export", download:"Article",
  account:"Account", password:"Account", login:"Account", logout:"Account", esign:"Account", settings:"Settings", ime:"Reference data", ma:"Reference data", access:"Settings", profile:"Profile", audit:"AuditLog", sign:"Signature" };
async function audit(env, entry) {
  try {
    const month = new Date().toISOString().slice(0, 7), key = auditMonthKey(month);
    const action = String(entry.action).slice(0, 60), prefix = action.split(".")[0];
    const detail = typeof entry.detail === "object" && entry.detail ? entry.detail : (String(entry.detail ?? "") ? { text:String(entry.detail).slice(0, 600) } : {});
    for (let attempt = 0; attempt < 60; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, Math.random() * Math.min(5 * attempt, 40)));
      const headObject = await env.BUCKET.get(AUDIT_HEAD), head = headObject ? await headObject.json() : null;
      const monthObject = await env.BUCKET.get(key), text = monthObject ? await monthObject.text() : "";
      const lines = text.split("\n").filter(Boolean), last = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
      // The month file is the source of truth; the head can lag by one entry after a crash, and an empty month continues from the previous one.
      const [sequence, prev] = last && (!head || last.sequence >= head.sequence) ? [last.sequence + 1, last.hash] : head ? [head.sequence + 1, head.hash] : [0, AUDIT_GENESIS];
      const e = { sequence, occurred_at:new Date().toISOString(), actor:auditActor(entry.by), action, entity_type:String(entry.entityType || entityTypes[prefix] || "Record").slice(0, 60),
        entity_id:String(entry.entityId ?? entry.target ?? "").slice(0, 300) || "-", detail, schema_version:AUDIT_SCHEMA, prev_hash:prev };
      e.hash = await auditEntryHash(e);
      const saved = await env.BUCKET.put(key, text + JSON.stringify(e) + "\n", { onlyIf:monthObject ? { etagMatches:monthObject.etag } : { etagDoesNotMatch:"*" }, httpMetadata:{ contentType:"application/x-ndjson" } });
      if (!saved) continue;
      for (let h = 0; h < 5; h++) {
        const current = await env.BUCKET.get(AUDIT_HEAD), currentHead = current ? await current.json() : null;
        if (currentHead && currentHead.sequence >= e.sequence) break;
        const months = [...new Set([...(currentHead?.months || []), month])].sort();
        if (await env.BUCKET.put(AUDIT_HEAD, JSON.stringify({ sequence:e.sequence, hash:e.hash, months, count:e.sequence + 1, updated_at:e.occurred_at }), { onlyIf:current ? { etagMatches:current.etag } : { etagDoesNotMatch:"*" }, httpMetadata:{ contentType:"application/json" } })) break;
      }
      return e;
    }
  } catch { /* the audit trail never blocks the action itself */ }
}
const parseAuditLines = text => String(text || "").split("\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } });
// Pure chain check over an ordered list of entries (mirrors verify_entries in Argus): contiguity, linkage, recomputed hash.
async function verifyAuditEntries(entries) {
  let expected = AUDIT_GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) return { ok:false, entries_checked:i, first_broken_sequence:i, reason:"unreadable entry" };
    if (e.sequence !== i) return { ok:false, entries_checked:i, first_broken_sequence:e.sequence, reason:"sequence gap or reorder" };
    if (e.prev_hash !== expected) return { ok:false, entries_checked:i, first_broken_sequence:e.sequence, reason:"broken linkage to predecessor" };
    if (await auditEntryHash(e) !== e.hash) return { ok:false, entries_checked:i, first_broken_sequence:e.sequence, reason:"content does not match stored hash" };
    expected = e.hash;
  }
  return { ok:true, entries_checked:entries.length, first_broken_sequence:null, reason:null };
}
async function verifyAuditChain(env) {
  const headObject = await env.BUCKET.get(AUDIT_HEAD), head = headObject ? await headObject.json() : null, entries = [];
  if (!head) return { ok:true, entries_checked:0, first_broken_sequence:null, reason:null, head:null };
  for (const month of head.months || []) {
    const object = await env.BUCKET.get(auditMonthKey(month));
    if (!object) return { ok:false, entries_checked:entries.length, first_broken_sequence:entries.length, reason:"month file missing: " + month, head };
    entries.push(...parseAuditLines(await object.text()));
  }
  const result = await verifyAuditEntries(entries), last = entries[entries.length - 1];
  if (result.ok && (!last || last.sequence !== head.sequence || last.hash !== head.hash)) return { ...result, ok:false, first_broken_sequence:head.sequence, reason:"head does not match the last entry (entries may have been removed)", head };
  return { ...result, head };
}
// Entries written before v2 (monthly chains with no sequence numbers) stay readable and are verified on their own.
async function readLegacyAudit(env, month) {
  const object = await env.BUCKET.get("audit/" + month + ".ndjson");
  if (!object) return { entries:[], ok:true };
  const hashOf = (prev, e) => sha256([prev, e.at, e.by, e.action, e.target, e.detail].join("|"));
  const entries = []; let ok = true, prev = "GENESIS-" + month;
  for (const e of parseAuditLines(await object.text())) { if (!e) { ok = false; continue; } if (e.prev !== prev || e.hash !== await hashOf(prev, e)) ok = false; prev = e.hash; entries.push({ at:e.at, by:e.by, action:e.action, target:e.target, detail:e.detail, hash:e.hash, legacy:true }); }
  return { entries, ok };
}
const auditDetailText = d => d && typeof d === "object" ? (d.text ?? Object.entries(d).map(([k, v]) => k + ": " + (typeof v === "object" ? JSON.stringify(v) : v)).join("; ")) : String(d ?? "");
async function readAudit(env, month) {
  const object = await env.BUCKET.get(auditMonthKey(month)), raw = parseAuditLines(object ? await object.text() : ""), entries = raw.filter(Boolean);
  // Month-level check: contiguous sequence numbers, linkage and recomputed hashes within this month's file.
  let verified = raw.every(Boolean);
  for (let i = 0; i < entries.length && verified; i++) {
    const e = entries[i];
    if (i && (e.sequence !== entries[i - 1].sequence + 1 || e.prev_hash !== entries[i - 1].hash)) verified = false;
    if (await auditEntryHash(e) !== e.hash) verified = false;
  }
  const legacy = await readLegacyAudit(env, month), verification = await env.BUCKET.get("audit2/verification.json");
  const shown = [...entries.map(e => ({ sequence:e.sequence, at:e.occurred_at, by:e.actor.replace(/^user:/, ""), action:e.action, entityType:e.entity_type, target:e.entity_id, detail:auditDetailText(e.detail), hash:e.hash, legacy:false })), ...legacy.entries].reverse();
  return { month, total:shown.length, verified:verified && legacy.ok, legacyEntries:legacy.entries.length, entries:shown.slice(0, 5000), lastVerification:verification ? await verification.json() : null };
}
// The anchor is the chain head, signed when the host provides a key. Keep copies off the server: a later rewrite of the whole log cannot match them.
async function hmacHex(key, text) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function auditAnchor(env) {
  const head = await (await env.BUCKET.get(AUDIT_HEAD))?.json();
  if (!head) return null;
  const at = new Date().toISOString(), anchor = { sequence:head.sequence, hash:head.hash, anchored_at:at, count:head.count };
  if (env.AUDIT_ANCHOR_KEY) anchor.mac = await hmacHex(env.AUDIT_ANCHOR_KEY, [anchor.sequence, anchor.hash, at].join("|"));
  return anchor;
}
async function checkAnchor(env, anchor) {
  if (!anchor || !Number.isInteger(anchor.sequence) || !/^[0-9a-f]{64}$/.test(anchor.hash || "")) return { ok:false, reason:"That is not an audit anchor file." };
  if (anchor.mac) {
    if (!env.AUDIT_ANCHOR_KEY) return { ok:false, reason:"This server has no anchor key, so the signature cannot be checked." };
    if (await hmacHex(env.AUDIT_ANCHOR_KEY, [anchor.sequence, anchor.hash, anchor.anchored_at].join("|")) !== anchor.mac) return { ok:false, reason:"The anchor's signature does not match: the file was altered or comes from another server." };
  }
  const chain = await verifyAuditChain(env);
  if (!chain.ok) return { ok:false, reason:"The chain itself fails verification (entry " + chain.first_broken_sequence + ": " + chain.reason + "), so it cannot be trusted to match the anchor." };
  const head = await (await env.BUCKET.get(AUDIT_HEAD))?.json();
  if (!head || head.sequence < anchor.sequence) return { ok:false, reason:"The log is shorter than the anchor: entries after it were removed." };
  for (const month of head.months) {
    const entries = parseAuditLines(await (await env.BUCKET.get(auditMonthKey(month)))?.text()).filter(Boolean), hit = entries.find(e => e.sequence === anchor.sequence);
    if (hit) return hit.hash === anchor.hash ? { ok:true, sequence:anchor.sequence, reason:"Entry " + anchor.sequence + " is still in the chain with the same hash; " + (head.sequence - anchor.sequence) + " entries were added since." } : { ok:false, reason:"Entry " + anchor.sequence + " exists but its hash differs from the anchor: the log was rewritten." };
  }
  return { ok:false, reason:"Entry " + anchor.sequence + " was not found in the log." };
}
const decodeWatch = value => { const [portfolio, molecule = ""] = String(value || "").split("|").map(v => { try { return decodeURIComponent(v); } catch { return v; } }); return molecule ? portfolio + " / " + molecule : portfolio; };
const auditRules = {
  "/api/bulk-status":(b, r) => ({ action:"bulk-status", target:(r.updated ?? 0) + " articles", detail:"status " + b.status }),
  "/api/export":b => ({ action:"export.pdf", target:(b.pmids || []).length + " articles", detail:b.title }),
  "/api/export-fulltext":b => ({ action:"export.fulltext-zip", target:(b.pmids || []).length + " articles", detail:b.layout ? "library layout" : "" }),
  "/api/export-citations":b => ({ action:"export.citations", target:(b.pmids || []).length + " articles", detail:b.format }),
  "/api/scheduled":(b, r) => (r.results || []).length ? { action:"scheduled.run", target:"", detail:r.results.length + " batches, " + r.results.filter(x => x.error).length + " failed" } : null,
  "/api/settings":b => ({ action:"settings.update", target:Object.keys(b).join(", "), detail:"storeRestricted" in b ? "storeRestricted=" + b.storeRestricted : "" }),
  "/api/assign-ranges":(b, r) => ({ action:"assign.ranges", target:decodeWatch(b.watch), detail:(b.ranges || []).map(x => "#" + x.from + "-" + x.to + " to " + x.owner).join("; ") + " (" + (b.order || "relevance") + ", " + (b.pool || "open") + "): " + Object.values(r.per || {}).reduce((n, v) => n + v, 0) + " assigned" }),
  "/api/delete-watch":b => ({ action:"watch.delete", target:decodeWatch(b.watch), detail:"" }),
  "/api/assign-molecule":(b, r) => ({ action:"molecule.assign", target:decodeWatch(b.watch), detail:"to " + (b.owner || "auto") + ", " + (r.moved ?? 0) + " articles" + (b.reassign ? " (including reassigned)" : "") }),
  "/api/recheck-access":() => ({ action:"access.recheck", target:"all articles", detail:"" }),
  "/api/profile":b => ({ action:"profile.save", target:b.email, detail:"limit " + b.capacity + ", " + (b.active === false ? "unavailable" : "active") }),
  "/api/watch":b => ({ action:"watch.save", target:(b.molecule ? b.portfolio + " / " + b.molecule : b.portfolio), detail:String(b.query || "").slice(0, 200) }),
  "/api/watches":(b, r) => ({ action:"watch.bulk-save", target:b.portfolio, detail:(r.created ?? 0) + " molecules" + (b.owner ? ", owner " + b.owner : "") }),
  "/api/pull":(b, r) => ({ action:"pull", target:b.molecule, detail:b.from + " to " + b.to + ": " + (r.count ?? 0) + " articles" }),
  "/api/import":(b, r) => ({ action:"import", target:decodeWatch(b.watch), detail:b.from + " to " + b.to + ": " + (r.count ?? 0) + " articles" }),
};
async function api(request, env, path) {
  const copy = request.method === "POST" ? request.clone() : null;
  const response = await apiCore(request, env, path);
  const rule = copy && response.status < 400 && auditRules[path];
  if (rule) {
    try {
      const body = await copy.json().catch(() => ({}));
      const result = response.headers.get("content-type")?.includes("json") ? await response.clone().json().catch(() => ({})) : {};
      const entry = rule(body, result);
      if (entry) await audit(env, { by:request.headers.get("oai-authenticated-user-email")?.toLowerCase() || "system", ...entry });
    } catch { /* ignore */ }
  }
  return response;
}
async function apiCore(request, env, path) {
  const email = request.headers.get("oai-authenticated-user-email")?.toLowerCase();
  const service = env.RUN_TOKEN && request.headers.get("Authorization") === "Bearer " + env.RUN_TOKEN;
  if (!email && !(service && path === "/api/scheduled")) return json({ error:"Sign-in required." }, 401);
  const { state } = await load(env);
  // The owner initializes the first profile while the Site is owner-private.
  if (email && state.profiles.length === 0) {
    await write(env, data => {
      if (!data.profiles.length) data.profiles.push({ email, name:email.split("@")[0], role:"manager", active:true });
    });
    state.profiles = (await load(env)).state.profiles;
  }
  const viewer = state.profiles.find(p => p.email === email && p.active);
  const manager = viewer?.role === "manager";
  if (!viewer && !service) return json({ error:"Your account needs a Literature Bench profile." }, 403);
  if (request.method === "GET" && path === "/api/state") {
    const assignments = state.assignments.filter(a => manager || a.reviewer === email).map(a => ({ ...a, ...scoreArticle(state.articles[a.pmid], a.molecules) }));
    return json({ viewer, library:manager ? libraryLayout(state) : [],
      cases:await Promise.all((state.cases || []).filter(c => manager || c.createdBy === email || c.assignee === email).map(async c => { const a = localAssessment(c.data); return { ...c, signature_intact:await signatureIntact("case", c, state.articles[c.pmid]), assessment:{ valid:a.validity.valid_icsr, missing:a.validity.missing, score:a.qc.score, ready:a.qc.ready_for_medical_review } }; })),
      series:seriesSummary((state.cases || []).filter(c => manager || c.createdBy === email || c.assignee === email)), config:{ retrievalKeys:{ core:Boolean(env.CORE_API_KEY || state.settings?.coreApiKey), wiley:Boolean(env.WILEY_TDM_TOKEN || state.settings?.wileyTdmToken), elsevier:Boolean(env.ELSEVIER_API_KEY || state.settings?.elsevierApiKey), elsevierInst:Boolean(env.ELSEVIER_INSTTOKEN || state.settings?.elsevierInsttoken) }, sender:{ org:state.settings?.senderOrg || "", name:state.settings?.senderName || "", email:state.settings?.senderEmail || "", phone:state.settings?.senderPhone || "", country:state.settings?.senderCountry || "", type:state.settings?.senderType || "" }, whoUmc:WHO_UMC, ageGroups:AGE_GROUPS, proxyPrefix:state.settings?.proxyPrefix || "", autoIcsr:state.settings?.autoIcsr !== false, autoAssignCases:state.settings?.autoAssignCases !== false, e2b:{ sender:state.settings?.senderId || "", receiver:state.settings?.receiverId || "" }, esign:{ approvers:state.settings?.esignApprovers || "manager", fourEyes:state.settings?.esignFourEyes === true, reauth:Boolean(env.HOST_ACCOUNTS) }, ime:await loadIme(env).then(v => v?.info?.count ? { loaded:true, ...v.info } : { loaded:false }), imePromotions:manager ? state.settings?.imePromotions || [] : [], ma:state.settings?.marketAuth || [], countries:COUNTRIES.map(c => c[0]), caseStatuses, pvNexus:{ url:manager ? state.settings?.pvNexusUrl || "" : "", urlFromEnv:Boolean(env.PV_NEXUS_URL), tokenSet:Boolean(env.PV_NEXUS_TOKEN || state.settings?.pvNexusToken), configured:Boolean(env.PV_NEXUS_URL || state.settings?.pvNexusUrl) }, ncbi:{ email:state.settings?.ncbiEmail || "", emailFromEnv:Boolean(env.NCBI_EMAIL), keySet:Boolean(env.NCBI_API_KEY || state.settings?.ncbiApiKey), keyFromEnv:Boolean(env.NCBI_API_KEY) }, sources:sourceRegistry, libraryPath:env.LIBRARY_PATH || "", storeRestricted:state.settings?.storeRestricted !== false, grobid:Boolean(env.GROBID_URL), terms:safetyTerms, accounts:Boolean(env.HOST_ACCOUNTS), screenshots:Boolean(env.SCREENSHOT_FN || (env.SCREENSHOT_ENDPOINT && env.SCREENSHOT_TOKEN)), unpaywall:Boolean(env.UNPAYWALL_EMAIL || state.settings?.unpaywallEmail), unpaywallFromEnv:Boolean(env.UNPAYWALL_EMAIL),
      unpaywallEmail:manager ? state.settings?.unpaywallEmail || "" : "" },
      profiles:manager ? state.profiles : [viewer], watches:manager ? state.watches : [],
      runs:manager ? state.runs : [], assignments,
      articles:manager ? state.articles : Object.fromEntries(assignments.map(a => [a.pmid, state.articles[a.pmid]])) });
  }
  if (request.method === "GET" && (path.startsWith("/api/full-text/") || path.startsWith("/api/screenshot/"))) {
    const id = path.split("/").pop();
    const article = state.articles[id];
    const key = path.startsWith("/api/screenshot/") ? article?.screenshotKey : article?.fullTextKey;
    if ((!manager && !state.assignments.some(a=>a.pmid===id && a.reviewer===email)) || !key) return json({error:"File unavailable."},404);
    const object = await env.BUCKET.get(key);
    if (!object) return json({error:"File unavailable."},404);
    await audit(env, { by:email, action:path.startsWith("/api/screenshot/") ? "download.snapshot" : "download.fulltext", target:"PMID " + id, detail:article?.fullTextOrigin || "" });
    const headers = new Headers({"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff",
      "Content-Disposition":'attachment; filename="'+key.split("/").pop()+'"'});
    object.writeHttpMetadata(headers);
    return new Response(object.body,{headers});
  }
  if (request.method !== "POST") return json({ error:"Route unavailable." }, 404);
  const body = await request.json().catch(() => ({}));
  if (path === "/api/bulk-status" && viewer) {
    if (!["Pending","In review","Complete","Full text needed"].includes(body.status)) return json({error:"Invalid status."},400);
    const ids = new Set(Array.isArray(body.ids) ? body.ids.map(String).slice(0, 5000) : []);
    const updated = await write(env, data => {
      let count = 0;
      for (const a of data.assignments) {
        if (!ids.has(a.pmid) || (!manager && a.reviewer !== email) || a.status === "Complete" || a.status === body.status || activeSignature(a)) continue;
        a.status = body.status; count++;
        (a.history ||= []).push({ status:a.status, note:"Bulk update", by:email, at:new Date().toISOString() });
      }
      return count;
    });
    return json({ ok:true, updated });
  }
  if (path === "/api/review" && viewer) {
    if (!["Pending","In review","Complete","Full text needed"].includes(body.status)) return json({error:"Invalid status."},400);
    const reviewed = await write(env, data => {
      const item = data.assignments.find(a => a.id === body.id && (manager || a.reviewer === email));
      if (!item) throw new Error("Assignment unavailable.");
      if (activeSignature(item)) throw new Error("This decision is signed. A manager must supersede the signature before it can change.");
      const before = item.status;
      item.status = body.status;
      item.note = String(body.note || "").slice(0, 4000);
      (item.history ||= []).push({ status:item.status, note:item.note, by:email, at:new Date().toISOString() });
      return { pmid:item.pmid, before };
    });
    await audit(env, { by:email, action:"review", target:"PMID " + reviewed.pmid, detail:reviewed.before + " → " + body.status + (body.note ? " (note saved)" : "") });
    return json({ ok:true });
  }
  if (path === "/api/fulltext-upload" && viewer) {
    // For articles behind a paywall: the user supplies the full text from their own licensed access (library, publisher site, author), as a PDF, an XML file, or pasted text.
    const id = String(body.pmid || ""), item = state.assignments.find(a => a.pmid === id && (manager || a.reviewer === email)), article = item && state.articles[id];
    if (!article) return json({ error:"Article not found in your queue." }, 404);
    let bytes = null, text = "", ext = "txt", type = "text/plain; charset=utf-8";
    if (body.base64) {
      try { bytes = Uint8Array.from(atob(String(body.base64)), ch => ch.charCodeAt(0)); } catch { return json({ error:"That file could not be read." }, 400); }
      if (bytes.length > 25_000_000) return json({ error:"That file is larger than 25 MB." }, 413);
      const head = new TextDecoder().decode(bytes.slice(0, 600));
      if (head.startsWith("%PDF-")) { ext = "pdf"; type = "application/pdf"; try { text = await pdfToText(env, bytes.buffer); } catch { /* the PDF is kept even if its text cannot be read */ } }
      else if (/<article\b|<\?xml/.test(head)) { ext = "xml"; type = "application/xml"; text = xmlToText(new TextDecoder().decode(bytes)); }
      else return json({ error:"Upload a PDF or an XML file, or paste the text instead." }, 400);
    } else if (String(body.text || "").trim().length >= 200) { text = String(body.text).slice(0, 2_000_000); bytes = new TextEncoder().encode(text); }
    else return json({ error:"Choose a PDF or XML file, or paste at least a few paragraphs of the article." }, 400);
    const key = "evidence/" + id + "/uploaded." + ext;
    await env.BUCKET.put(key, bytes, { httpMetadata:{ contentType:type } });
    const molecules = [...new Set(state.assignments.filter(a => a.pmid === id).flatMap(a => a.molecules || []))], ime = await loadIme(env);
    const status = { fullTextStatus:"Captured", fullTextKey:key, fullTextOrigin:"Uploaded", fullTextUploadedBy:email, fullTextLicense:"Supplied by the user: check your licence before sharing", fullTextSource:"", fullTextRestricted:true, fullTextTier:fullTextTier };
    if (text) {
      const textKey = "evidence/" + id + "/fulltext.txt";
      await env.BUCKET.put(textKey, text.slice(0, 2_000_000), { httpMetadata:{ contentType:"text/plain; charset=utf-8" } });
      Object.assign(status, { fullTextTextKey:textKey, keyPassages:keyPassages(text, molecules) });
    }
    Object.assign(status, applyDetection({ ...article, ...status }, molecules, ime, state.settings?.imePromotions || [], text));
    await write(env, data => Object.assign(data.articles[id], status));
    await audit(env, { by:email, action:"upload.fulltext", target:"PMID " + id, detail:{ type:ext, bytes:bytes.length, text_read:Boolean(text) } });
    return json({ ok:true, textRead:Boolean(text), events:(status.events || []).length });
  }
  if (path === "/api/icsr-intake" && viewer) {
    const result = await write(env, data => icsrIntake(data, email, a => manager || a.reviewer === email, 1000, manager ? "" : email));
    if (result.created.length) await audit(env, { by:email, action:"case.intake", target:result.created.length + " cases", detail:{ cases:result.created.slice(0, 50).join(", "), source:"articles with stored full text" } });
    return json(result);
  }
  if ((path === "/api/sign-preview" || path === "/api/sign" || path === "/api/supersede") && viewer) {
    const kind = body.kind === "screening" ? "screening" : "case";
    const record = kind === "case" ? (state.cases || []).find(c => c.id === body.id && (manager || c.createdBy === email || c.assignee === email)) : state.assignments.find(a => a.id === body.id && (manager || a.reviewer === email));
    if (!record) return json({ error:"Record not found." }, 404);
    const article = state.articles[record.pmid] || {};
    if (path === "/api/supersede") {
      if (!manager) return json({ error:"Manager access required." }, 403);
      const reason = String(body.reason || "").trim();
      if (reason.length < 10) return json({ error:"Give a reason of at least 10 characters. Signatures are never deleted; they are superseded and kept." }, 400);
      if (!activeSignature(record)) return json({ error:"There is no active signature to supersede." }, 409);
      await write(env, data => {
        const target = kind === "case" ? data.cases.find(c => c.id === record.id) : data.assignments.find(a => a.id === record.id), at = new Date().toISOString();
        activeSignature(target).superseded = { at, by:email, reason:reason.slice(0, 500) };
        if (kind === "case") { target.locked = false; target.status = "Draft"; } else target.status = "In review";
        (target.history ||= []).push({ at, by:email, action:"signature superseded: " + reason.slice(0, 200) });
      });
      await audit(env, { by:email, action:"sign.superseded", entityType:kind === "case" ? "Case" : "Assignment", entityId:kind === "case" ? record.number : record.id, detail:{ reason:reason.slice(0, 500) } });
      return json({ ok:true });
    }
    const meaningCode = kind === "screening" ? "screening" : body.meaning === "case_invalid" ? "case_invalid" : "case_approve", meaning = SIGN_MEANINGS[meaningCode];
    const { content_sha256, evidence_sha256 } = await signContent(kind, record, article, meaningCode), problems = signPolicyProblems(state, kind, record, meaning, viewer, manager);
    if (path === "/api/sign-preview") return json({ kind, meaning:meaningCode, meanings:kind === "case" ? ["case_approve", "case_invalid"].map(code => ({ code, label:SIGN_MEANINGS[code].label, statement:SIGN_MEANINGS[code].statement })) : [{ code:"screening", label:meaning.label, statement:meaning.statement }],
      statement:meaning.statement, content_sha256, evidence_sha256, signer:{ id:email, name:viewer.name, role:viewer.role }, reauth:Boolean(env.HOST_ACCOUNTS), problems, signatures:record.signatures || [], intact:await signatureIntact(kind, record, article), manager });
    if (problems.length) return json({ error:problems[0] }, 409);
    // Review binding: you can only sign what you actually fetched. Anything that changed since the preview is refused.
    if (body.expected_content_sha256 !== content_sha256) return json({ error:"The record changed since you opened it. Reload it and review it again before signing." }, 409);
    if (body.reviewed_evidence_sha256 !== evidence_sha256) return json({ error:"The article evidence changed since you reviewed it. Review it again before signing." }, 409);
    const reauth = !env.HOST_ACCOUNTS ? "session only (no password re-entry on this host)" : request.headers.get("x-esign-reauth") === "1" ? "password re-entry" : "";
    if (!reauth) return json({ error:"Confirm your password to sign." }, 401);
    const signature = { id:crypto.randomUUID(), signer_id:email, signer_name:viewer.name, meaning:meaningCode, meaning_text:meaning.statement, signed_at:new Date().toISOString(), content_sha256, evidence_sha256, auth:reauth, superseded:null };
    const saved = await write(env, data => {
      const target = kind === "case" ? data.cases.find(c => c.id === record.id) : data.assignments.find(a => a.id === record.id);
      if (activeSignature(target)) throw new Error("Already signed.");
      (target.signatures ||= []).push(signature);
      target.status = meaning.status;
      if (kind === "case") target.locked = true;
      (target.history ||= []).push({ at:signature.signed_at, by:email, action:"signed: " + meaning.label });
      return target;
    });
    await audit(env, { by:email, action:"sign.signed", entityType:kind === "case" ? "Case" : "Assignment", entityId:kind === "case" ? record.number : record.id, detail:{ meaning:meaningCode, content_sha256, evidence_sha256, auth:reauth, pmid:record.pmid } });
    return json({ signature, record:saved });
  }
  if (path === "/api/cases-export" && viewer) {
    const wanted = Array.isArray(body.ids) ? new Set(body.ids.map(String)) : null, list = (state.cases || []).filter(c => (manager || c.createdBy === email || c.assignee === email) && (!wanted || wanted.has(c.id)));
    if (!list.length) return json({ error:"No cases to export." }, 404);
    const format = body.format === "e2b" ? "e2b" : "csv", stamp = new Date().toISOString().slice(0, 10);
    await audit(env, { by:email, action:"case.export", target:list.length + " cases", detail:"batch " + format });
    if (format === "e2b") return new Response(e2bBatch(list, state.articles, { sender:state.settings?.senderId, receiver:state.settings?.receiverId }), { headers:{ "Content-Type":"application/xml", "Cache-Control":"private, no-store", "Content-Disposition":'attachment; filename="literasift-E2B-R3-' + stamp + '.xml"' } });
    return new Response(lineListing(list, state.articles), { headers:{ "Content-Type":"text/csv; charset=utf-8", "Cache-Control":"private, no-store", "Content-Disposition":'attachment; filename="literasift-line-listing-' + stamp + '.csv"' } });
  }
  if (path === "/api/library-delete" && viewer) {
    if (!manager) return json({ error:"Manager access required." }, 403);
    const reason = String(body.reason || "").trim();
    if (reason.length < 5) return json({ error:"Give a reason of at least 5 characters. It is recorded in the audit trail." }, 400);
    const wanted = [...new Set((Array.isArray(body.pmids) ? body.pmids : []).map(String))].filter(id => state.articles[id]).slice(0, 2000);
    if (!wanted.length) return json({ error:"Nothing to delete." }, 400);
    // Articles behind a case are kept: a case, its signatures and its audit trail refer to the source article.
    const withCase = new Set((state.cases || []).map(c => c.pmid)), blocked = wanted.filter(id => withCase.has(id)), doomed = wanted.filter(id => !withCase.has(id));
    const names = ["pubmed.png", "fulltext.txt", "pmc.pdf", "pmc.xml", "europepmc.xml", "unpaywall.pdf", "wiley.pdf", "elsevier.xml", "core.pdf", "core.txt", "rxiv.xml", "preprint.xml", "uploaded.pdf", "uploaded.xml", "uploaded.txt"];
    const files = new Set();
    for (const id of doomed) { const a = state.articles[id]; for (const key of [a.fullTextKey, a.fullTextTextKey, a.screenshotKey]) if (key) files.add(key); for (const name of names) files.add("evidence/" + id + "/" + name); }
    if (typeof env.BUCKET.delete === "function") for (const key of files) { try { await env.BUCKET.delete(key); } catch { /* an object that is already gone is fine */ } }
    const titles = doomed.slice(0, 20).map(id => id + ": " + String(state.articles[id].title || "").slice(0, 80));
    if (doomed.length) {
      const gone = new Set(doomed);
      await write(env, data => {
        for (const id of gone) delete data.articles[id];
        data.assignments = data.assignments.filter(a => !gone.has(a.pmid));
        for (const run of data.runs || []) if ((run.ids || []).some(id => gone.has(id))) { run.ids = run.ids.filter(id => !gone.has(id)); run.count = run.ids.length; }
      });
      await audit(env, { by:email, action:"library.deleted", entityType:"Library", entityId:doomed.length + " article" + (doomed.length === 1 ? "" : "s"), detail:{ reason, pmids:doomed.slice(0, 200).join(", "), titles:titles.join(" | "), files_removed:files.size, kept_because_of_cases:blocked.length } });
    }
    return json({ ok:true, deleted:doomed.length, kept:blocked });
  }
  if ((path === "/api/memory-list" || path === "/api/memory-delete") && viewer) {
    if (!manager) return json({ error:"Manager access required." }, 403);
    const entries = memoryEntries(state);
    if (path === "/api/memory-list") return json({ count:entries.length, clearedAt:state.codingMemory?.clearedAt || "", entries:entries.slice(0, 300).map(({ key, case:number, verbatim, pt, pt_code, soc, version, at }) => ({ key, case:number, verbatim, pt, pt_code, soc, version, at })) });
    const reason = String(body.reason || "").trim().slice(0, 300);
    if (body.all === true) {
      if (!entries.length) return json({ ok:true, deleted:0 });
      const at = new Date().toISOString();
      await write(env, data => { data.codingMemory = { clearedAt:at, removed:[] }; });
      await audit(env, { by:email, action:"memory.cleared", entityType:"Coding memory", entityId:"all", detail:{ entries:entries.length, reason, note:"Cases were not changed." } });
      return json({ ok:true, deleted:entries.length });
    }
    const key = String(body.key || ""), entry = entries.find(x => x.key === key);
    if (!entry) return json({ error:"That entry is no longer in the memory." }, 404);
    await write(env, data => { const m = data.codingMemory ||= { clearedAt:"", removed:[] }; if (!m.removed.includes(key)) m.removed.push(key); m.removed = m.removed.slice(-5000); });
    await audit(env, { by:email, action:"memory.removed", entityType:"Coding memory", entityId:entry.case, detail:{ verbatim:entry.verbatim, pt:entry.pt, reason } });
    return json({ ok:true, deleted:1 });
  }
  if ((path === "/api/case-assign" || path === "/api/cases-autoassign") && viewer) {
    if (!manager) return json({ error:"Manager access required." }, 403);
    const target = String(body.assignee || "").trim().toLowerCase(), at = new Date().toISOString();
    if (path === "/api/case-assign" && target && !state.profiles.some(p => p.email === target && p.active)) return json({ error:"Choose an active team member." }, 400);
    const ids = new Set((Array.isArray(body.ids) ? body.ids : []).map(String)), moved = [];
    await write(env, data => {
      for (const c of data.cases || []) {
        if (path === "/api/case-assign" ? !ids.has(c.id) || c.assignee === target : c.assignee || caseClosed(c)) continue;
        if (c.locked) continue;
        const next = path === "/api/case-assign" ? target : pickCaseAssignee(data, c);
        if (!next && path === "/api/cases-autoassign") continue;
        c.assignee = next || undefined; c.assignedAt = next ? at : undefined; refreshDue(data, c);
        (c.history ||= []).push({ at, by:email, action:next ? "assigned to " + next : "unassigned" });
        moved.push(c.number + " -> " + (next || "nobody"));
      }
    });
    if (moved.length) await audit(env, { by:email, action:"case.assign", target:moved.length + " cases", detail:{ changes:moved.slice(0, 50).join("; ") } });
    return json({ ok:true, moved:moved.length });
  }
  if (path.startsWith("/api/case-") && viewer) {
    const cfg = withSettings(env, state), canSee = c => manager || c.createdBy === email || c.assignee === email, find = id => (state.cases || []).find(c => c.id === id && canSee(c));
    if (path === "/api/case-create") {
      const item = state.assignments.find(a => a.pmid === String(body.pmid) && (manager || a.reviewer === email)), article = item && state.articles[item.pmid];
      if (!article) return json({ error:"Article not found in your queue." }, 404);
      const record = await write(env, data => makeCase(data, article, item, email, "manual", manager ? "" : email));
      await audit(env, { by:email, action:"case.create", target:record.number, detail:"from PMID " + record.pmid });
      return json({ case:record, assessment:withRegulatory(await assessCase(cfg, record.data), state, record) });
    }
    const current = find(String(body.id || ""));
    if (!current) return json({ error:"Case not found." }, 404);
    if (path === "/api/case-coding") {
      // Event picker: the EMA IME list gives a PT and SOC for known terms; earlier reviewed codings in your own cases are offered as hints, as in PV Nexus. Always confirm in a licensed MedDRA source.
      const verbatim = String(body.verbatim || "").trim().slice(0, 200);
      if (!verbatim) return json({ ime:[], memory:[] });
      const ime = await loadIme(env), tokens = t => new Set(imeNorm(t).split(" ").filter(Boolean)), want = tokens(verbatim);
      const hits = ime ? detectEvents({ title:"", abstract:verbatim }, [], ime, state.settings?.imePromotions || [], []).filter(e => e.ime).map(e => ({ term:e.term, code:e.ime.code || "", soc:e.ime.soc || "", provenance:e.ime.provenance })) : [];
      const memory = [];
      for (const entry of memoryEntries(state)) {
        if (entry.caseId === current.id || !canSee({ createdBy:entry.createdBy, assignee:entry.assignee })) continue;
        const have = tokens(entry.verbatim), common = [...want].filter(t => have.has(t)).length;
        const score = imeNorm(entry.verbatim) === imeNorm(verbatim) ? 1 : want.size && have.size ? common / Math.max(want.size, have.size) : 0;
        if (score >= 0.25) memory.push({ verbatim:entry.verbatim, llt:entry.llt, pt:entry.pt, pt_code:entry.pt_code, hlt:entry.hlt, hlgt:entry.hlgt, soc:entry.soc, version:entry.version, score:Number(score.toFixed(2)), case:entry.case });
      }
      return json({ ime:hits, memory:memory.sort((a, b) => b.score - a.score).slice(0, 5) });
    }
    if (path === "/api/case-assess") return json({ assessment:withRegulatory(await assessCase(cfg, body.data || current.data), state, { data:normalizeCase(body.data || current.data), molecule:current.molecule }) });
    if (path === "/api/case-save") {
      if (current.locked) return json({ error:"This case is signed and locked. A manager must supersede the signature before it can be edited." }, 409);
      const data = normalizeCase(body.data || current.data), status = caseStatuses.includes(body.status) ? body.status : current.status, notes = String(body.notes ?? current.notes).slice(0, 4000);
      const local = localAssessment(data);
      if (status === "Ready for medical review" && !local.qc.ready_for_medical_review) return json({ error:"Not ready for medical review yet. " + (local.validity.missing.length ? "Missing: " + local.validity.missing.join(", ") + ". " : "") + local.qc.findings.filter(f => f.severity === "major" || f.severity === "critical").slice(0, 4).map(f => f.title).join("; ") + "." }, 400);
      if (status === "Closed: not a valid ICSR" && !notes.trim()) return json({ error:"Add a note explaining why this is not a valid ICSR." }, 400);
      const saved = await write(env, d => {
        const c = d.cases.find(x => x.id === current.id), at = new Date().toISOString();
        const changed = c.status !== status;
        c.data = data; c.notes = notes; c.updatedAt = at; refreshDue(d, c);
        (c.history ||= []).push({ at, by:email, action:changed ? "status " + c.status + " → " + status : "saved" });
        c.status = status;
        return c;
      });
      await audit(env, { by:email, action:"case.save", target:saved.number, detail:"status " + saved.status });
      return json({ case:saved, assessment:withRegulatory(await assessCase(cfg, saved.data), state, saved) });
    }
    if (path === "/api/case-export") {
      const data = { ...current.data, case_id:current.number }, format = ["package", "e2b", "cioms", "fhir", "csv"].includes(body.format) ? body.format : "json", article0 = state.articles[current.pmid] || {};
      await audit(env, { by:email, action:"case.export", target:current.number, detail:format });
      const send = (bytes, type, ext) => new Response(bytes, { headers:{ "Content-Type":type, "Cache-Control":"private, no-store", "Content-Disposition":'attachment; filename="' + current.number + ext + '"' } });
      if (format === "e2b") return send(e2bBatch([current], state.articles, { sender:state.settings?.senderId, receiver:state.settings?.receiverId }), "application/xml", "-E2B-R3.xml");
      if (format === "cioms") return send(ciomsPdf(current, article0), "application/pdf", "-CIOMS-I.pdf");
      if (format === "fhir") return send(JSON.stringify(fhirBundle(current, article0), null, 2), "application/fhir+json", "-FHIR.json");
      if (format === "csv") return send(lineListing([current], state.articles), "text/csv; charset=utf-8", "-line-listing.csv");
      if (format !== "package") return new Response(JSON.stringify(data, null, 2), { headers:{ "Content-Type":"application/json", "Cache-Control":"private, no-store", "Content-Disposition":'attachment; filename="' + current.number + '.json"' } });
      const encoder = new TextEncoder(), article = state.articles[current.pmid] || {}, files = [{ name:"icsr.json", data:encoder.encode(JSON.stringify(data, null, 2)) },
        { name:"assessment.json", data:encoder.encode(JSON.stringify(withRegulatory(await assessCase(cfg, current.data), state, current), null, 2)) },
        { name:"E2B-R3.xml", data:encoder.encode(e2bBatch([current], state.articles, { sender:state.settings?.senderId, receiver:state.settings?.receiverId })) },
        { name:"CIOMS-I.pdf", data:ciomsPdf(current, article) },
        { name:"FHIR-AdverseEvent.json", data:encoder.encode(JSON.stringify(fhirBundle(current, article), null, 2)) },
        { name:"narrative.txt", data:encoder.encode(caseNarrativeText(normalizeCase(current.data), "") + "\r\n") },
        { name:"signatures.json", data:encoder.encode(JSON.stringify(current.signatures || [], null, 2)) },
        { name:"SIGNATURES.txt", data:encoder.encode((current.signatures || []).length ? (current.signatures || []).map(signatureText).join("\r\n") : "Not signed.\r\n") },
        { name:"citation.txt", data:encoder.encode(current.data.source_summary + "\r\n\r\nCase " + current.number + " · status " + current.status + "\r\nNotes: " + (current.notes || "") + "\r\n") }];
      for (const [key, name] of [[article.fullTextKey, "source_PMID_" + current.pmid + "." + (/\.(\w+)$/.exec(article.fullTextKey || "")?.[1] || "bin")], [article.fullTextTextKey, "source_PMID_" + current.pmid + "_text.txt"]]) {
        const object = key && await env.BUCKET.get(key);
        if (object) files.push({ name, data:new Uint8Array(await object.arrayBuffer()) });
      }
      return new Response(zipFiles(files), { headers:{ "Content-Type":"application/zip", "Cache-Control":"private, no-store", "Content-Disposition":'attachment; filename="' + current.number + '-package.zip"' } });
    }
    if (path === "/api/case-delete") {
      if (!manager) return json({ error:"Manager access required." }, 403);
      if ((current.signatures || []).length) return json({ error:"Signed cases cannot be deleted. Supersede the signature and close the case instead." }, 409);
      await write(env, d => { d.cases = d.cases.filter(c => c.id !== current.id); });
      await audit(env, { by:email, action:"case.delete", target:current.number, detail:"" });
      return json({ ok:true });
    }
    return json({ error:"Route unavailable." }, 404);
  }
  if (path === "/api/export-citations" && viewer) {
    const ids = [...new Set(Array.isArray(body.pmids) ? body.pmids.map(String) : [])].slice(0, 500);
    const articles = ids.map(id => state.articles[id]).filter(a => a && state.assignments.some(x => x.pmid === a.id && (manager || x.reviewer === email)));
    if (!articles.length) return json({ error:"No exportable articles in the selection." }, 400);
    const format = body.format === "bibtex" ? "bibtex" : "ris";
    return new Response(citationFile(articles, format, id => state.assignments.find(x => x.pmid === id)), { headers:{ "Content-Type":"text/plain; charset=utf-8", "Cache-Control":"private, no-store", "X-Content-Type-Options":"nosniff",
      "Content-Disposition":'attachment; filename="literasift-' + day() + (format === "bibtex" ? ".bib" : ".ris") + '"' } });
  }
  if (path === "/api/export-fulltext" && viewer) {
    const zip = await exportFullTexts(env, state, viewer, manager, body);
    if (!zip) return json({ error:"No stored full texts in this selection yet." }, 400);
    return new Response(zip, { headers:{ "Content-Type":"application/zip", "Cache-Control":"private, no-store", "X-Content-Type-Options":"nosniff",
      "Content-Disposition":'attachment; filename="literasift-fulltext-' + day() + '.zip"' } });
  }
  if (path === "/api/export" && viewer) {
    const pdf = await exportPdf(env, state, viewer, manager, body);
    if (!pdf) return json({ error:"No exportable articles in the selection." }, 400);
    return new Response(pdf, { headers:{ "Content-Type":"application/pdf", "Cache-Control":"private, no-store", "X-Content-Type-Options":"nosniff",
      "Content-Disposition":'attachment; filename="literasift-' + day() + '.pdf"' } });
  }
  if (path === "/api/scheduled" && (service || manager)) {
    const results = [];
    const to = new Date(Date.parse(day()) - 86400000).toISOString().slice(0,10);
    const same = watch => r => r.portfolio === watch.portfolio && (r.molecule || "") === (watch.molecule || "") && (r.mode || "monitor") === "monitor";
    const okRun = r => r.status === "Imported" && (!r.coverage || ["reconciled", "zero_results"].includes(r.coverage));
    // Unfinished imports resume first, from the window where they stopped. Then watchlists never attempted go first, then the least recently attempted.
    const unfinished = state.runs.filter(r => r.windows?.some(w => w.state === "pending" || w.state === "running" || (w.state === "failed" && w.attempts < 8))).slice(0, 3);
    for (const run of unfinished) { try { results.push(await runImport(env, run.id)); } catch (error) { results.push({ portfolio:run.portfolio, molecule:run.molecule, error:error.message }); } }
    const due = state.watches.map(watch => ({ watch, previous:state.runs.find(r => same(watch)(r) && okRun(r)),
        attempt:state.runs.find(same(watch))?.time || "" }))
      .filter(({ previous }) => !(previous?.to >= to)).sort((a, b) => a.attempt.localeCompare(b.attempt));
    for (const { watch, previous } of due.slice(0, maxWatchesPerRun)) {
      try { results.push(await execute(env, watch, previous?.to || to, to, { mode:"monitor" })); }
      catch (error) { results.push({ portfolio:watch.portfolio, molecule:watch.molecule || "", error:error.message }); }
    }
    return json({ results, remaining:Math.max(0, due.length - maxWatchesPerRun), evidence:await collectEvidence(env) });
  }
  if (!manager) return json({ error:"Manager access required." },403);
  if (path === "/api/settings") {
    const email = String(body.unpaywallEmail ?? "").trim();
    if ("pvNexusUrl" in body && body.pvNexusUrl && !/^https?:\/\/[^\s/]+(\/\S*)?$/.test(String(body.pvNexusUrl).trim())) return json({error:"Enter the PV Nexus API address, like https://pv-nexus.example.com"},400);
    if (typeof body.pvNexusToken === "string" && body.pvNexusToken.length > 300) return json({error:"That token is too long."},400);
    if ("ncbiEmail" in body && body.ncbiEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(body.ncbiEmail).trim())) return json({error:"Enter a valid contact email for NCBI."},400);
    for (const key of ["coreApiKey", "wileyTdmToken", "elsevierApiKey", "elsevierInsttoken"]) if (typeof body[key] === "string" && body[key].trim() && !/^[A-Za-z0-9._\-]{16,300}$/.test(body[key].trim())) return json({ error:"That does not look like a valid key or token." }, 400);
    if (typeof body.ncbiApiKey === "string" && body.ncbiApiKey.trim() && !/^[A-Za-z0-9]{20,64}$/.test(body.ncbiApiKey.trim())) return json({error:"That does not look like an NCBI API key (letters and digits only)."},400);
    if ("unpaywallEmail" in body && email && (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200)) return json({error:"Enter a valid contact email for Unpaywall."},400);
    await write(env, data => {
      const settings = data.settings ||= {};
      if ("unpaywallEmail" in body) settings.unpaywallEmail = email;
      if ("ncbiEmail" in body) settings.ncbiEmail = String(body.ncbiEmail || "").trim();
      if (body.esignApprovers === "manager" || body.esignApprovers === "any") settings.esignApprovers = body.esignApprovers;
      for (const [key, max] of [["senderOrg", 200], ["senderName", 120], ["senderEmail", 200], ["senderPhone", 60], ["senderCountry", 80], ["senderType", 60]]) if (key in body) settings[key] = String(body[key] || "").trim().slice(0, max);
      if ("proxyPrefix" in body) settings.proxyPrefix = /^https:\/\/\S+$/.test(String(body.proxyPrefix || "").trim()) ? String(body.proxyPrefix).trim().slice(0, 300) : "";
      if ("autoAssignCases" in body) settings.autoAssignCases = body.autoAssignCases !== "off" && body.autoAssignCases !== false;
      if ("senderId" in body) settings.senderId = String(body.senderId || "").trim().slice(0, 60);
      if ("receiverId" in body) settings.receiverId = String(body.receiverId || "").trim().slice(0, 60);
      if ("autoIcsr" in body) settings.autoIcsr = body.autoIcsr !== "off" && body.autoIcsr !== false;
      if ("esignFourEyes" in body) settings.esignFourEyes = body.esignFourEyes === true;
      if ("pvNexusUrl" in body) settings.pvNexusUrl = String(body.pvNexusUrl || "").trim();
      if (body.pvNexusToken === null) delete settings.pvNexusToken;
      else if (typeof body.pvNexusToken === "string" && body.pvNexusToken.trim()) settings.pvNexusToken = body.pvNexusToken.trim();
      for (const key of ["coreApiKey", "wileyTdmToken", "elsevierApiKey", "elsevierInsttoken"]) { if (body[key] === null) delete settings[key]; else if (typeof body[key] === "string" && body[key].trim()) settings[key] = body[key].trim(); }
      if (body.ncbiApiKey === null) delete settings.ncbiApiKey;
      else if (typeof body.ncbiApiKey === "string" && body.ncbiApiKey.trim()) settings.ncbiApiKey = body.ncbiApiKey.trim();
      if ("storeRestricted" in body) {
        const turnedOn = body.storeRestricted === true && settings.storeRestricted === false;
        settings.storeRestricted = body.storeRestricted === true;
        // Articles that only had a link (or no eligible copy) are tried again under the wider rule.
        if (turnedOn) for (const a of Object.values(data.articles)) if (/^(Open access link only|No eligible PMC file|No PMC record|No downloadable open-access copy)$/.test(a.fullTextStatus || "")) { delete a.fullTextStatus; delete a.evidenceAttempt; }
      }
    });
    return json({ ok:true });
  }
  if (path === "/api/ime-upload") {
    let parsed;
    try { parsed = body.base64 ? parseImeWorkbook(await readXlsx(Uint8Array.from(atob(String(body.base64)), c => c.charCodeAt(0)).buffer)) : parseImeUpload(body.text); buildIme(parsed); } catch (error) { return json({ error:"Could not read that list: " + error.message }, 400); }
    const stored = { title:parsed.title || "Important medical event terms (uploaded)", version:parsed.version || "", reference:parsed.reference || "", released:parsed.released || null, source:"uploaded " + String(body.filename || "").slice(0, 80), terms:parsed.terms, demoted:parsed.demoted || [] };
    await env.BUCKET.put("ime/current.json", JSON.stringify(stored), { httpMetadata:{ contentType:"application/json" } });
    imeInvalidate();
    const info = buildIme(stored).info;
    await audit(env, { by:email, action:"ime.upload", target:info.label, detail:info.count + " terms" + (info.reference ? ", " + info.reference : "") });
    return json({ ok:true, info });
  }
  if (path === "/api/ime-clear") {
    await env.BUCKET.put("ime/current.json", JSON.stringify({ terms:[] }), { httpMetadata:{ contentType:"application/json" } });
    imeInvalidate();
    await audit(env, { by:email, action:"ime.clear", target:"IME list", detail:"" });
    return json({ ok:true });
  }
  if (path === "/api/ime-promote") {
    const pt = String(body.pt_name || "").replace(/\s+/g, " ").trim().slice(0, 120), note = String(body.note || "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (pt.length < 3) return json({ error:"Enter the MedDRA preferred term." }, 400);
    await write(env, data => {
      const list = (data.settings ||= {}).imePromotions ||= [];
      const at = list.findIndex(p => imeNorm(p.pt_name) === imeNorm(pt));
      if (body.remove) { if (at >= 0) list.splice(at, 1); } else if (at < 0) list.push({ pt_name:pt, note, promoted_at:new Date().toISOString(), by:email });
    });
    await audit(env, { by:email, action:body.remove ? "ime.unpromote" : "ime.promote", target:pt, detail:note });
    return json({ ok:true });
  }
  if (path === "/api/ma-save") {
    const { entries, errors } = parseMaText(body.text);
    if (!entries.length && errors.length) return json({ error:errors.slice(0, 3).join("; ") }, 400);
    await write(env, data => { (data.settings ||= {}).marketAuth = entries; });
    await audit(env, { by:email, action:"ma.save", target:entries.length + " records", detail:errors.length ? errors.length + " lines skipped" : "" });
    return json({ ok:true, saved:entries.length, errors:errors.slice(0, 10) });
  }
  if (path === "/api/audit-verify") {
    const chain = await verifyAuditChain(env);
    await env.BUCKET.put("audit2/verification.json", JSON.stringify({ at:new Date().toISOString(), by:email, ok:chain.ok, checked:chain.entries_checked, reason:chain.reason }), { httpMetadata:{ contentType:"application/json" } });
    await audit(env, { by:email, action:chain.ok ? "audit.verified" : "audit.verification_failed", detail:{ checked:chain.entries_checked, reason:chain.reason } });
    return json(chain);
  }
  if (path === "/api/audit-anchor") return json({ anchor:await auditAnchor(env) });
  if (path === "/api/audit-anchor-check") return json(await checkAnchor(env, body.anchor));
  if (path === "/api/audit") {
    const month = /^\d{4}-\d{2}$/.test(String(body.month || "")) ? body.month : new Date().toISOString().slice(0, 7);
    return json(await readAudit(env, month));
  }
  if (path === "/api/rank-list" || path === "/api/assign-ranges") {
    const [portfolio, molecule = ""] = String(body.watch || "").split("|").map(v => { try { return decodeURIComponent(v); } catch { return v; } });
    if (!state.watches.some(w => w.portfolio === portfolio && (w.molecule || "") === molecule)) return json({error:"Choose a saved watchlist."},400);
    const order = ["relevance", "newest", "oldest"].includes(body.order) ? body.order : "relevance", pool = body.pool === "unassigned" ? "unassigned" : "open";
    if (path === "/api/rank-list") {
      const ranked = rankedList(state, portfolio, molecule, order, pool);
      return json({ total:ranked.length, items:ranked.slice(0, 300).map((x, i) => ({ n:i + 1, pmid:x.a.pmid, title:state.articles[x.a.pmid]?.title || "", score:x.score, level:x.level, reviewer:x.a.reviewer || "", status:x.a.status })) });
    }
    const ranges = (Array.isArray(body.ranges) ? body.ranges : []).map(r => ({ from:Number(r.from), to:Number(r.to), owner:String(r.owner || "").trim().toLowerCase() }));
    if (!ranges.length || ranges.length > 20 || ranges.some(r => !Number.isInteger(r.from) || !Number.isInteger(r.to) || r.from < 1 || r.to < r.from || r.to > 100000)) return json({error:"Enter ranges like 1 to 20, with a person for each."},400);
    if (ranges.some(r => !state.profiles.some(p => p.email === r.owner && p.active))) return json({error:"Choose an active team member for every range."},400);
    const sorted = [...ranges].sort((a, b) => a.from - b.from);
    if (sorted.some((r, i) => i && r.from <= sorted[i - 1].to)) return json({error:"Ranges must not overlap."},400);
    const result = await write(env, data => {
      const ranked = rankedList(data, portfolio, molecule, order, pool), per = {}, at = new Date().toISOString();
      for (const r of ranges) for (let n = r.from; n <= Math.min(r.to, ranked.length); n++) {
        const a = ranked[n - 1].a;
        if (a.reviewer === r.owner) continue;
        a.reviewer = r.owner; per[r.owner] = (per[r.owner] || 0) + 1;
        (a.history ||= []).push({ status:a.status, note:"Assigned to " + r.owner + " (rank #" + n + ")", by:email, at });
      }
      return { per, total:ranked.length };
    });
    return json({ ok:true, ...result });
  }
  if (path === "/api/delete-watch") {
    const [portfolio, molecule = ""] = String(body.watch || "").split("|").map(decodeURIComponent);
    if (!state.watches.some(w => w.portfolio === portfolio && (w.molecule || "") === molecule)) return json({error:"Choose a saved watchlist."},400);
    // Only the watchlist stops; imported articles, assignments, files and past pulls are kept.
    await write(env, data => { data.watches = data.watches.filter(w => !(w.portfolio === portfolio && (w.molecule || "") === molecule)); });
    return json({ ok:true });
  }
  if (path === "/api/suggest-synonyms") return json(await suggestSynonyms(body.name));
  if (path === "/api/faers") {
    const names = Array.isArray(body.names) ? body.names.map(String) : [];
    try { return json({ result:await faersReactions(names) }); } catch (error) { return json({ error:error.message }, 502); }
  }
  if (path === "/api/assign-molecule") {
    const [portfolio, molecule = ""] = String(body.watch || "").split("|").map(decodeURIComponent);
    const owner = String(body.owner || "").trim().toLowerCase();
    if (!state.watches.some(w => w.portfolio === portfolio && (w.molecule || "") === molecule)) return json({error:"Choose a saved watchlist."},400);
    if (owner && !state.profiles.some(p => p.email === owner && p.active)) return json({error:"Choose an active team member."},400);
    const moved = await write(env, data => {
      const watch = data.watches.find(w => w.portfolio === portfolio && (w.molecule || "") === molecule);
      if (owner) watch.owner = owner; else delete watch.owner;
      let count = 0;
      for (const a of data.assignments) {
        if (a.portfolio !== portfolio || a.status === "Complete" || (molecule && !(a.molecules || []).includes(molecule))) continue;
        const target = owner || (body.reassign === true ? "" : a.reviewer);
        if (a.reviewer === target || (a.reviewer && body.reassign !== true)) continue;
        a.reviewer = target; count++;
        (a.history ||= []).push({ status:a.status, note:target ? "Assigned to " + target : "Unassigned", by:email, at:new Date().toISOString() });
      }
      if (!owner) data.assignments.filter(a => !a.reviewer).forEach(a => allocate(data, a));
      return count;
    });
    return json({ ok:true, moved });
  }
  if (path === "/api/recheck-access") {
    await write(env, data => { for (const a of Object.values(data.articles)) { delete a.oaCheckedAt; delete a.evidenceAttempt; if (/^(No PMC record|No eligible PMC file|No open-access copy|Not in Unpaywall|No downloadable open-access copy)$/.test(a.fullTextStatus || "")) delete a.fullTextStatus; } });
    return json({ ok:true });
  }
  if (path === "/api/evidence") return json(await collectEvidence(env, Array.isArray(body.ids) ? body.ids.map(String).slice(0, 5000) : undefined));
  if (path === "/api/profile") {
    const profile = { email:String(body.email || "").trim().toLowerCase(), name:String(body.name || "").trim(),
      role:"reviewer", portfolio:String(body.portfolio || "").trim(), capacity:Number(body.capacity), active:body.active !== false };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(profile.email) || !profile.name || !Number.isInteger(profile.capacity) ||
        profile.capacity < 1 || profile.capacity > 500) return json({ error:"Enter a valid profile and capacity." },400);
    await write(env, data => {
      const existing = data.profiles.findIndex(p => p.email === profile.email);
      if (existing < 0) data.profiles.push(profile);
      else if (data.profiles[existing].role === "reviewer") data.profiles[existing] = profile;
      else throw new Error("The owner profile cannot be replaced.");
      data.assignments.filter(a => !a.reviewer).forEach(a => allocate(data,a));
    });
  } else if (path === "/api/dictionary-save") {
    const portfolio = String(body.portfolio || "").trim().slice(0, 100);
    if (!portfolio || !Array.isArray(body.products) || body.products.length > 300) return json({ error:"Enter a portfolio and up to 300 products." }, 400);
    const products = body.products.map(p => ({ name:String(p?.name || "").trim().slice(0, 100), generics:splitNames(p?.generics), brands:splitNames(p?.brands), salts:splitNames(p?.salts), aliases:splitNames(p?.aliases) })).filter(p => p.name);
    if (!products.length) return json({ error:"Each product needs a name." }, 400);
    const seen = new Map();
    for (const p of products) for (const n of dictNames(p)) { const other = seen.get(n.toLowerCase()); if (other && other !== p.name) return json({ error:"\"" + n + "\" is listed under both " + other + " and " + p.name + ". A name can belong to one product only." }, 400); seen.set(n.toLowerCase(), p.name); }
    const saved = await write(env, data => { const old = (data.dictionaries ||= {})[portfolio]; data.dictionaries[portfolio] = { version:(old?.version || 0) + 1, updatedAt:new Date().toISOString(), by:email, products, history:[...(old?.history || []).slice(-19), ...(old ? [{ version:old.version, at:old.updatedAt, by:old.by, products:old.products.length }] : [])] }; return data.dictionaries[portfolio]; });
    await audit(env, { by:email, action:"dictionary.save", target:portfolio, detail:{ version:saved.version, products:products.length, names:products.reduce((n, p) => n + dictNames(p).length, 0) } });
    return json({ ok:true, version:saved.version });
  } else if (path === "/api/watch-preview" || path === "/api/watch-version") {
    const portfolio = String(body.portfolio || "").trim(), molecule = String(body.molecule || "").trim();
    const watch = state.watches.find(w => w.portfolio === portfolio && (w.molecule || "") === molecule);
    const entry = dictionaryFor(state, portfolio, molecule), names = body.useDictionary !== false && entry ? dictNames(entry) : [molecule, ...splitNames(body.synonyms)].filter(Boolean);
    const proposed = String(body.query || "").trim() || (names.length ? buildQuery(names, body.safetyOnly === true) : "");
    if (!portfolio || !proposed || proposed.length > 1500) return json({ error:"Enter a portfolio and a molecule or a query (up to 1,500 characters)." }, 400);
    const effectiveFrom = /^\d{4}-\d{2}-\d{2}$/.test(body.effectiveFrom || "") ? body.effectiveFrom : addDays(day(), 1);
    if (path === "/api/watch-preview") {
      const current = watch ? queryAt(watch, day()) : null, before = queryTerms(current?.query || ""), after = queryTerms(proposed), from = addDays(day(), -30);
      const counts = { current:null, proposed:null, window:{ from, to:day(), dateField:"crdt" } };
      try { if (current) counts.current = await esearchCount(withSettings(env, state), current.query, from, day(), "crdt"); counts.proposed = await esearchCount(withSettings(env, state), proposed, from, day(), "crdt"); } catch { /* counts are a convenience */ }
      return json({ exists:Boolean(watch), current:current && { version:current.version, query:current.query }, proposed:{ query:proposed, names }, added:after.filter(t => !before.includes(t)), removed:before.filter(t => !after.includes(t)), counts, effectiveFrom, note:"Applied prospectively: imports already executed keep the version they ran with; the new version is used for dates from " + effectiveFrom + "." });
    }
    const created = await write(env, data => {
      let w = data.watches.find(x => watchKey(x) === watchKey({ portfolio, molecule }));
      if (!w) { w = { portfolio, molecule, query:proposed }; commitWatch(data, w, email); w = data.watches.find(x => watchKey(x) === watchKey({ portfolio, molecule })); return w.versions.at(-1); }
      if (!w.versions) w.versions = [{ version:1, query:w.query, effectiveFrom:"0000-00-00", createdAt:new Date().toISOString(), by:"system", note:"initial" }];
      const last = w.versions.slice().sort((a, b) => a.version - b.version).at(-1);
      if (last.query === proposed) return last;
      const version = { version:last.version + 1, query:proposed, effectiveFrom, createdAt:new Date().toISOString(), by:email, note:String(body.note || "").slice(0, 300), dictionaryVersion:data.dictionaries?.[portfolio]?.version || null };
      w.versions.push(version); w.query = queryAt(w, day()).query;
      return version;
    });
    await audit(env, { by:email, action:"watch.versioned", target:portfolio + (molecule ? " · " + molecule : ""), detail:{ version:created.version, effectiveFrom:created.effectiveFrom, note:created.note || "" } });
    return json({ ok:true, version:created });
  } else if (path === "/api/import-resume") {
    const run = state.runs.find(r => r.id === body.runId);
    if (!run?.windows) return json({ error:"That import cannot be resumed." }, 404);
    // Windows that stopped after too many failures are given a fresh set of attempts on request.
    if (body.retryFailed === true) await write(env, data => { for (const w of data.runs.find(r => r.id === run.id).windows) if (w.state === "failed") w.attempts = 0; });
    const resumed = await runImport(env, run.id);
    await audit(env, { by:email, action:"import.resumed", target:run.portfolio + (run.molecule ? " · " + run.molecule : ""), detail:{ run:run.id, coverage:resumed.coverage, gaps:resumed.gaps.length } });
    return json(resumed);
  } else if (path === "/api/watch") {
    const watch = { portfolio:String(body.portfolio || "").trim(), molecule:String(body.molecule || "").trim().slice(0,100), query:String(body.query || "").trim() };
    if (!watch.portfolio || !watch.query || watch.query.length > 1500) return json({error:"Enter a portfolio and a PubMed query."},400);
    await write(env, data => { keepOwner(data, watch); commitWatch(data, watch, email); });
    await audit(env, { by:email, action:"watch.save", target:watch.portfolio + (watch.molecule ? " · " + watch.molecule : ""), detail:{ version:watch.versions.at(-1).version } });
  } else if (path === "/api/watches") {
    const portfolio = String(body.portfolio || "").trim();
    if (!portfolio || !Array.isArray(body.rows) || !body.rows.length || body.rows.length > 500) return json({error:"Enter a portfolio and 1 to 500 molecules."},400);
    const created = [], skipped = [];
    const bulkOwner = String(body.owner || "").trim().toLowerCase();
    if (bulkOwner && !state.profiles.some(p => p.email === bulkOwner && p.active)) return json({error:"Choose an active team member."},400);
    for (const row of body.rows) {
      const names = namesWithDictionary(state, portfolio, [row?.molecule, ...(Array.isArray(row?.synonyms) ? row.synonyms : [])].filter(Boolean));
      const molecule = String(row?.molecule || "").trim().slice(0,100);
      const query = molecule && buildQuery(names, body.safetyOnly === true);
      if (query) created.push({ portfolio, molecule, query, ...(bulkOwner ? { owner:bulkOwner } : {}) }); else skipped.push(molecule || "(blank)");
    }
    await write(env, data => {
      created.forEach(w => { keepOwner(data, w); commitWatch(data, w, email); });
    });
    return json({ created:created.length, skipped });
  } else if (path === "/api/pull") {
    // One step: build the query for a molecule, save it as a watchlist, and import the date range.
    const valid = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
    const molecule = String(body.molecule || "").trim().slice(0,100);
    const synonyms = String(body.synonyms || "").split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
    const portfolio = String(body.portfolio || "").trim().slice(0,100) || molecule;
    let query = molecule && buildQuery(namesWithDictionary(state, portfolio, [molecule, ...synonyms]), body.safetyOnly === true);
    if (!query) return json({error:"Enter a molecule name (up to 30 names, 100 characters each)."},400);
    // Optional PubMed filters, written in PubMed's own field syntax.
    const narrow = [body.humans === true && "humans[mh]", body.caseReports === true && '"case reports"[pt]', body.english === true && "english[lang]"].filter(Boolean);
    if (narrow.length || body.noReviews === true) query = "(" + query + ")" + narrow.map(f => " AND " + f).join("") + (body.noReviews === true ? " NOT review[pt]" : "");
    if (query.length > 1500) return json({error:"The search became too long; use fewer synonyms or filters."},400);
    if (!valid(body.from) || !valid(body.to) || body.from > body.to || body.to > day()) {
      return json({error:"Choose a valid date range through today."},400);
    }
    const owner = String(body.owner || "").trim().toLowerCase();
    if (owner && !state.profiles.some(p => p.email === owner && p.active)) return json({error:"Choose an active team member."},400);
    const watch = { portfolio, molecule, query, ...(owner ? { owner } : {}) };
    await write(env, data => { keepOwner(data, watch); commitWatch(data, watch, email); });
    const run = await execute(env, watch, body.from, body.to, { mode:"backfill", dateField:body.dateField });
    await collectEvidence(env, run.ids);
    return json(run);
  } else if (path === "/api/social-add") {
    const posts = String(body.text || "").split(/\r?\n\s*-{3,}\s*\r?\n/).map(t => t.trim()).filter(t => t.length >= 20).slice(0, 50).map(text => ({ text:text.slice(0, 6000), url:String(body.url || "").trim(), postedAt:/^\d{4}-\d{2}-\d{2}$/.test(body.postedAt || "") ? body.postedAt : "" }));
    const portfolio = String(body.portfolio || "").trim().slice(0, 80), molecule = String(body.molecule || "").trim().slice(0, 100), platform = ["Reddit", "X (Twitter)", "Facebook", "Patient forum", "Other"].includes(body.platform) ? body.platform : "Other";
    if (!posts.length) return json({ error:"Paste at least one post (20 or more characters). Separate several posts with a line of three dashes." }, 400);
    if (!portfolio) return json({ error:"Choose or type a portfolio." }, 400);
    const ids = await addSocialPosts(env, posts, portfolio, molecule, platform, email);
    await audit(env, { by:email, action:"import.social", target:portfolio + (molecule ? " · " + molecule : ""), detail:{ posts:ids.length, platform } });
    return json({ added:ids.length });
  } else if (path === "/api/pmid-batch") {
    const list = parsePmidList(body.text), portfolio = String(body.portfolio || "").trim().slice(0, 80), molecule = String(body.molecule || "").trim().slice(0, 100);
    if (!list.length) return json({ error:"Paste at least one PMID (digits), one per line, or comma separated." }, 400);
    if (!portfolio) return json({ error:"Choose or type a portfolio for these articles." }, 400);
    const { run, missing } = await importPmidList(env, list, portfolio, molecule);
    await audit(env, { by:email, action:"import.pmids", target:portfolio + (molecule ? " · " + molecule : ""), detail:{ requested:list.length, found:run.count, not_found:missing.length } });
    return json({ run, requested:list.length, missing });
  } else if (path === "/api/import") {
    const [portfolio, molecule = ""] = String(body.watch || "").split("|").map(decodeURIComponent);
    const watch = state.watches.find(w => w.portfolio === portfolio && (w.molecule || "") === molecule);
    const valid = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
    if (!watch || !valid(body.from) || !valid(body.to) || body.from > body.to || body.to > day()) {
      return json({error:"Choose a saved portfolio and a valid date range through today."},400);
    }
    const run = await execute(env, watch, body.from, body.to, { mode:"backfill", dateField:body.dateField });
    await collectEvidence(env, run.ids);
    return json(run);
  } else return json({ error:"Route unavailable." },404);
  return json({ ok:true });
}
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LiteraSift</title><style>
:root{--bg:#fafafa;--fg:#09090b;--muted:#71717a;--card:#fff;--border:#e4e4e7;--accent:#f4f4f5;--primary:#18181b;--primary-fg:#fafafa;--brand:#0f766e;--brand-soft:#ccfbf1;--ring:#a1a1aa;--red:#dc2626;--red-soft:#fee2e2;--amber:#b45309;--amber-soft:#fef3c7;--green:#15803d;--green-soft:#dcfce7;--blue:#1d4ed8;--blue-soft:#dbeafe;--radius:10px;--shadow:0 1px 2px #0000000d}
[data-theme=dark]{--bg:#09090b;--fg:#fafafa;--muted:#a1a1aa;--card:#111113;--border:#27272a;--accent:#18181b;--primary:#fafafa;--primary-fg:#18181b;--brand:#2dd4bf;--brand-soft:#134e4a;--ring:#52525b;--red:#f87171;--red-soft:#450a0a;--amber:#fbbf24;--amber-soft:#451a03;--green:#4ade80;--green-soft:#052e16;--blue:#93c5fd;--blue-soft:#172554;--shadow:none}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
button,input,select,textarea{font:inherit;color:inherit}a{color:var(--brand);text-decoration:none}a:hover{text-decoration:underline}
.shell{display:grid;grid-template-columns:240px 1fr;min-height:100vh}
aside{border-right:1px solid var(--border);background:var(--card);padding:18px 12px;display:flex;flex-direction:column;gap:6px;position:sticky;top:0;height:100vh;overflow-y:auto}
.brand{display:flex;align-items:center;gap:10px;padding:4px 10px 18px;font-weight:700;font-size:17px;letter-spacing:-.02em}
.logo{width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,#0f766e,#14b8a6);display:grid;place-items:center;color:#fff}
.ic{width:16px;height:16px;flex:none}
.navbtn{display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;border:0;background:none;border-radius:8px;color:var(--muted);cursor:pointer;font-weight:500;text-align:left;transition:background .15s,color .15s}
.navbtn:hover{background:var(--accent);color:var(--fg)}.navbtn[aria-current]{background:var(--accent);color:var(--fg);box-shadow:inset 2px 0 0 var(--brand)}
.navbtn .n{margin-left:auto;font-size:12px;background:var(--brand-soft);color:var(--brand);border-radius:99px;padding:0 7px}
.spacer{flex:1}
.who{border-top:1px solid var(--border);padding:12px 10px 0;font-size:13px}.who small{display:block;color:var(--muted)}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 28px;border-bottom:1px solid var(--border);background:var(--card);position:sticky;top:0;z-index:5}
.top h1{margin:0;font-size:18px;letter-spacing:-.02em}.top p{margin:0;color:var(--muted);font-size:13px}
main{padding:24px 28px 60px;max-width:1280px;animation:fade .3s ease}
@keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;background:var(--primary);color:var(--primary-fg);border:1px solid var(--primary);border-radius:8px;padding:7px 14px;font-weight:500;cursor:pointer;transition:opacity .15s,transform .05s}
.btn:hover{opacity:.9}.btn:active{transform:scale(.98)}.btn:disabled{opacity:.5;cursor:wait}
.btn.outline{background:transparent;color:var(--fg);border-color:var(--border)}.btn.outline:hover{background:var(--accent)}.btn.sm{padding:4px 10px;font-size:13px}
.icon-btn{padding:7px 9px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:18px}
.card,section{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow)}
.card{padding:16px 18px;position:relative;overflow:hidden;transition:border-color .2s,transform .2s}.card:hover{border-color:var(--ring);transform:translateY(-1px)}
.card .lbl{display:flex;justify-content:space-between;align-items:center;color:var(--muted);font-size:13px}
.card b{display:block;font-size:30px;letter-spacing:-.03em;margin-top:6px;font-variant-numeric:tabular-nums}
.card.warn b{color:var(--red)}
section{margin:0 0 18px;overflow:hidden}
section>header{padding:16px 18px 0}section>header h2{margin:0;font-size:15px}section>header p{margin:2px 0 0;color:var(--muted)}
.body{padding:16px 18px 18px;overflow:auto}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px}
table{border-collapse:collapse;width:100%;text-align:left}th{font-size:12px;font-weight:500;color:var(--muted);padding:10px 14px;border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:12px 14px;vertical-align:top;border-bottom:1px solid var(--border)}tbody tr{transition:background .12s}tbody tr:hover{background:var(--accent)}tbody tr:last-child td{border-bottom:0}
.tablewrap{overflow:auto}
.badge{display:inline-flex;align-items:center;gap:4px;border-radius:99px;padding:1px 9px;font-size:12px;font-weight:500;white-space:nowrap;background:var(--accent);color:var(--muted);border:1px solid var(--border)}
.badge.blue{background:var(--blue-soft);color:var(--blue);border-color:transparent}.badge.amber{background:var(--amber-soft);color:var(--amber);border-color:transparent}
.badge.green{background:var(--green-soft);color:var(--green);border-color:transparent}.badge.red{background:var(--red-soft);color:var(--red);border-color:transparent}
mark{border-radius:3px;padding:0 2px;color:inherit}mark.mol{background:#fde68a}mark.ae{background:#fecaca}[data-theme=dark] mark.mol{background:#78350f}[data-theme=dark] mark.ae{background:#7f1d1d}
details.abs{margin-top:8px}details.abs summary{cursor:pointer;color:var(--brand);font-size:13px}details.abs div{margin-top:6px;max-width:70ch;font-size:13px;line-height:1.55}
.title{font-weight:500;color:var(--fg)}.sub{color:var(--muted);font-size:12px}.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.bar{height:8px;border-radius:99px;background:var(--accent);overflow:hidden;border:1px solid var(--border)}.bar i{display:block;height:100%;background:linear-gradient(90deg,#0f766e,#2dd4bf);width:0;transition:width .9s cubic-bezier(.2,.8,.2,1)}
.row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0}.row+.row{border-top:1px solid var(--border)}
.filters{display:flex;gap:10px;flex-wrap:wrap;padding:14px 18px;border-bottom:1px solid var(--border)}
input,select,textarea{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:7px 10px;max-width:100%;outline:none;transition:box-shadow .15s,border-color .15s}
input:focus,select:focus,textarea:focus{border-color:var(--ring);box-shadow:0 0 0 3px #71717a33}input[type=checkbox]{width:auto}
.filters input{flex:1;min-width:200px}
form.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));align-items:end}form.grid .wide{grid-column:1/-1}
label{display:flex;flex-direction:column;gap:5px;font-weight:500;font-size:13px}label.check{flex-direction:row;align-items:center;font-weight:400}
.empty{text-align:center;color:var(--muted);padding:34px 10px}
dialog{border:1px solid var(--border);border-radius:14px;width:min(560px,94vw);padding:22px;background:var(--card);color:var(--fg);box-shadow:0 20px 50px #00000040}dialog::backdrop{background:#09090b99;backdrop-filter:blur(2px)}
dialog form{display:grid;gap:14px}dialog h2{margin:0 0 4px}
#toast{position:fixed;right:20px;bottom:20px;z-index:20;max-width:380px;padding:11px 16px;border-radius:10px;background:var(--primary);color:var(--primary-fg);box-shadow:0 10px 30px #0004;transform:translateY(20px);opacity:0;pointer-events:none;transition:all .25s}
#toast.show{transform:none;opacity:1}#toast.err{background:var(--red);color:#fff}
.skel{height:14px;border-radius:6px;background:linear-gradient(90deg,var(--accent),var(--border),var(--accent));background-size:200% 100%;animation:sh 1.2s infinite;margin:12px 0}@keyframes sh{to{background-position:-200% 0}}
@media(max-width:860px){.shell{grid-template-columns:1fr}aside{position:static;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center}.brand{padding:4px 10px}.who,.spacer{display:none}.navbtn{width:auto}.grid2{grid-template-columns:1fr}.top,main{padding-left:16px;padding-right:16px}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
<div class="shell"><aside><div class="brand"><span class="logo"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18M6 12h12M10 19h4"/></svg></span>LiteraSift</div><nav id="nav" aria-label="LiteraSift"></nav><div class="spacer"></div><div class="who" id="identity"></div></aside>
<div><div class="top"><div><h1 id="heading">LiteraSift</h1><p id="subhead"></p></div><button class="btn outline icon-btn" id="theme" aria-label="Toggle dark mode" title="Toggle dark mode"></button></div>
<main id="content"><div class="skel"></div><div class="skel"></div><div class="skel"></div></main></div></div>
<div id="toast" role="status"></div>
<dialog id="casedlg" style="width:min(1180px,96vw);max-height:92vh;overflow:auto"><div id="casehead" style="display:flex;justify-content:space-between;gap:12px;align-items:flex-end;margin-bottom:14px"></div>
<div style="display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));align-items:start"><div id="casebody"></div><div><div id="caseassess"></div></div></div>
<p id="caseerr" class="msg" style="color:var(--red)" role="alert"></p>
<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px"><button type="button" class="btn" data-caseact="save">Save</button><button type="button" class="btn outline" data-caseact="assess">Assess</button><button type="button" class="btn outline" data-caseact="json">Download ICSR JSON</button><button type="button" class="btn outline" data-caseact="package">Download package (ZIP)</button><button type="button" class="btn outline" data-caseact="e2b">E2B(R3) XML</button><button type="button" class="btn outline" data-caseact="cioms">CIOMS I (PDF)</button><button type="button" class="btn outline" data-caseact="fhir">FHIR JSON</button><button type="button" class="btn outline" data-caseact="csv">Line listing (CSV)</button><button type="button" class="btn outline" data-signopen="case" id="casesign">Signature…</button><button type="button" class="btn outline" data-caseact="delete" id="casedel">Delete</button><button type="button" class="btn outline" data-caseact="close">Close</button></div>
<p class="sub" style="margin-top:10px">Human-in-the-loop: values pre-filled from the article are only proposals. Causality and QC are aids; a qualified reviewer decides.</p></dialog>
<dialog id="signdlg" style="width:min(640px,94vw)"><h2 id="signtitle">Electronic signature</h2><div id="signbody"></div><p id="signerr" class="msg" style="color:var(--red)" role="alert"></p></dialog>
<dialog id="linkdlg"><h2 id="linktitle"></h2><p id="linknote" class="sub"></p><div style="display:grid;gap:12px"><input id="linkvalue" readonly aria-label="Link"><div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn" id="linkcopy">Copy link</button><button type="button" class="btn outline" id="linkshare">Share…</button><button type="button" class="btn outline" id="linkclose">Done</button></div></div></dialog>
<dialog id="dialog"><h2>Screen citation</h2><p id="citation" class="sub"></p><div id="detail" style="max-height:38vh;overflow:auto;margin-bottom:12px"></div><form id="review"><label>Status<select name="status"><option>Pending</option><option>In review</option><option>Full text needed</option><option>Complete</option></select></label><label>Decision notes<textarea name="note" rows="4"></textarea></label><div style="display:flex;gap:8px"><button class="btn">Save decision</button><button type="button" class="btn outline" id="close">Cancel</button><button type="button" class="btn outline" data-signopen="screening" id="screensign">Signature…</button></div></form></dialog>
<script>
const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const paths = {
  Overview:'<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  "My Queue":'<path d="M3 6h.01M3 12h.01M3 18h.01M8 6h13M8 12h13M8 18h13"/>',
  "All Assignments":'<path d="M3 6h18M3 12h18M3 18h12"/>',
  "Search & Pull":'<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  Batches:'<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/>',
  Watchlists:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  Settings:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  "Synchrony":'<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  Audit:'<path d="M9 12l2 2 4-4M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  Library:'<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  Account:'<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  Team:'<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M17 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6"/>',
  moon:'<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>', sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  alert:'<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'
};
const ic = name => '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+paths[name]+'</svg>';
const subtitles = {Overview:"Screening progress across portfolios.","My Queue":"Citations assigned to you.","All Assignments":"Every citation across the team.","Search & Pull":"Type a molecule and a date range to pull every matching PubMed article.",Batches:"Imports and evidence processing.",Watchlists:"Molecules and PubMed queries that feed the screening queue.",Team:"Reviewers and capacity.",Settings:"Integrations and open-access checks.",Account:"Your sign-in and password.",Library:"A folder per molecule, with a subfolder for each pull's date range.",Audit:"Who did what and when. Tamper-evident and read-only.",Synchrony:"The ICSR workbench: track, assign, code, sign and export case safety reports from LiteraSift articles."};
async function exportPdf(pmids,title,subtitle){
  pmids=[...new Set(pmids)];
  if(!pmids.length)throw new Error("Nothing to export.");
  const parts=Math.ceil(pmids.length/40);
  for(let i=0;i<parts;i++){
    message("Building PDF "+(i+1)+" of "+parts+"…");
    const res=await fetch("/api/export",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pmids:pmids.slice(i*40,i*40+40),title:title+(parts>1?" (part "+(i+1)+" of "+parts+")":""),subtitle})});
    if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(e.error||"Export failed.");}
    const link=document.createElement("a");link.href=URL.createObjectURL(await res.blob());
    const slug=title.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,40);
    link.download=(slug.startsWith("literasift")?"":"literasift-")+slug+(parts>1?"-part"+(i+1):"")+".pdf";
    link.click();setTimeout(()=>URL.revokeObjectURL(link.href),4000);
  }
  message(pmids.length+" articles exported in "+parts+" PDF"+(parts>1?"s":"")+".");
}
async function exportFile(route,ext,pmids,title,subtitle,label,extra){
  pmids=[...new Set(pmids)];
  if(!pmids.length)throw new Error("Nothing to export.");
  const parts=Math.ceil(pmids.length/40);
  for(let i=0;i<parts;i++){
    message("Building "+label+" "+(i+1)+" of "+parts+"…");
    const res=await fetch("/api/"+route,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...extra,pmids:pmids.slice(i*40,i*40+40),title:title+(parts>1?" (part "+(i+1)+" of "+parts+")":""),subtitle})});
    if(!res.ok){const e=await res.json().catch(()=>({}));if(parts>1&&res.status===400)continue;throw new Error(e.error||"Export failed.");}
    const link=document.createElement("a");link.href=URL.createObjectURL(await res.blob());
    const slug=title.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,40);
    link.download=(slug.startsWith("literasift")?"":"literasift-")+slug+(parts>1?"-part"+(i+1):"")+"."+ext;
    link.click();setTimeout(()=>URL.revokeObjectURL(link.href),4000);
  }
  message("Export finished.");
}
const runStats=run=>{
  const arts=run.ids.map(id=>data.articles[id]).filter(Boolean), n=run.ids.length, c=f=>arts.filter(f).length;
  return {n,abstracts:c(a=>a.abstract),oaChecked:c(a=>a.oaCheckedAt),oaOpen:c(a=>a.oaIsOpen),pmc:c(a=>a.fullTextOrigin==="PMC"&&a.fullTextKey),epmc:c(a=>a.fullTextOrigin==="Europe PMC"&&a.fullTextKey),
    unpaywall:c(a=>a.fullTextOrigin==="Unpaywall"&&a.fullTextKey),linkOnly:c(a=>a.fullTextStatus==="Open access link only"),closed:c(a=>a.oaStatus==="closed"),texts:c(a=>a.fullTextTextKey),passages:c(a=>(a.keyPassages||[]).length),retr:c(a=>a.retractionCheckedAt)};
};
let curCase=null, curAssess=null;
const SIT=["Pregnancy exposure","Neonatal exposure","Paediatric patient","Elderly patient","Overdose","Misuse / abuse","Lack of effect","Off-label use","Drug interaction","Medication error"];
const QUAL=["","Physician","Pharmacist","Other health professional","Health professional (published literature)","Lawyer","Consumer or other non-health professional"];
const gp=(o,p)=>p.split(".").reduce((x,k)=>x==null?x:x[k],o);
const caseTitleTip=f=>((f.evidence||[])[0]||{}).excerpt||"";
const caseInput=(label,path,type)=>{const f=gp(curCase.data,path)||{};return '<label>'+label+(f.state==="proposed"&&f.value?' <span class="badge amber" title="Proposed from the article: confirm or correct">proposed</span>':"")+'<input data-kind="field" data-path="'+path+'" value="'+esc(f.value||"")+'" title="'+esc(caseTitleTip(f))+'"'+(type?' type="'+type+'"':"")+'></label>';};
const caseSelect=(label,path,options)=>{const f=gp(curCase.data,path)||{};return '<label>'+label+(f.state==="proposed"&&f.value?' <span class="badge amber">proposed</span>':"")+'<select data-kind="field" data-path="'+path+'">'+options.map(o=>'<option'+(o===(f.value||"")?" selected":"")+'>'+esc(o)+'</option>').join("")+'</select></label>';};
const blankField=()=>({value:null,normalized_value:null,state:"edited",evidence:[]});
const blankProduct=()=>({role:"concomitant",start_not_reported:false,name:blankField(),dose:blankField(),frequency:blankField(),route:blankField(),indication:blankField(),start_date:blankField(),stop_date:blankField(),action_taken:blankField(),dechallenge:blankField(),rechallenge:blankField()});
const blankEvent=()=>({verbatim:blankField(),onset_date:blankField(),stop_date:blankField(),outcome:blankField(),expectedness:blankField(),coded_term:blankField(),time_to_onset:blankField(),causality_reporter:blankField(),causality_reviewer:blankField(),causality_method:blankField(),temporal_relationship:blankField(),alternative_causes:blankField(),concomitant_factors:blankField(),objective_evidence:blankField(),listedness:blankField(),assessed_term:blankField(),rsi:blankField(),causality_rationale:blankField(),reviewer_comment:blankField(),llt:blankField(),pt:blankField(),pt_code:blankField(),hlt:blankField(),hlgt:blankField(),soc:blankField(),meddra_version:blankField(),coding_status:blankField(),onset_not_reported:false,seriousness:{serious:false,death:false,life_threatening:false,hospitalization:false,disability:false,congenital_anomaly:false,other_medically_important:false}});
function setField(o,p,val){const parts=p.split("."),last=parts.pop(),t=parts.reduce((x,k)=>x[k],o),f=t[last];if(f&&(f.value||"")!==val){f.value=val===""?null:val;f.state="edited";}}
function collectCase(){
  const d=curCase.data, box=$("casebody");
  box.querySelectorAll("[data-kind=field]").forEach(el=>{if(el.dataset.path.endsWith(".role")){const parts=el.dataset.path.split(".");d[parts[0]][parts[1]].role=el.value;}else setField(d,el.dataset.path,el.value);});
  box.querySelectorAll("[data-kind=flag]").forEach(el=>{const parts=el.dataset.path.split("."),last=parts.pop();parts.reduce((x,k)=>x[k],d)[last]=el.checked;});
  d.events.forEach(e=>{const s=e.seriousness;if(s.death||s.life_threatening||s.hospitalization||s.disability||s.congenital_anomaly||s.other_medically_important)s.serious=true;});
  const old=d.patient.medical_history, lines=$("casehist").value.split("\\n").map(x=>x.trim()).filter(Boolean);
  d.patient.medical_history=lines.map(t=>old.find(h=>h.value===t)||{value:t,normalized_value:null,state:"edited",evidence:[]});
  d.special_situations=[...box.querySelectorAll("[data-kind=situation]")].filter(x=>x.checked).map(x=>x.value).concat(d.special_situations.filter(x=>!SIT.includes(x)));
  d.general_comments=$("casegeneral").value;d.sender_comments=$("casesendercomment").value;d.source_summary=$("casesummary").value;curCase.notes=$("casenotes").value;curCase.status=$("casestatus").value;
  d.treatment_given=$("casetreat").value.split(NL).map(x=>x.trim()).filter(Boolean);
  const oldConf=d.confounders||[];
  d.confounders=$("caseconf").value.split(NL).map(x=>x.trim()).filter(Boolean).map(line=>{const i=line.indexOf(":"),type=i>0?line.slice(0,i).trim():"Other",text=i>0?line.slice(i+1).trim():line;return oldConf.find(c=>c.type===type&&c.text===text)||{type,text,evidence:""};});
}
function assessmentHtml(a){
  if(!a)return '<div class="empty">Not assessed yet.</div>';
  const v=a.validity,q=a.qc,c=a.causality,fu=(a.follow_up&&a.follow_up.questions)||[];
  const tick=(ok,t)=>'<div class="row"><span>'+t+'</span>'+(ok?badge("Met","green"):badge("Missing","red"))+'</div>';
  const sev={critical:"red",major:"amber",minor:"blue",info:""};
  return '<div class="sub" style="margin-bottom:6px">Assessed by: '+esc(a.engine||"")+(a.remoteError?' <span class="badge amber" title="'+esc(a.remoteError)+'">PV Nexus API unreachable, local rules used</span>':"")+'</div>'+
    '<div class="row"><b>Minimum criteria</b>'+(v.valid_icsr?badge("Valid ICSR","green"):badge("Not valid yet","amber"))+'</div>'+tick(v.identifiable_patient,"Identifiable patient")+tick(v.identifiable_reporter,"Identifiable reporter")+tick(v.suspect_product,"Suspect product")+tick(v.adverse_event,"Adverse event")+
    '<div class="row" style="margin-top:8px"><b>QC score</b><b>'+q.score+' / 100</b></div><div class="bar"><i style="width:'+q.score+'%"></i></div><div style="margin:6px 0">'+(q.ready_for_medical_review?badge("Ready for medical review","green"):badge("Not ready for medical review","amber"))+'</div>'+
    q.findings.map(f=>'<div class="row" style="align-items:flex-start"><span>'+badge(f.severity,sev[f.severity]||"")+' <b>'+esc(f.title)+'</b><div class="sub">'+esc(f.suggested_action||f.detail)+'</div></span></div>').join("")+
    '<div class="row" style="margin-top:8px"><b>Causality (suggestion)</b>'+badge(c.category,"blue")+'</div><div class="sub">'+c.rationale.map(esc).join(" · ")+'</div><div class="sub" style="margin-top:4px">Non-authoritative: a medical reviewer must confirm the assessment.</div>'+
    ((a.literature_checks||[]).length?'<div class="row" style="margin-top:10px"><b>Literature checks</b></div>'+a.literature_checks.map(f=>'<div class="row" style="align-items:flex-start"><span>'+badge(f.severity,sev[f.severity]||"")+' <b>'+esc(f.title)+'</b><div class="sub">'+esc(f.suggested_action||f.detail)+'</div></span></div>').join(""):"")+
    (a.regulatory?'<div class="row" style="margin-top:10px"><b>Regulatory context</b>'+(a.regulatory.country?badge(a.regulatory.country,"blue"):badge("Country needed","amber"))+'</div>'+(a.regulatory.regulator?'<div class="row"><span>Regulator</span><span>'+esc(a.regulatory.regulator)+'</span></div>':"")+(a.regulatory.ma?'<div class="row"><span>Marketing authorisation</span>'+badge(a.regulatory.ma.status,maColor[a.regulatory.ma.status]||"")+'</div>'+(a.regulatory.ma.mah?'<div class="sub">'+esc(a.regulatory.ma.mah+(a.regulatory.ma.number?" · "+a.regulatory.ma.number:""))+'</div>':""):"")+(a.regulatory.due?'<div class="row"><span>Report due ('+a.regulatory.days+' days from '+esc(a.regulatory.day0)+')</span><b>'+esc(a.regulatory.due)+'</b></div>':"")+(a.regulatory.note?'<div class="sub">'+esc(a.regulatory.note)+'</div>':"")+'<div class="sub">'+esc(a.regulatory.clock)+'</div>':"")+
    (fu.length?'<div class="row" style="margin-top:8px"><b>Follow-up questions</b></div>'+fu.map(x=>'<div class="row" style="align-items:flex-start"><span>'+badge(x.priority,x.priority==="high"?"red":x.priority==="medium"?"amber":"")+' '+esc(x.question)+'<div class="sub">'+esc(x.reason)+'</div></span></div>').join(""):"");
}
function pickerHtml(){
  const art=data.articles[curCase.pmid]||{}, have=new Set(curCase.data.events.map(e=>String((e.verbatim||{}).value||"").toLowerCase()));
  const cands=(art.events||[]).filter(e=>!have.has(e.term.toLowerCase()));
  return cands.length?'<div class="sub" style="margin-bottom:6px">Event picker: events detected in the article (red = important medical event). Click to add.</div><div class="chips" style="margin-bottom:10px">'+cands.map((e,i)=>'<button type="button" class="badge '+(e.ime?"red":"")+'" style="cursor:pointer" data-pickevent="'+esc(e.term)+'" title="'+esc((e.evidence||"")+(e.ime?" · "+e.ime.provenance:""))+'">+ '+esc(e.term)+'</button>').join("")+'</div>':"";
}
function caseForm(){
  const d=curCase.data, mine=gp;
  const products=d.products.map((p,i)=>'<div class="card" style="margin-bottom:10px;padding:12px"><div class="grid" style="display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">'+
    '<label>Role<select data-kind="field" data-path="products.'+i+'.role">'+["suspect","concomitant","interacting"].map(r=>'<option'+(p.role===r?" selected":"")+'>'+r+'</option>').join("")+'</select></label>'+
    caseInput("Product","products."+i+".name")+caseInput("Dose","products."+i+".dose")+caseInput("Frequency","products."+i+".frequency")+caseInput("Route","products."+i+".route")+caseInput("Indication","products."+i+".indication")+
    caseInput("Start date","products."+i+".start_date","date")+'<label class="check" style="align-self:end"><input type="checkbox" data-kind="flag" data-path="products.'+i+'.start_not_reported"'+(p.start_not_reported?" checked":"")+'>&nbsp;Start date not reported in the article (confirmed)</label>'+caseInput("Stop date","products."+i+".stop_date","date")+caseInput("Action taken","products."+i+".action_taken")+caseInput("Dechallenge","products."+i+".dechallenge")+caseInput("Rechallenge","products."+i+".rechallenge")+'</div></div>').join("");
  const events=d.events.map((e,i)=>'<div class="card" style="margin-bottom:10px;padding:12px"><div class="grid" style="display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">'+
    caseInput("Event (verbatim)","events."+i+".verbatim")+caseInput("Coded term (MedDRA, if licensed)","events."+i+".coded_term")+caseInput("Onset date","events."+i+".onset_date","date")+'<label class="check" style="align-self:end"><input type="checkbox" data-kind="flag" data-path="events.'+i+'.onset_not_reported"'+(e.onset_not_reported?" checked":"")+'>&nbsp;Onset date not reported (confirmed)</label>'+caseInput("Time to onset (as stated)","events."+i+".time_to_onset")+caseInput("Stop date","events."+i+".stop_date","date")+caseInput("Outcome","events."+i+".outcome")+caseInput("Expectedness","events."+i+".expectedness")+'</div>'+
    '<div class="sub" style="margin:10px 0 4px">MedDRA coding <button type="button" class="btn outline sm" data-codesuggest="'+i+'">Suggest coding</button> <span>Confirm against a licensed MedDRA source.</span></div><div style="display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">'+caseInput("LLT","events."+i+".llt")+caseInput("PT","events."+i+".pt")+caseInput("PT code","events."+i+".pt_code")+caseInput("HLT","events."+i+".hlt")+caseInput("HLGT","events."+i+".hlgt")+caseInput("SOC","events."+i+".soc")+caseInput("MedDRA version","events."+i+".meddra_version")+caseSelect("Coding status","events."+i+".coding_status",["","Proposed (IME list)","Proposed (earlier reviewed case)","Reviewed"])+'</div><div id="codesug'+i+'"></div>'+
    '<div class="sub" style="margin:12px 0 4px"><b>Causality assessment</b> for this event (WHO-UMC). The reviewer value is a suggestion until a medical reviewer confirms it.</div><div style="display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">'+caseSelect("Reporter causality","events."+i+".causality_reporter",[""].concat(data.config.whoUmc||[]).concat(["Not stated"]))+caseSelect("Reviewer causality (WHO-UMC)","events."+i+".causality_reviewer",[""].concat(data.config.whoUmc||[]))+caseSelect("Assessment method","events."+i+".causality_method",["","WHO-UMC","Naranjo","Other"])+caseSelect("Listedness / expectedness","events."+i+".listedness",["","Listed","Unlisted","Unknown"])+caseInput("Temporal relationship","events."+i+".temporal_relationship")+caseInput("Alternative causes","events."+i+".alternative_causes")+caseInput("Concomitant factors","events."+i+".concomitant_factors")+caseInput("Objective evidence","events."+i+".objective_evidence")+caseInput("Assessed reaction term","events."+i+".assessed_term")+caseInput("Reference safety information","events."+i+".rsi")+caseInput("Causality rationale","events."+i+".causality_rationale")+caseInput("Medical reviewer comment","events."+i+".reviewer_comment")+'</div>'+
    '<div class="chips" style="margin-top:8px">'+["serious","death","life_threatening","hospitalization","disability","congenital_anomaly","other_medically_important"].map(k=>'<label class="check"><input type="checkbox" data-kind="flag" data-path="events.'+i+'.seriousness.'+k+'"'+(e.seriousness[k]?" checked":"")+'>&nbsp;'+k.replace(/_/g," ")+'</label>').join("")+'</div></div>').join("");
  return '<h3 style="margin:0 0 8px">Patient</h3><div style="display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">'+caseInput("Identifier / initials","patient.identifier")+caseInput("Age","patient.age")+caseSelect("Age unit","patient.age_unit",["years","months","weeks","days","hours"])+caseSelect("Age group","patient.age_group",[""].concat(data.config.ageGroups||[]))+caseSelect("Sex","patient.sex",["","Male","Female","Unknown"])+caseInput("Weight (kg)","patient.weight")+caseSelect("Country where the event occurred","patient.country",[""].concat(data.config.countries||[]).concat(((gp(curCase.data,"patient.country")||{}).value&&!(data.config.countries||[]).includes(gp(curCase.data,"patient.country").value))?[gp(curCase.data,"patient.country").value]:[]))+'</div>'+
    '<label style="margin-top:10px">Medical history (one per line)<textarea id="casehist" rows="3">'+esc(d.patient.medical_history.map(h=>h.value).join("\\n"))+'</textarea></label>'+
    '<h3 style="margin:16px 0 8px">Reporter</h3><div style="display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">'+caseInput("Name / identifier","reporter.identifier")+caseSelect("Qualification","reporter.qualification",QUAL.includes((d.reporter.qualification||{}).value||"")?QUAL:QUAL.concat([d.reporter.qualification.value]))+caseSelect("Reporter country","reporter.country",[""].concat(data.config.countries||[]).concat(((d.reporter.country||{}).value&&!(data.config.countries||[]).includes(d.reporter.country.value))?[d.reporter.country.value]:[]))+caseInput("Contactable (how)","reporter.contactable")+caseInput("Organisation","reporter.organisation")+caseInput("Department","reporter.department")+caseInput("Address","reporter.address")+caseInput("E-mail","reporter.email")+caseInput("Phone","reporter.phone")+'</div>'+
    '<h3 style="margin:16px 0 8px">Sender</h3><div style="display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">'+caseSelect("Sender type","sender.type",["","Pharmaceutical company","Regulatory authority","Health professional","Regional pharmacovigilance centre","Patient or consumer","Other"])+caseInput("Organisation","sender.organisation")+caseInput("Contact name","sender.name")+caseInput("E-mail","sender.email")+caseInput("Phone","sender.phone")+caseInput("Country","sender.country")+'</div>'+
    '<h3 style="margin:16px 0 8px">Products <button type="button" class="btn outline sm" data-caseact="addprod">Add product</button></h3>'+products+
    '<h3 style="margin:16px 0 8px">Events <button type="button" class="btn outline sm" data-caseact="addevent">Add event</button></h3>'+pickerHtml()+events+
    '<h3 style="margin:16px 0 8px">Special situations</h3><div class="chips">'+SIT.map(x=>'<label class="check"><input type="checkbox" data-kind="situation" value="'+esc(x)+'"'+(d.special_situations.includes(x)?" checked":"")+'>&nbsp;'+esc(x)+'</label>').join("")+'</div>'+
    '<h3 style="margin:16px 0 8px">Treatment and confounding</h3><label>Treatment given for the event (one per line)<textarea id="casetreat" rows="2">'+esc((d.treatment_given||[]).join(NL))+'</textarea></label>'+
    '<label style="margin-top:10px">Confounders and other causes (one per line, as Type: text)<textarea id="caseconf" rows="3">'+esc((d.confounders||[]).map(c=>c.type+": "+c.text).join(NL))+'</textarea></label>'+
    '<h3 style="margin:16px 0 8px">General comments</h3><label>Comments from the reporter (what the authors concluded, e.g. their view on causality)<textarea id="casegeneral" rows="3">'+esc(d.general_comments||"")+'</textarea></label><label style="margin-top:10px">Comments from the sender<textarea id="casesendercomment" rows="3">'+esc(d.sender_comments||"")+'</textarea></label>'+
    '<label style="margin-top:14px">Source and abstract<textarea id="casesummary" rows="5">'+esc(d.source_summary)+'</textarea></label><label style="margin-top:10px">Reviewer notes<textarea id="casenotes" rows="2">'+esc(curCase.notes||"")+'</textarea></label>';
}
function renderCase(){
  curCase.data.events.forEach(e=>{const b=blankEvent();Object.keys(b).forEach(k=>{if(!(k in e))e[k]=b[k];});});
  {const d=curCase.data;d.sender=d.sender||{};["type","organisation","name","email","phone","address","country"].forEach(k=>{if(!d.sender[k])d.sender[k]=blankField();});["organisation","department","address","email","phone"].forEach(k=>{if(!d.reporter[k])d.reporter[k]=blankField();});if(!d.patient.age_group)d.patient.age_group=blankField();d.general_comments=d.general_comments||"";d.sender_comments=d.sender_comments||"";}
  const art=data.articles[curCase.pmid]||{};
  $("casehead").innerHTML='<div><b style="font-size:18px">'+esc(curCase.number)+'</b> <span class="sub">from PMID '+esc(curCase.pmid)+'</span><div class="sub">'+esc(art.title||"")+'</div></div><button type="button" class="btn outline sm" data-backtolit="1" title="Open the article in LiteraSift">Open article in LiteraSift</button><label style="min-width:240px">Status<select id="casestatus">'+data.config.caseStatuses.map(s=>'<option'+(s===curCase.status?" selected":"")+'>'+esc(s)+'</option>').join("")+'</select></label>';
  $("casebody").innerHTML=caseForm();
  $("caseassess").innerHTML=assessmentHtml(curAssess);
  $("caseerr").textContent="";
  $("casedel").style.display=data.viewer.role==="manager"?"":"none";
  $("casesign").dataset.id=curCase.id;$("casesign").textContent=(curCase.signatures||[]).some(x=>!x.superseded)?(curCase.signature_intact===false?"Signature: changed after signing":"Signed · view signature"):"Signature…";
}
let signCtx=null, codeSug={};
async function loadMemory(){
  const box=$("memorybox");if(!box)return;
  try{
    const r=await api("memory-list",{});
    box.innerHTML='<div class="row"><span><b>'+r.count+'</b> remembered coding'+(r.count===1?"":"s")+(r.clearedAt?' · cleared '+esc(new Date(r.clearedAt).toLocaleString()):"")+'</span><button class="btn outline sm" data-memdel="all"'+(r.count?"":" disabled")+'>Delete all coding memory</button></div>'+
      (r.entries.length?table(["Event as reported","Remembered PT","SOC","From case",""],r.entries.slice(0,100).map(e=>[esc(e.verbatim),esc(e.pt)+(e.pt_code?' <span class="sub">'+esc(e.pt_code)+'</span>':""),esc(e.soc),esc(e.case),'<button class="btn outline sm" data-memdel="'+esc(e.key)+'">Delete</button>']),""):'<div class="empty">Nothing remembered yet.</div>')+(r.count>100?'<p class="sub">Showing 100 of '+r.count+'.</p>':"");
  }catch(e){box.innerHTML='<div class="empty">'+esc(e.message)+'</div>';}
}
// For an article without a stored full text: a link through the user's library, and a way to supply the full text themselves.
function closedAccessHtml(art){
  const link=art.doi?"https://doi.org/"+art.doi:art.url||"", prefix=data.config.proxyPrefix||"";
  return '<div class="card" style="margin-top:12px;padding:12px"><div class="sub" style="margin-bottom:6px">'+(art.fullTextKey?"Replace the full text":"Closed access? Add the full text from your own access")+'</div><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">'+
    (prefix&&link?'<a class="btn outline sm" href="'+esc(prefix+link)+'" target="_blank" rel="noopener">Open with your institution</a>':"")+
    '<input type="file" id="ftfile" accept=".pdf,.xml,application/pdf" style="max-width:230px"><button type="button" class="btn sm" data-ftupload="'+esc(art.id)+'">Upload PDF or XML</button></div>'+
    '<details style="margin-top:8px"><summary class="sub" style="cursor:pointer">Or paste the text</summary><textarea id="ftpaste" rows="5" style="width:100%;margin-top:6px" placeholder="Paste the article text, including the case description"></textarea><button type="button" class="btn outline sm" data-ftpaste="'+esc(art.id)+'" style="margin-top:6px">Use pasted text</button></details>'+
    '<p class="sub" style="margin:8px 0 0">Use only text you are licensed to use. It is stored on your server, read for events and patient details, and added to Synchrony.</p></div>';
}
async function openSign(kind,id){
  $("signerr").textContent="";
  try{
    const pre=await api("sign-preview",{kind,id});signCtx={kind,id,pre};
    const hist=(pre.signatures||[]).map(sg=>'<div class="row" style="align-items:flex-start"><div><b>'+esc(sg.signer_name)+'</b> <span class="sub">'+esc(sg.signer_id)+'</span><div class="sub">'+esc(new Date(sg.signed_at).toLocaleString())+' · '+esc(sg.meaning_text)+'</div><div class="sub">Authentication: '+esc(sg.auth)+' · content '+esc(sg.content_sha256.slice(0,16))+'…</div>'+(sg.superseded?'<div class="sub">Superseded '+esc(new Date(sg.superseded.at).toLocaleString())+' by '+esc(sg.superseded.by)+': '+esc(sg.superseded.reason)+'</div>':'')+'</div>'+(sg.superseded?'<span class="badge">Superseded</span>':pre.intact===false?'<span class="badge red">Changed after signing</span>':'<span class="badge green">Valid</span>')+'</div>').join("");
    const active=(pre.signatures||[]).some(sg=>!sg.superseded);
    let form="";
    if(active){
      form=pre.manager?'<h3 style="margin:14px 0 6px">Supersede signature</h3><p class="sub">The signature stays in the record. Superseding unlocks the record so it can be corrected and signed again.</p><textarea id="signreason" rows="2" placeholder="Why is this signature being superseded? (at least 10 characters)" style="width:100%"></textarea><div style="margin-top:8px"><button class="btn outline" data-signgo="supersede">Supersede</button></div>':'<p class="sub" style="margin-top:12px">This record is signed. A manager can supersede the signature if it needs to change.</p>';
    }else if(pre.problems.length){
      form='<div style="margin-top:12px" class="sub"><b style="color:var(--red)">Cannot sign yet</b><ul>'+pre.problems.map(x=>"<li>"+esc(x)+"</li>").join("")+'</ul></div>';
    }else{
      form='<h3 style="margin:14px 0 6px">Sign</h3>'+(pre.meanings.length>1?'<label>Meaning<select id="signmeaning">'+pre.meanings.map(m=>'<option value="'+esc(m.code)+'"'+(m.code===pre.meaning?" selected":"")+'>'+esc(m.label)+'</option>').join("")+'</select></label>':"")+
        '<p style="margin:10px 0;font-size:14px" id="signstatement">'+esc(pre.statement)+'</p><div class="sub">Signing as '+esc(pre.signer.name)+' ('+esc(pre.signer.id)+') · the saved version of this record · content '+esc(pre.content_sha256.slice(0,16))+'…</div>'+
        (pre.reauth?'<label style="margin-top:10px">Confirm your password to sign<input id="signpw" type="password" autocomplete="current-password"></label>':'')+'<div style="margin-top:10px"><button class="btn" data-signgo="sign">Sign</button></div>';
    }
    $("signbody").innerHTML=(hist||'<p class="sub">Not signed yet.</p>')+form;
    if(!$("signdlg").open)$("signdlg").showModal();
    const sel=$("signmeaning");if(sel)sel.onchange=async()=>{const p2=await api("sign-preview",{kind,id,meaning:sel.value});signCtx.pre=p2;$("signstatement").textContent=p2.statement;};
  }catch(e){message(e.message,true);}
}
function openCaseData(c,a){curCase=JSON.parse(JSON.stringify(c));curAssess=a;renderCase();if(!$("casedlg").open)$("casedlg").showModal();}
async function downloadCase(format){
  collectCase();
  const res=await fetch("/api/case-export",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:curCase.id,format})});
  if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(e.error||"Export failed.");}
  const link=document.createElement("a");link.href=URL.createObjectURL(await res.blob());link.download=((/filename="([^"]+)"/.exec(res.headers.get("Content-Disposition")||"")||[])[1])||(curCase.number+(format==="package"?"-package.zip":".json"));link.click();setTimeout(()=>URL.revokeObjectURL(link.href),4000);
}
let libNumbers=null, libSortFor="", synFilter="all";
let extracting=null, pullRun="", libPath="/", auditData=null, auditMonth=new Date().toISOString().slice(0,7), auditQ="", auditAction="";
function drawAudit(){
  const box=$("auditbody");if(!box)return;
  if(!auditData){box.innerHTML='<div class="empty">Loading…</div>';return;}
  const q=auditQ.trim().toLowerCase();
  const rows=auditData.entries.filter(e=>(!auditAction||e.action.split(".")[0]===auditAction)&&(!q||(e.by+" "+e.action+" "+e.target+" "+e.detail).toLowerCase().includes(q)));
  const lv=auditData.lastVerification, vtext=lv?'Last full verification: '+esc(new Date(lv.at).toLocaleString())+' · '+(lv.ok?'passed ('+lv.checked+' entries)':'<b style="color:var(--red)">FAILED: '+esc(lv.reason||"")+'</b>'):'The whole chain has not been verified yet.';
  box.innerHTML='<div class="row" style="padding:0 0 10px;flex-wrap:wrap"><span>'+auditData.total+' entries in '+esc(auditData.month)+' · '+(auditData.verified?'<span class="badge green">This month is intact</span>':'<span class="badge red">This month was altered</span>')+(auditData.legacyEntries?' <span class="badge">'+auditData.legacyEntries+' earlier entries</span>':'')+'</span><span style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn outline sm" data-auditverify="1">Verify whole chain</button><button class="btn outline sm" data-auditanchor="get">Download anchor</button><button class="btn outline sm" data-auditanchor="check">Check an anchor</button><button class="btn outline sm" data-auditcsv="1">Export CSV</button></span></div><div class="sub" style="padding:0 0 10px" id="auditverdict">'+vtext+'</div>'+
    table(["#","Time","User","Action","Entity","Detail"],rows.slice(0,500).map(e=>['<span class="sub">'+(e.sequence==null?"earlier":e.sequence)+'</span>','<span class="sub">'+esc(new Date(e.at).toLocaleString())+'</span>',esc(e.by),'<span class="badge">'+esc(e.action)+'</span>',esc((e.entityType?e.entityType+" ":"")+e.target),'<span class="sub">'+esc(e.detail)+'</span>']),"No entries match.")+(rows.length>500?'<p class="sub">Showing 500 of '+rows.length+'. Narrow the filters or export the CSV.</p>':"");
}
async function loadAudit(){
  auditData=null;drawAudit();
  try{auditData=await api("audit",{month:auditMonth});}catch(e){message(e.message,true);auditData={month:auditMonth,total:0,verified:true,entries:[]};}
  drawAudit();
}
let libMode="range";
const libKeys=()=>libMode==="country"?["source","country","molecule"]:["source","molecule","range"];
const libIds=path=>{const parts=path==="/"?[]:path.split("/"),keys=libKeys();return [...new Set((data.library||[]).filter(e=>parts.every((p,i)=>e[keys[i]]===p)).map(e=>e.pmid))];};
function drawProgress(){
  const box=$("progress");if(!box)return;
  const runs=data.runs.filter(r=>r.status==="Imported"&&r.ids.length);
  if(!runs.length){box.innerHTML="";return;}
  const run=runs.find(r=>r.id===pullRun)||runs[0], st=runStats(run), got=st.pmc+st.epmc+st.unpaywall;
  const bar=(label,value,color)=>'<div class="row"><span>'+label+'</span><span class="sub">'+value+" / "+st.n+'</span></div><div class="bar"><i style="width:'+(st.n?Math.round(value/st.n*100):0)+'%"></i></div>';
  box.innerHTML=panel("Full-text extraction",'<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px"><select id="runpick" aria-label="Pull">'+runs.slice(0,15).map(r=>'<option value="'+esc(r.id)+'"'+(r.id===run.id?" selected":"")+'>'+esc((r.molecule||r.portfolio)+" · "+r.from+" → "+r.to+" ("+r.count+")")+'</option>').join("")+'</select>'+
    (extracting?'<button class="btn outline" id="extractstop">Stop</button><span class="sub" style="align-self:center">Working… '+got+' full texts so far</span>':'<button class="btn" id="extractgo">Extract full text now</button>')+
    '<button class="btn outline" data-zip="'+esc(run.id)+'">Download full texts (ZIP)</button><button class="btn outline" data-pdfrun="'+esc(run.id)+'">PDF with snapshots</button><button class="btn outline" data-cite="ris" data-scope="'+esc(run.id)+'">Citations (RIS)</button><button class="btn outline" data-cite="bibtex" data-scope="'+esc(run.id)+'">BibTeX</button></div>'+
    bar("Abstracts and metadata",st.abstracts)+bar("Open access checked (Unpaywall)",st.oaChecked)+bar("Retraction checked",st.retr)+
    '<div class="row"><span>Full text stored</span><b>'+got+'</b></div><div class="row"><span class="sub">PubMed Central '+st.pmc+' · Europe PMC '+st.epmc+' · Unpaywall '+st.unpaywall+'</span></div>'+
    '<div class="row"><span>Open access, link only (licence does not allow storing)</span><b>'+st.linkOnly+'</b></div><div class="row"><span>Closed access</span><b>'+st.closed+'</b></div><div class="row"><span>With key passages extracted</span><b>'+st.passages+'</b></div>',
    "Starts automatically after a pull. For each article: PubMed Central, then Europe PMC, then Unpaywall, stored only under open licences.")+'<div id="faers"></div>';
  loadFaers(run);
  $("runpick").onchange=e=>{pullRun=e.target.value;drawProgress();};
  if($("extractgo"))$("extractgo").onclick=()=>extractRun(run.id);
  if($("extractstop"))$("extractstop").onclick=()=>{if(extracting)extracting.stop=true;};
}
function rkAddRow(from,to){
  const row=document.createElement("div");row.className="rkrow";row.style.cssText="display:grid;gap:12px;grid-template-columns:100px 100px minmax(160px,1fr) auto;align-items:end;margin-bottom:8px";
  row.innerHTML='<label>From #<input type="number" min="1" class="rkf" value="'+(from||"")+'"></label><label>To #<input type="number" min="1" class="rkt" value="'+(to||"")+'"></label><label>Person<select class="rko">'+peopleOptions("","Choose…")+'</select></label><button type="button" class="btn outline sm" data-rkdel="1">Remove</button>';
  $("rkrows").appendChild(row);
}
const rkRanges=()=>[...document.querySelectorAll(".rkrow")].map(r=>({from:Number(r.querySelector(".rkf").value),to:Number(r.querySelector(".rkt").value),owner:r.querySelector(".rko").value})).filter(x=>x.from||x.to||x.owner);
const rkBody=()=>({watch:$("rkwatch").value,order:$("rkorder").value,pool:$("rkpool").value});
const faersCache={};
function drawFaers(key){
  const box=$("faers");if(!box)return;
  const f=faersCache[key];
  if(f==="loading"){box.innerHTML=panel("FDA adverse event reports (FAERS)",'<div class="empty">Loading…</div>');return;}
  if(!f||f.error||!f.result){box.innerHTML=panel("FDA adverse event reports (FAERS)",'<div class="empty">'+(f&&f.error?esc(f.error):"No reports found for this molecule's generic name.")+'</div>');return;}
  const top=f.result.reactions[0].count;
  box.innerHTML=panel("FDA adverse event reports (FAERS)",f.result.reactions.map(r=>'<div class="row"><span>'+esc(r.term)+'</span><span class="sub">'+r.count.toLocaleString()+'</span></div><div class="bar"><i style="width:'+Math.round(r.count/top*100)+'%"></i></div>').join(""),
    "Most reported reactions for "+esc(f.result.name)+(f.result.total?" across "+f.result.total.toLocaleString()+" reports":"")+". Spontaneous reports only: they show what is reported, not how often a reaction occurs or whether the drug caused it. Source: openFDA.");
}
function loadFaers(run){
  const names=[run.molecule,...[...String(run.query||"").matchAll(/"([^"]+)"\\[tiab\\]/g)].map(m=>m[1])].filter(Boolean);
  const key=[...new Set(names.map(n=>n.toLowerCase()))].join("|");
  if(!key)return;
  if(faersCache[key]){drawFaers(key);return;}
  faersCache[key]="loading";drawFaers(key);
  api("faers",{names:[...new Set(names)]}).then(r=>{faersCache[key]=r;}).catch(e=>{faersCache[key]={error:e.message};}).finally(()=>drawFaers(key));
}
async function extractRun(runId){
  if(extracting)return;
  const run=data.runs.find(r=>r.id===runId);if(!run)return;
  extracting={stop:false};drawProgress();
  let previous=Infinity,stalled=0;
  try{
    for(let i=0;i<1000&&!extracting.stop;i++){
      const r=await api("evidence",{ids:run.ids});
      const st=await api("state");data.articles=st.articles;data.assignments=st.assignments;data.runs=st.runs;drawProgress();
      if(!r.queued)break;
      stalled=r.queued>=previous?stalled+1:0;previous=r.queued;
      if(stalled>=4)break;
    }
  }catch(e){message(e.message,true);}
  extracting=null;drawProgress();
}
let data, tab, active, filt={q:"",status:"",portfolio:"",oa:"",ft:"",sort:"relevance",source:"",country:"",ime:""}, shown=[];
const NL=String.fromCharCode(10);
const tbadge=(text,color,title)=>'<span class="badge '+(color||"")+'" title="'+esc(title||"")+'">'+esc(text)+'</span>';
function factsHtml(f,mols){
  if(!f)return "";
  const p=f.patient||{}, row=(k,v,ev)=>v?'<div class="row" style="align-items:flex-start"><span class="sub" style="min-width:120px">'+k+'</span><span>'+v+(ev?'<div class="sub">“'+esc(ev)+'”</div>':"")+'</span></div>':"";
  const age=p.age?p.age+" "+(p.age_unit||"years"):(p.age_group||"");
  const min=f.minimum||{}, tick=(ok,t)=>tbadge((ok?"✓ ":"✗ ")+t,ok?"green":"amber","");
  return '<div class="sub" style="margin:10px 0 4px">Case facts read from the article (proposals, not confirmed)</div>'+
    row("Patient",esc([age,p.sex,p.weight?p.weight+" kg":"",p.pregnancy?"pregnant"+(p.gestation_weeks?" ("+p.gestation_weeks+" weeks)":""):""].filter(Boolean).join(" · "))+((p.history||[]).length?'<div class="sub">History: '+esc(p.history.join("; "))+'</div>':""),p.evidence)+
    row("Action taken",f.actionTaken?esc(f.actionTaken.value):"",f.actionTaken&&f.actionTaken.evidence)+
    row("Dechallenge",f.dechallenge?(f.dechallenge.confounded?tbadge(f.dechallenge.value,"amber","Treatment was given, so the improvement may not be due to stopping the drug"):esc(f.dechallenge.value)):"",f.dechallenge&&f.dechallenge.evidence)+
    row("Rechallenge",f.rechallenge?esc(f.rechallenge.value):"",f.rechallenge&&f.rechallenge.evidence)+
    row("Treatment given",(f.treatment||[]).map(t=>esc(t.text)).join(", "),(f.treatment||[])[0]&&f.treatment[0].evidence)+
    row("Concomitant drugs",(f.concomitants||[]).map(c=>esc(c.name)).join(", "),(f.concomitants||[])[0]&&f.concomitants[0].evidence)+
    row("Confounders",(f.confounders||[]).map(c=>esc(c.type+": "+c.text)).join("<br>"),"")+
    '<div class="chips" style="margin-top:6px">'+tick(min.patient,"Patient")+tick(min.reporter,"Reporter")+tick(min.drug,"Suspect drug")+tick(min.event,"Event")+tbadge(min.verdict||"","blue","")+(f.series?tbadge("Case series: one ICSR per patient","amber",""):"")+'</div>';
}
const levelColor={High:"red",Medium:"amber",Low:""};
const artCountry=a=>(a&&a.patientCountry&&a.patientCountry.name)||(a&&a.affiliationCountry)||(a&&a.journalCountry)||"";
const artCountryBasis=a=>a&&a.patientCountry&&a.patientCountry.name?"patient (from the abstract)":a&&a.affiliationCountry?"first author affiliation":a&&a.journalCountry?"journal":"";
const maColor={Authorised:"green",Withdrawn:"red","Not authorised":"red","Under review":"amber"};
const maOf=(molecule,country)=>(data.config.ma||[]).find(e=>e.molecule.toLowerCase()===String(molecule||"").toLowerCase()&&e.country===country);
const maChip=(molecules,country)=>{if(!(data.config.ma||[]).length||!country)return "";const m=(molecules||[])[0],e=maOf(m,country);
  return e?'<span class="badge '+(maColor[e.status]||"")+'" title="'+esc((e.mah?e.mah+" · ":"")+(e.number||"")+" · marketing authorisation in "+country)+'">MA '+esc(e.status)+'</span>':'<span class="badge" title="No marketing-authorisation record for '+esc(m||"")+' in '+esc(country)+'">No MA record</span>';};
const eventChips=a=>((a&&a.events)||[]).slice(0,4).map(e=>'<span class="badge '+(e.ime?"red":"")+'" title="'+esc((e.ime?e.ime.provenance+(e.ime.code?" (PT "+e.ime.code+")":"")+". ":"")+(e.kinds||[]).join(", ")+(e.evidence?". “"+e.evidence+"”":""))+'">'+(e.ime?"IME · ":"")+esc(e.term)+'</span>').join("");
const sourceOf=a=>(a&&a.source)||"PubMed";
const sourceBadge=a=>{const k=sourceOf(a);return '<span class="badge '+(k==="PubMed"?"blue":"amber")+'" title="'+esc(((data.config.sources||[]).find(x=>x.id===k)||{}).label||k)+'">'+esc(k)+'</span>';};
const relevanceCell=a=>'<span class="badge '+(levelColor[a.level]||"")+'" title="'+esc((a.why||[]).join(" · "))+'">'+esc(a.level||"")+" "+(a.score??"")+'</span>'+((a.why||[]).length?'<div class="sub" style="margin-top:4px;max-width:170px">'+esc(a.why.slice(0,2).join(" · "))+'</div>':"");
const oaColor={gold:"green",diamond:"green",hybrid:"blue",green:"blue",bronze:"amber",closed:""};
const oaLabel=a=>a.oaStatus?(a.oaStatus==="closed"?"Closed access":["No DOI","Not in Unpaywall"].includes(a.oaStatus)?a.oaStatus:"OA · "+a.oaStatus):"";
const peopleOptions=(selected="",blank="")=>(blank?'<option value="">'+blank+'</option>':"")+data.profiles.filter(p=>p.active).map(p=>'<option value="'+esc(p.email)+'"'+(p.email===selected?" selected":"")+'>'+esc(p.name+" ("+p.role+")")+'</option>').join("");
const ftGroup=a=>a.fullTextKey?"stored":a.fullTextLink?"link":"none";
const oaGroup=a=>!a.oaCheckedAt?"unchecked":a.oaIsOpen?"open":"closed";
let toastTimer;
const message = (value, error=false) => { const t=$("toast"); t.textContent=value; t.className="show"+(error?" err":""); clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.className="",error?6000:2800); };
async function api(route, body) {
  const res = await fetch(route.startsWith("/")?route:"/api/"+route, body === undefined ? {} : {
    method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || "Request failed.");
  return result;
}
const table=(headers,rows,empty)=>rows.length?
  '<div class="tablewrap"><table><thead><tr>'+headers.map(h=>"<th>"+h+"</th>").join("")+"</tr></thead><tbody>"+
  rows.map(row=>"<tr>"+row.map(cell=>"<td>"+cell+"</td>").join("")+"</tr>").join("")+"</tbody></table></div>":
  '<div class="empty">'+empty+"</div>";
const panel=(title,body,sub,flush)=>"<section><header><h2>"+title+"</h2>"+(sub?"<p>"+sub+"</p>":"")+"</header><div class='body'"+(flush?" style='padding:8px 0 0'":"")+">"+body+"</div></section>";
const statusColor={"Pending":"","In review":"blue","Full text needed":"amber","Complete":"green"};
function mark(text,molecules,extra){
  const names=(molecules||[]).filter(Boolean), terms=(data.config.terms||[]).concat((extra||[]).filter(t=>String(t).length>2),names);
  if(!terms.length)return esc(text);
  const re=new RegExp("\\\\b("+terms.map(t=>t.replace(/[.*+?^()|\\[\\]\\\\]/g,"\\\\$&")).join("|")+")","gi");
  return String(text).split(re).map((part,i)=>i%2?'<mark class="'+(names.some(n=>n.toLowerCase()===part.toLowerCase())?"mol":"ae")+'">'+esc(part)+"</mark>":esc(part)).join("");
}
const badge=(text,color="")=>'<span class="badge '+color+'">'+esc(text)+'</span>';
const flagged=item=>["Retracted","Expression of concern"].includes(item?.retractionStatus);
function evidenceChips(item){
  const chips=[sourceBadge(item)];
  const ctry=artCountry(item);
  if(ctry)chips.push('<span class="badge" title="Country from '+esc(artCountryBasis(item))+'">'+esc(ctry)+'</span>');
  if(ctry&&(item.molecules||item._molecules))chips.push(maChip(item._molecules,ctry));
  const cf=item.caseFacts;
  if(cf){
    if(cf.minimum&&cf.minimum.verdict==="Valid ICSR candidate")chips.push(tbadge("ICSR candidate","blue","Patient, reporter, suspect drug and event are all present"));
    if(cf.dechallenge&&cf.dechallenge.result==="Positive")chips.push(tbadge("DC +"+(cf.dechallenge.confounded?" (confounded)":""),cf.dechallenge.confounded?"amber":"green",cf.dechallenge.evidence));
    if(cf.rechallenge&&cf.rechallenge.result==="Positive")chips.push(tbadge("RC +","green",cf.rechallenge.evidence));
  }
  if(flagged(item))chips.push(badge(item.retractionStatus,"red"));
  else if(item.retractionStatus==="Correction")chips.push(badge("Correction","amber"));
  if(item.citedBy!==undefined)chips.push(badge("Cited "+item.citedBy+"×"));
  if(item.oaStatus)chips.push('<span class="badge '+(oaColor[item.oaStatus]||"")+'" title="'+esc((item.oaLicense?"Licence: "+item.oaLicense+". ":"")+(item.oaVersion?"Version: "+item.oaVersion+". ":"")+(item.oaHostType?"Host: "+item.oaHostType+".":""))+'">'+esc(oaLabel(item))+'</span>');
  if(!item.fullTextKey)(item.linkOut||[]).filter(l=>l.free).slice(0,2).forEach(l=>chips.push('<a class="badge green" target="_blank" rel="noopener" href="'+esc(l.url)+'" title="Free full text via PubMed LinkOut">Free: '+esc(String(l.provider).slice(0,28))+'</a>'));
  if(!item.fullTextKey&&!item.fullTextLink&&item.doi)chips.push('<a class="badge blue" target="_blank" rel="noopener" href="'+esc("https://doi.org/"+encodeURI(item.doi))+'" title="Opens the publisher page; use your own subscription if you have one">Publisher page</a>');
  if(item.fullTextKey&&item.fullTextRestricted)chips.push('<span class="badge amber" title="Open-access copy under a restrictive licence: internal screening use only">Restricted licence'+(item.fullTextLicense?" · "+esc(item.fullTextLicense):"")+'</span>');
  chips.push(item.fullTextKey?'<a class="badge green" href="/api/full-text/'+esc(item.id)+'">Full text</a>':item.fullTextLink?'<a class="badge blue" target="_blank" rel="noopener" href="'+esc(item.fullTextLink)+'">Open-access link</a>':badge(item.fullTextStatus||"Full text pending"));
  chips.push(item.screenshotKey?'<a class="badge green" href="/api/screenshot/'+esc(item.id)+'">Screenshot</a>':badge(item.screenshotStatus||"Screenshot pending"));
  return '<div class="chips">'+chips.join("")+"</div>";
}
function queueRows(items){
  return table((libNumbers?["No."]:[]).concat(["Article","Relevance","Portfolio","Reviewer","Status",""]),items.slice(0,200).map(a=>{
    const item=data.articles[a.pmid]||{};
    item._molecules=a.molecules;
    return (libNumbers?['<b>'+esc(libNumbers[a.pmid]||"")+'</b>']:[]).concat(['<a class="title" target="_blank" rel="noopener" href="'+esc(item.url)+'">'+esc(item.title)+'</a><div class="sub">PMID '+esc(a.pmid)+' · '+esc(item.journal)+' · '+esc(item.date)+((item.authors||[]).length?' · '+esc(item.authors.slice(0,3).join(", ")+(item.authors.length>3?" et al.":"")):"")+'</div>'+evidenceChips({...item,id:a.pmid})+
        (eventChips(item)?'<div class="chips" style="margin-top:6px"><span class="sub">Events:</span>'+eventChips(item)+'</div>':"")+
        (item.abstract?'<details class="abs"><summary>Abstract</summary><div>'+mark(item.abstract.slice(0,2500),a.molecules,(item.entities||{}).diseases)+'</div></details>':"")+
        (((item.entities||{}).diseases||[]).length?'<div class="sub" style="margin-top:6px">Conditions mentioned: '+esc(item.entities.diseases.slice(0,5).join(", "))+'</div>':""),
      relevanceCell(a),
      esc(a.portfolio)+((a.molecules||[]).length?'<div class="chips">'+a.molecules.map(m=>badge(m)).join("")+"</div>":""),
      a.reviewer?esc(a.reviewer):badge("Unassigned","amber"),badge(a.status,statusColor[a.status]),
      '<button class="btn outline sm" data-review="'+esc(a.id)+'">Review</button>']);
  }),"No articles match.")+(items.length>200?'<p class="sub" style="padding:10px 14px">Showing 200 of '+items.length+". Refine the filters to narrow the list.</p>":"");
}
function queueView(items){
  shown=items;
  const portfolios=[...new Set(items.map(a=>a.portfolio))].sort();
  return '<section><div class="filters"><input data-filter="q" placeholder="Search title, PMID, molecule…" value="'+esc(filt.q)+'" aria-label="Search">'+
    '<select data-filter="status" aria-label="Status"><option value="">All statuses</option>'+["Pending","In review","Full text needed","Complete"].map(s=>'<option'+(filt.status===s?" selected":"")+'>'+s+"</option>").join("")+"</select>"+
    '<select data-filter="oa" aria-label="Access"><option value="">All access</option>'+[["open","Open access"],["closed","Closed access"],["unchecked","Not yet checked"]].map(([v,l])=>'<option value="'+v+'"'+(filt.oa===v?" selected":"")+'>'+l+"</option>").join("")+"</select>"+
    '<select data-filter="ft" aria-label="Full text"><option value="">All full-text states</option>'+[["stored","Full text stored"],["link","Open-access link only"],["none","No full text"]].map(([v,l])=>'<option value="'+v+'"'+(filt.ft===v?" selected":"")+'>'+l+"</option>").join("")+"</select>"+
    '<button class="btn outline" data-pdf="queue" title="Download the filtered list as a PDF with a snapshot of each article">Export PDF</button><button class="btn outline" data-zip="queue" title="Download stored full texts for the filtered list as a ZIP">Full texts (ZIP)</button><button class="btn outline" data-cite="ris" data-scope="queue" title="Citations for EndNote, Zotero or Mendeley">Citations (RIS)</button><button class="btn outline" data-retrieval="csv" title="CSV of the listed articles that have no stored full text, with DOI links, for a library or document-delivery request">Retrieval list (CSV)</button><button class="btn outline" data-retrieval="flag" title="Set the listed articles without stored full text to Full text needed">Flag for manual retrieval</button>'+
    '<select data-filter="country" aria-label="Country"><option value="">All countries</option>'+[...new Set(items.map(a=>artCountry(data.articles[a.pmid])||"Unknown"))].sort().map(c=>'<option'+(filt.country===c?" selected":"")+'>'+esc(c)+'</option>').join("")+'</select>'+
    '<select data-filter="ime" aria-label="Important medical events"><option value="">All events</option><option value="ime"'+(filt.ime==="ime"?" selected":"")+'>Important medical events only</option><option value="icsr"'+(filt.ime==="icsr"?" selected":"")+'>ICSR candidates only</option></select>'+
    '<select data-filter="source" aria-label="Source"><option value="">All sources</option><option value="pubmed"'+(filt.source==="pubmed"?" selected":"")+'>PubMed only</option><option value="agency"'+(filt.source==="agency"?" selected":"")+'>Government agencies</option></select>'+
    '<select data-filter="sort" aria-label="Sort"><option value="relevance"'+(filt.sort==="relevance"?" selected":"")+'>Sort: most relevant</option><option value="newest"'+(filt.sort==="newest"?" selected":"")+'>Sort: newest</option><option value="oldest"'+(filt.sort==="oldest"?" selected":"")+'>Sort: oldest</option>'+(libNumbers?'<option value="number"'+(filt.sort==="number"?" selected":"")+'>Sort: library number</option>':"")+'</select>'+
    '<select data-filter="portfolio" aria-label="Portfolio"><option value="">All portfolios</option>'+portfolios.map(p=>'<option'+(filt.portfolio===p?" selected":"")+'>'+esc(p)+"</option>").join("")+"</select></div>"+
    '<div id="qtable">'+queueRows(applyFilter(items))+"</div></section>";
}
function applyFilter(items){
  const q=filt.q.trim().toLowerCase();
  const pm=a=>Number(a.pmid)||0, num=a=>libNumbers?libNumbers[a.pmid]||0:0;
  const order=filt.sort==="number"&&libNumbers?(x,y)=>num(x)-num(y):filt.sort==="newest"?(x,y)=>pm(y)-pm(x):filt.sort==="oldest"?(x,y)=>pm(x)-pm(y):(x,y)=>(y.score||0)-(x.score||0)||pm(y)-pm(x);
  return items.filter(a=>(!filt.status||a.status===filt.status)&&(!filt.portfolio||a.portfolio===filt.portfolio)&&(!filt.oa||oaGroup(data.articles[a.pmid]||{})===filt.oa)&&(!filt.ft||ftGroup(data.articles[a.pmid]||{})===filt.ft)&&(!filt.source||(filt.source==="pubmed")===(sourceOf(data.articles[a.pmid])==="PubMed"))&&(!filt.country||(artCountry(data.articles[a.pmid])||"Unknown")===filt.country)&&(!filt.ime||(filt.ime==="ime"?(data.articles[a.pmid]&&data.articles[a.pmid].imeCount>0):(data.articles[a.pmid]&&data.articles[a.pmid].caseFacts&&data.articles[a.pmid].caseFacts.minimum.verdict==="Valid ICSR candidate")))&&
    (!q||(a.pmid+" "+(data.articles[a.pmid]?.title||"")+" "+(a.molecules||[]).join(" ")).toLowerCase().includes(q))).sort(order);
}
function stat(label,value,icon,warn){return '<div class="card'+(warn&&value?" warn":"")+'"><div class="lbl">'+label+ic(icon)+'</div><b data-count="'+value+'">0</b></div>';}
function render() {
  const manager=data.viewer.role==="manager";
  const tabs=(manager?["Overview","Search & Pull","Library","My Queue","All Assignments","Synchrony","Batches","Watchlists","Team","Audit","Settings"]:["My Queue","Synchrony"]).concat(data.config.accounts?["Account"]:[]);
  if(!tabs.includes(tab))tab=tabs[0];
  libNumbers=null;
  const items=data.assignments, mine=items.filter(a=>a.reviewer===data.viewer.email);
  const open=mine.filter(a=>a.status!=="Complete").length;
  $("identity").innerHTML="<b>"+esc(data.viewer.name)+"</b><small>"+esc(data.viewer.email)+" · "+esc(data.viewer.role)+"</small>";
  $("nav").innerHTML=tabs.map(x=>'<button class="navbtn" data-tab="'+x+'" '+(x===tab?'aria-current="page"':'')+'>'+ic(x)+x+(x==="My Queue"&&open?'<span class="n">'+open+"</span>":"")+'</button>').join("");
  $("heading").textContent=tab; $("subhead").textContent=subtitles[tab];
  const watchOptions=data.watches.map(w=>'<option value="'+esc(encodeURIComponent(w.portfolio)+"|"+encodeURIComponent(w.molecule||""))+'">'+esc(w.portfolio+(w.molecule?" · "+w.molecule:""))+'</option>').join("");
  let html="";
  if(tab==="Overview"){
    const done=items.filter(a=>a.status==="Complete").length, pct=items.length?Math.round(done/items.length*100):0;
    const arts=Object.values(data.articles);
    const alerts=arts.filter(flagged).length, retry=arts.filter(a=>a.fullTextStatus==="Retry needed").length;
    const portfolios=[...new Set(items.map(a=>a.portfolio))].sort();
    const checkedOa=arts.filter(a=>a.oaCheckedAt), openOa=checkedOa.filter(a=>a.oaIsOpen);
    const oaCounts={};checkedOa.forEach(a=>{oaCounts[a.oaStatus]=(oaCounts[a.oaStatus]||0)+1;});
    html='<div class="cards">'+stat("Unique citations",arts.length,"Batches")+stat("Assigned",items.filter(a=>a.reviewer).length,"Team")+stat("Unassigned",items.filter(a=>!a.reviewer).length,"alert",true)+stat("Complete",done,"My Queue")+stat("Retraction alerts",alerts,"alert",true)+stat("Open access %",checkedOa.length?Math.round(openOa.length/checkedOa.length*100):0,"Watchlists")+'</div>'+
      '<div class="grid2">'+panel("Screening progress",'<div class="row"><span>'+done+" of "+items.length+' complete</span><b>'+pct+'%</b></div><div class="bar"><i data-width="'+pct+'"></i></div>'+
        portfolios.map(p=>{const list=items.filter(a=>a.portfolio===p),d=list.filter(a=>a.status==="Complete").length;return '<div class="row"><span>'+esc(p)+'</span><span class="sub">'+d+" / "+list.length+"</span></div>";}).join(""))+
      panel("By source",(data.config.sources||[]).map(x=>{const n=arts.filter(a=>sourceOf(a)===x.id).length;return '<div class="row"><span>'+esc(x.label)+(x.active?"":' <span class="sub">(not enabled)</span>')+'</span><b>'+n+'</b></div>';}).join(""),"PubMed articles are kept separate from government agency material everywhere: queues, Library folders and exports.")+
      panel("Open access (Unpaywall)",data.config.unpaywall?(checkedOa.length?Object.entries(oaCounts).sort((x,y)=>y[1]-x[1]).map(([k,v])=>'<div class="row"><span>'+badge(oaLabel({oaStatus:k}),oaColor[k]||"")+'</span><span class="sub">'+v+" · "+Math.round(v/checkedOa.length*100)+'%</span></div>').join("")+'<div class="row"><span class="sub">'+(arts.length-checkedOa.length)+' not yet checked</span></div>':'<div class="empty">Checks start with the next evidence run.</div>'):'<div class="empty">Add a contact email under Settings to turn on Unpaywall.</div>')+
      panel("Needs attention",
        '<div class="row"><span>Unassigned citations</span>'+badge(items.filter(a=>!a.reviewer).length,items.some(a=>!a.reviewer)?"amber":"")+'</div>'+
        '<div class="row"><span>Retracted or expression of concern</span>'+badge(alerts,alerts?"red":"")+'</div>'+
        (data.config.unpaywall?'':'<div class="row"><span>Unpaywall is not configured</span>'+badge("Settings","amber")+'</div>')+
        '<div class="row"><span>Full-text fetch needs retry</span>'+badge(retry,retry?"amber":"")+'</div>'+
        '<div class="row"><span>Flagged “Full text needed” by reviewers</span>'+badge(items.filter(a=>a.status==="Full text needed").length,"blue")+'</div>')+'</div>'+
      panel("Recent batches",table(["Watchlist","Range","Citations","Status"],data.runs.slice(0,6).map(r=>[esc(r.portfolio+(r.molecule?" · "+r.molecule:"")),esc(r.from)+" → "+esc(r.to),r.count,badge(r.error||r.status,r.status==="Imported"?"green":"red")]),"No batches yet."),"",true);
  }
  if(tab==="Search & Pull"){
    const today=new Date().toISOString().slice(0,10), start=new Date(Date.now()-30*864e5).toISOString().slice(0,10);
    html=panel("Pull articles from PubMed",'<form class="grid" data-route="pull"><label>Molecule<input name="molecule" required placeholder="e.g. aciclovir"></label><label>Synonyms, brands (optional)<input name="synonyms" placeholder="acyclovir, Zovirax"></label><label>From<input name="from" type="date" required value="'+start+'" max="'+today+'"></label><label>Through<input name="to" type="date" required value="'+today+'" max="'+today+'"></label><label>Portfolio (optional)<input name="portfolio" placeholder="Defaults to the molecule name"></label><label>Assign to<select name="owner">'+peopleOptions("","Auto-assign")+'</select></label><label class="check"><input type="checkbox" name="safety">&nbsp;Safety-related articles only</label><div class="wide" style="display:flex;gap:16px;flex-wrap:wrap;grid-column:1/-1"><span class="sub">Narrow with PubMed filters:</span><label class="check"><input type="checkbox" name="humans">&nbsp;Humans only</label><label class="check"><input type="checkbox" name="caseReports">&nbsp;Case reports only</label><label class="check"><input type="checkbox" name="english">&nbsp;English only</label><label class="check"><input type="checkbox" name="noReviews">&nbsp;Exclude reviews</label></div><div><button class="btn">Pull articles</button> <button type="button" class="btn outline" data-suggest="1">Suggest synonyms &amp; brands</button></div></form><div id="suggest"></div>',"Searches PubMed by the date each article was added, saves the molecule as a watchlist so new articles keep arriving daily, and assigns the results to reviewers.")+'<div id="progress"></div>'+
      panel("Batch by PMID list",'<form class="grid" data-route="pmid-batch"><label class="wide">PMIDs (one per line, optionally followed by a name; or comma separated)<textarea name="text" rows="5" required placeholder="123456  Smith_2020&#10;789012  Jones_2021&#10;345678,901234"></textarea></label><label>Portfolio<input name="portfolio" required list="pfopts" placeholder="Type or choose"><datalist id="pfopts">'+[...new Set((data.watches||[]).map(w=>w.portfolio))].map(p=>'<option value="'+esc(p)+'">').join("")+'</datalist></label><label>Molecule (optional)<input name="molecule"></label><div><button class="btn">Add and fetch full texts</button></div></form>',"For lists of articles you already have: each PMID is read from PubMed, enters the screening queue and Synchrony like any other article, and its full text is looked up in every open source. Afterwards, Recent pulls offers a list of the PMIDs that could not be fetched, in the same format, to try again once you have the files.")+
      panel("Patient-reported posts",'<form class="grid" data-route="social-add"><label class="wide">Post text (several posts: separate with a line of three dashes)<textarea name="text" rows="5" required placeholder="Paste a patient or forum post that mentions a medicine and a problem"></textarea></label><label>Platform<select name="platform"><option>Reddit</option><option>X (Twitter)</option><option>Facebook</option><option>Patient forum</option><option>Other</option></select></label><label>Link to the post (optional)<input name="url" placeholder="https://"></label><label>Posted on (optional)<input name="postedAt" type="date"></label><label>Portfolio<input name="portfolio" required list="pfopts" placeholder="Type or choose"></label><label>Molecule (optional)<input name="molecule"></label><div><button class="btn">Add posts</button></div></form>',"Names, e-mail addresses, phone numbers, handles, links and ID numbers are masked before anything is stored. Posts are added by hand, never collected automatically: platform terms and privacy law restrict that. Each post is screened for events like an article, with a confidence and the reasons for it, and can become a Synchrony case marked as a patient report. Social reports are unverified and the reporter cannot be contacted.")+
      panel("Recent pulls",table(["Watchlist","Date range","Citations","Status",""],data.runs.slice(0,8).map(r=>[esc(r.portfolio+(r.molecule?" · "+r.molecule:"")),esc(r.from)+" → "+esc(r.to),r.count,badge(r.error||r.status,r.status==="Imported"?"green":"red"),r.status==="Imported"?'<button class="btn outline sm" data-pdfrun="'+esc(r.id)+'">PDF with screenshots</button>'+(String(r.query||"").startsWith("PMID list")?' <button class="btn outline sm" data-unfetched="'+esc(r.id)+'">Unfetched list (TSV)</button>':"")+(data.config.accounts?' <a class="btn outline sm" href="/host/run-tiles?run='+encodeURIComponent(r.id)+'" target="_blank" rel="noopener">Tile screenshot</a>':""):""]),"No pulls yet."),"",true);
  }
  if(tab==="Synchrony"){
    const me=data.viewer.email, all=(data.cases||[]).slice().sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)), today=new Date().toISOString().slice(0,10);
    const closed=c=>c.status==="Sent to PV Nexus"||c.status==="Closed: not a valid ICSR", openCases=all.filter(c=>!closed(c));
    const left=c=>c.dueAt?Math.round((Date.parse(c.dueAt)-Date.parse(today))/864e5):null;
    const signed=c=>(c.signatures||[]).some(x=>!x.superseded);
    const filters={all:["Open",openCases],mine:["Mine",openCases.filter(c=>c.assignee===me)],unassigned:["Unassigned",openCases.filter(c=>!c.assignee)],overdue:["Overdue",openCases.filter(c=>left(c)!==null&&left(c)<0)],soon:["Due in 3 days",openCases.filter(c=>left(c)!==null&&left(c)>=0&&left(c)<=3)],review:["Ready for review",openCases.filter(c=>c.status==="Ready for medical review")],signed:["Signed",all.filter(signed)],done:["Closed or sent",all.filter(closed)]};
    if(!filters[synFilter])synFilter="all";
    const shown=filters[synFilter][1], stColor={"Ready for medical review":"blue","Sent to PV Nexus":"green"}, manager=data.viewer.role==="manager";
    const people=(data.profiles||[]).filter(p=>p.active);
    const tiles='<div style="display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));margin-bottom:14px">'+Object.entries(filters).map(([k,f])=>'<button type="button" class="card" data-synfilter="'+k+'" style="text-align:left;cursor:pointer;padding:10px 12px;'+(k===synFilter?"border-color:var(--ring);box-shadow:0 0 0 2px #0f766e33":"")+(k==="overdue"&&f[1].length?";border-color:var(--red)":"")+'"><div class="sub">'+esc(f[0])+'</div><div style="font-size:22px;font-weight:600">'+f[1].length+'</div></button>').join("")+'</div>';
    const ready=Object.values(data.articles).filter(a=>a.fullTextStatus==="Captured"&&a.fullTextKey&&(a.events||[]).length&&!(data.cases||[]).some(c=>c.pmid===a.id)).length;
    const intake='<div class="row"><span>'+ready+' article'+(ready===1?"":"s")+' with stored full text and detected events '+(ready===1?"is":"are")+' not in Synchrony yet.'+(data.config.autoIcsr?' New ones are added automatically.':' Automatic adding is off (Settings).')+'</span><button class="btn" data-icsrintake="1"'+(ready?"":" disabled")+'>Add to Synchrony</button></div>'+
      '<div class="row"><span>'+openCases.filter(c=>!c.assignee).length+' open case'+(openCases.filter(c=>!c.assignee).length===1?"":"s")+' without an assignee.'+(data.config.autoAssignCases?' New cases are assigned automatically to the reviewer with the fewest open cases.':' Automatic assignment is off (Settings).')+'</span>'+(manager?'<button class="btn outline" data-autoassign="1">Assign unassigned now</button>':"")+'</div>'+
      '<div class="row"><span>Export the cases shown in this list.</span><span style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn outline sm" data-synexport="csv">Line listing (CSV)</button><button class="btn outline sm" data-synexport="e2b">E2B(R3) batch (XML)</button></span></div>';
    const rows=shown.map(c=>{
      const a=c.assessment||{},d=c.data,sp=(d.products.find(p=>p.role==="suspect")||{name:{}}).name.value||"—",ev=((d.events[0]||{}).verbatim||{}).value||"—",art=data.articles[c.pmid]||{},dl=left(c);
      const who=manager?'<select data-assignsel="'+esc(c.id)+'" aria-label="Assignee"><option value="">Unassigned</option>'+people.map(p=>'<option value="'+esc(p.email)+'"'+(p.email===c.assignee?" selected":"")+'>'+esc(p.name||p.email)+'</option>').join("")+'</select>':esc(((data.profiles||[]).find(p=>p.email===c.assignee)||{}).name||c.assignee||"Unassigned");
      const due=c.dueAt?badge((dl<0?Math.abs(dl)+" d overdue":dl===0?"due today":dl+" d left")+" · "+c.dueAt,closed(c)?"":dl<0?"red":dl<=3?"amber":"green"):'<span class="sub">no date</span>';
      return ['<b>'+esc(c.number)+'</b>'+(signed(c)?' <span class="badge green" title="Signed">signed</span>':""),'<a href="'+esc(art.url||"#")+'" target="_blank" rel="noopener">'+esc((art.title||"PMID "+c.pmid).slice(0,80))+'</a><div class="sub">PMID '+esc(c.pmid)+' · '+esc(c.molecule||"")+'</div>',esc(sp)+" · "+esc(ev),who,due,badge(c.status,stColor[c.status]||""),(a.valid?badge("Valid","green"):badge("Missing: "+(a.missing||[]).join(", "),"amber"))+'<div class="sub">QC '+(a.score??"")+' / 100</div>','<button class="btn outline sm" data-opencase="'+esc(c.id)+'">Open</button>'];});
    const S=data.series||{total:0,events:[],products:[],countries:[],sex:[],ages:[],monthly:[],serious:[],fatal:[],trend:{hikes:[]}};
    const bars=(list)=>list.length?list.map(x=>'<div class="row" title="'+esc(x.cases.join(", "))+'"><span>'+esc(x.key)+'</span><span class="sub">'+x.count+' case'+(x.count===1?"":"s")+' · '+esc(x.cases.slice(0,4).join(", "))+(x.cases.length>4?"…":"")+'</span></div>').join(""):'<div class="empty">No data yet.</div>';
    const months=S.monthly.map(m=>'<span class="badge'+((S.trend.hikes||[]).includes(m.month)?" red":"")+'" title="'+esc(m.cases.join(", "))+'">'+esc(m.month)+': '+m.count+'</span>').join(" ");
    html=tiles+panel("Case tracker",table(["Case","Article","Product · event","Assignee","Reporting due","Status","Validity",""],rows,"No cases in this view."),"",true)+
      panel("Intake and assignment",intake)+
      panel("Case series summary",'<div class="row"><span><b>'+S.total+'</b> case'+(S.total===1?'':'s')+' · <b>'+S.serious.length+'</b> serious · <b>'+S.fatal.length+'</b> fatal</span><span class="sub">Counted from the case fields. Hover a line to see which cases it counts.</span></div>'+
        '<div style="display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))"><div><h3 style="margin:8px 0">Events</h3>'+bars(S.events)+'</div><div><h3 style="margin:8px 0">Suspect products</h3>'+bars(S.products)+'</div><div><h3 style="margin:8px 0">Countries</h3>'+bars(S.countries)+'</div><div><h3 style="margin:8px 0">Age and sex</h3>'+bars(S.ages)+bars(S.sex)+'</div></div>'+
        '<h3 style="margin:14px 0 6px">Cases received per month</h3><div class="chips">'+(months||'<span class="sub">No cases yet.</span>')+'</div><p class="sub" style="margin-top:8px">'+esc(S.trend.basis||"")+(S.monthly.length?" Median "+S.trend.median+", spread "+S.trend.mad+", upper limit "+S.trend.upper+" cases per month (median + 2 x scaled MAD).":"")+(S.trend.hikes&&S.trend.hikes.length&&S.monthly.length>=4?' <b style="color:var(--red)">Above the limit: '+esc(S.trend.hikes.join(", "))+'.</b>':"")+'</p>',"Deterministic: no model writes these figures.")+
      panel("How Synchrony works",'<div class="row"><span>Intake</span><span class="sub">Articles from LiteraSift with stored full text and detected events become draft cases, pre-filled with the exact sentences they came from. Cases can also be started from the Review dialog.</span></div><div class="row"><span>Assign</span><span class="sub">Each case goes to the molecule owner, or the reviewer with the fewest open cases. Managers can reassign from the tracker.</span></div><div class="row"><span>Track</span><span class="sub">The reporting due date comes from the country, seriousness and marketing-authorisation record. Overdue and due-soon cases are flagged.</span></div><div class="row"><span>Review and sign</span><span class="sub">Complete the case, code the events, resolve QC findings, then sign. Signed cases are locked.</span></div><div class="row"><span>Export</span><span class="sub">E2B(R3) XML, CIOMS I (PDF), FHIR JSON, line listing (CSV), PV Nexus JSON, or a full package.</span></div>'+(data.config.pvNexus&&data.config.pvNexus.url?'<div class="row"><span>PV Nexus</span><span class="sub">Checks also run on your PV Nexus backend.</span></div>':""));
  }
  if(tab==="Audit"){
    const months=[...Array(12)].map((_,i)=>{const d=new Date();d.setDate(1);d.setMonth(d.getMonth()-i);return d.toISOString().slice(0,7);});
    html=panel("Audit trail",'<div class="filters" style="padding:0 0 14px;border:0"><select id="auditmonth" aria-label="Month">'+months.map(m=>'<option'+(m===auditMonth?" selected":"")+'>'+m+'</option>').join("")+'</select><input id="auditq" placeholder="Search user, target, detail…" value="'+esc(auditQ)+'"><select id="auditaction" aria-label="Action"><option value="">All actions</option>'+["login","logout","password","account","review","bulk-status","pull","import","scheduled","watch","molecule","profile","export","download","settings","access","sign","audit","memory"].map(a=>'<option'+(auditAction===a?" selected":"")+'>'+a+'</option>').join("")+'</select></div><div id="auditbody"></div>',
      "Every sign-in, review decision, assignment, pull, export, download, account change and setting is recorded with the user and time. Entries are chained by hash, so edits or deletions show up as a broken chain.");
  }
  if(tab==="Library"){
    const lib=data.library||[], keys=libKeys(), tree={};
    lib.forEach(e=>{(((tree[e[keys[0]]]||={})[e[keys[1]]]||={})[e[keys[2]]]||=new Set()).add(e.pmid);});
    const stat=ids=>{const arts=[...ids].map(id=>data.articles[id]).filter(Boolean);return{n:arts.length,ft:arts.filter(a=>a.fullTextKey).length,shot:arts.filter(a=>a.screenshotKey).length};};
    let [p0,p1,p2]=libPath==="/"?[]:libPath.split("/");
    if(p0&&!tree[p0]){libPath="/";p0=p1=p2=undefined;}
    else if(p1&&!tree[p0][p1]){libPath=p0;p1=p2=undefined;}
    else if(p2&&!tree[p0][p1][p2]){libPath=p0+"/"+p1;p2=undefined;}
    const byCountry=libMode==="country", lvl1=byCountry?"country":"molecule";
    const modeBar='<div class="sub" style="margin-bottom:10px">Browse by <button class="btn sm'+(byCountry?" outline":"")+'" data-libmode="range">Date range</button> <button class="btn sm'+(byCountry?"":" outline")+'" data-libmode="country">Country</button> '+(byCountry?"Country is the patient's (from case reports), otherwise the first author's, otherwise the journal's. It decides the regulator and marketing authorisation.":"")+'</div>';
    const crumbs='<div class="sub" style="margin-bottom:12px"><button class="btn outline sm" data-libopen="/">Library</button>'+(p0?' / <button class="btn outline sm" data-libopen="'+esc(p0)+'">'+esc(p0)+'</button>':"")+(p1?' / <button class="btn outline sm" data-libopen="'+esc(p0+"/"+p1)+'">'+esc(p1)+'</button>':"")+(p2?' / <b>'+esc(p2)+'</b>':"")+'</div>';
    const actions=path=>'<button class="btn outline sm" data-libzip="'+esc(path)+'">ZIP</button> <button class="btn outline sm" data-libpdf="'+esc(path)+'">PDF</button> <button class="btn outline sm" data-libris="'+esc(path)+'">RIS</button>'+(data.viewer.role==="manager"?' <button class="btn outline sm" data-libdel="'+esc(path)+'" style="color:var(--red)">Delete</button>':"");
    const idsOf=obj=>new Set(Object.values(obj).flatMap(x=>x instanceof Set?[...x]:[...idsOf(x)]));
    const reg=id=>(data.config.sources||[]).find(x=>x.id===id)||{label:id,note:""};
    const regulator=c=>{const hit=(data.config.countryInfo||{})[c];return hit?hit:"";};
    if(!lib.length) html=panel("Library",'<div class="empty">Nothing here yet. Pull articles for a molecule on Search &amp; Pull and its folder appears here.</div>');
    else if(!p0) html=modeBar+crumbs+'<div class="cards">'+Object.entries(tree).sort().map(([k,groups])=>{const st=stat(idsOf(groups));
      return '<div class="card"><div class="lbl"><b style="font-size:16px;color:var(--fg)">📁 '+esc(reg(k).label)+'</b></div><div class="sub" style="margin:6px 0 10px">'+Object.keys(groups).length+" "+lvl1+(Object.keys(groups).length===1?"":"s")+" · "+st.n+" articles · "+st.ft+' full texts</div><button class="btn sm" data-libopen="'+esc(k)+'">Open</button> <button class="btn outline sm" data-libzip="'+esc(k)+'">ZIP</button></div>';}).join("")+'</div>'+
      panel("Whole library",'<button class="btn outline" data-libzip="/">Download everything (ZIP)</button>',"Full texts arranged as "+(byCountry?"Source / Country / Molecule":"Source / Molecule / Date range")+" / files, with a manifest.csv. PubMed articles and each government agency's material are kept in separate top-level folders.");
    else if(!p1) html=modeBar+crumbs+'<div class="cards">'+Object.entries(tree[p0]).sort().map(([k,groups])=>{const st=stat(idsOf(groups));
      const maSummary=byCountry&&(data.config.ma||[]).length?Object.keys(groups).map(m=>maChip([m],k)).join(" "):"";
      return '<div class="card"><div class="lbl"><b style="font-size:16px;color:var(--fg)">📁 '+esc(k)+'</b></div><div class="sub" style="margin:6px 0 6px">'+Object.keys(groups).length+" "+(byCountry?"molecule":"date range")+(Object.keys(groups).length===1?"":"s")+" · "+st.n+" articles · "+st.ft+' full texts</div>'+(maSummary?'<div class="chips" style="margin-bottom:8px">'+maSummary+'</div>':"")+'<button class="btn sm" data-libopen="'+esc(p0+"/"+k)+'">Open</button> <button class="btn outline sm" data-libzip="'+esc(p0+"/"+k)+'">ZIP</button></div>';}).join("")+'</div>'+panel("Whole source folder",actions(p0),reg(p0).note);
    else if(!p2) html=modeBar+crumbs+panel(esc(p1),table([byCountry?"Molecule":"Date range","Articles","Full text","Snapshots"].concat(byCountry&&(data.config.ma||[]).length?["Marketing authorisation"]:[],[""]),Object.entries(tree[p0][p1]).sort((x,y)=>byCountry?x[0].localeCompare(y[0]):y[0].localeCompare(x[0])).map(([r,ids])=>{const st=stat(ids);
      return ['📁 <a href="#" data-libopen="'+esc(p0+"/"+p1+"/"+r)+'">'+esc(byCountry?r:r.replace("_to_"," → "))+'</a>',st.n,st.ft+" / "+st.n,st.shot+" / "+st.n].concat(byCountry&&(data.config.ma||[]).length?[maChip([r],p1)]:[],[actions(p0+"/"+p1+"/"+r)]);}),"Nothing here."),"",true)+
      panel("Whole folder",actions(p0+"/"+p1));
    else {
      const ids=tree[p0][p1][p2]||new Set();
      libNumbers={};
      if(byCountry){const sorted=[...ids].sort((x,y)=>Number(x)-Number(y)),width=Math.max(3,String(sorted.length).length);sorted.forEach((id,i)=>{libNumbers[id]=String(i+1).padStart(width,"0");});}
      else lib.filter(e=>e.folder===libPath).forEach(e=>{libNumbers[e.pmid]=String(e.n).padStart(e.width,"0");});
      if(libSortFor!==libPath){filt.sort="number";libSortFor=libPath;}
      html=modeBar+crumbs+panel(esc(byCountry?p2+" · "+p1:p1+" · "+p2.replace("_to_"," → ")),actions(libPath),"Articles are numbered within this folder (by PMID); the same numbers are used in file names, ZIPs, PDFs and the manifest."+(byCountry?" "+((regulator(p1))?"":""):""),false)+queueView(items.filter(a=>ids.has(a.pmid)));
    }
  }
  if(tab==="My Queue"){
    const groups={};mine.forEach(a=>{const k=(a.molecules||[]).length?a.molecules.join(", "):a.portfolio;(groups[k]||={n:0,d:0}).n++;if(a.status==="Complete")groups[k].d++;});
    const done=mine.filter(a=>a.status==="Complete").length;
    html=(mine.length?panel("My coverage",'<div class="row"><span>'+done+" of "+mine.length+' articles screened</span><b>'+Math.round(done/mine.length*100)+'%</b></div><div class="bar"><i data-width="'+Math.round(done/mine.length*100)+'"></i></div>'+
      Object.entries(groups).sort((x,y)=>y[1].n-x[1].n).map(([k,g])=>'<div class="row"><span>'+esc(k)+'</span><span class="sub">'+g.d+" / "+g.n+'</span></div>').join(""),"Work through every article assigned to you; mark each Complete when screened."):"")+queueView(mine);
  }
  if(tab==="All Assignments") html=queueView(items);
  if(tab==="Watchlists") html=panel("Add a watchlist",'<form class="grid" data-route="watch"><label>Portfolio<input name="portfolio" required></label><label>Molecule<input name="molecule" placeholder="Optional"></label><label class="wide">PubMed query<input name="query" required placeholder="e.g. aciclovir OR acyclovir"></label><div><button class="btn">Save watchlist</button></div></form>')+
    panel("Add molecules in bulk",'<form class="grid" data-route="watches"><label>Portfolio<input name="portfolio" required></label><label class="wide">Molecules<textarea name="list" rows="6" required placeholder="aciclovir, acyclovir, Zovirax&#10;metformin, Glucophage"></textarea></label><label>Assign all to<select name="owner">'+peopleOptions("","Auto-assign")+'</select></label><label class="check"><input type="checkbox" name="safety">&nbsp;Safety-related articles only</label><div><button class="btn">Save molecules</button></div></form>',"One molecule per line: the molecule first, then synonyms, brands or salts, separated by commas or tabs.")+
    panel("Assign a molecule to an employee",watchOptions?'<form class="grid" data-route="assign-molecule"><label>Molecule<select name="watch">'+watchOptions+'</select></label><label>Employee<select name="owner">'+peopleOptions("","Unassign (auto)")+'</select></label><label class="check"><input type="checkbox" name="reassign">&nbsp;Also move articles already assigned to someone else</label><div><button class="btn">Assign</button></div></form>':'<div class="empty">Save a watchlist first.</div>',
      "The employee receives every pulled article for the molecule that is not yet complete, and every article pulled for it from now on. Their open-article limit does not apply to owned molecules.")+
    panel("Assign by number",watchOptions?'<div class="grid"><label>Molecule<select id="rkwatch">'+watchOptions+'</select></label><label>Order<select id="rkorder"><option value="relevance">Most relevant first</option><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label><label>Articles<select id="rkpool"><option value="open">All not yet complete</option><option value="unassigned">Unassigned only</option></select></label></div><div id="rkrows" style="margin-top:12px"></div><div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0"><button type="button" class="btn outline" data-rkadd="1">Add range</button><button type="button" class="btn outline" data-rkpreview="1">Preview ranked list</button><button type="button" class="btn" data-rkapply="1">Assign</button></div><div id="rkpreview"></div>':'<div class="empty">Save a watchlist first.</div>',
      "Number the articles in the order you choose (#1 is the top) and give each range to a person, for example 1 to 20 to one person and 21 to 30 to another. Articles outside the ranges stay as they are.")+
    panel("Saved watchlists ("+data.watches.length+")",table(["Portfolio","Molecule","Owner","Query",""],data.watches.map(w=>[esc(w.portfolio),esc(w.molecule||"—"),w.owner?esc((data.profiles.find(p=>p.email===w.owner)||{name:w.owner}).name):'<span class="sub">Auto</span>','<span class="sub">'+esc(w.query)+"</span>",'<button class="btn outline sm" data-delwatch="'+esc(encodeURIComponent(w.portfolio)+"|"+encodeURIComponent(w.molecule||""))+'">Delete</button>']),"Add a molecule or portfolio watchlist to start."),"",true);
  if(tab==="Settings") html=panel("Unpaywall (open access)",'<form class="grid" data-route="settings"><label class="wide">Contact email for Unpaywall<input type="email" name="unpaywallEmail" value="'+esc(data.config.unpaywallEmail)+'" placeholder="you@example.com"'+(data.config.unpaywallFromEnv?' disabled':'')+'></label><div><button class="btn"'+(data.config.unpaywallFromEnv?' disabled':'')+'>Save</button></div></form>'+
      '<div class="row"><span>Status</span>'+(data.config.unpaywall?badge("Active","green"):badge("Not configured","amber"))+'</div>'+
      '<form data-route="recheck-access" style="margin-top:10px"><button class="btn outline">Re-check open access for all articles</button></form>',
      "Unpaywall requires a contact email on each request; it is sent to Unpaywall only. Every article with a DOI gets an open-access status (gold, hybrid, green, bronze or closed). Permissively licensed PDFs are stored, other open copies are linked. Closed articles are re-checked every 30 days."+(data.config.unpaywallFromEnv?" The email is set by the server environment (UNPAYWALL_EMAIL).":""))+
    panel("Important medical events (IME list)",'<div class="row"><span>Status</span>'+(data.config.ime&&data.config.ime.loaded?badge("Loaded: MedDRA "+data.config.ime.version,"green"):badge("Not loaded","amber"))+'</div>'+
      (data.config.ime&&data.config.ime.loaded?'<div class="sub" style="margin:6px 0">'+esc(data.config.ime.reference||"")+(data.config.ime.released?" · released "+esc(data.config.ime.released):"")+' · '+data.config.ime.count+' terms ('+data.config.ime.added+' added in this version, '+data.config.ime.demoted+' demoted terms)</div>':"")+
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0"><input type="file" id="imefile" accept=".json,.csv,.txt,.xlsx"><button type="button" class="btn" data-imeup="1">Upload list</button>'+(data.config.ime&&data.config.ime.loaded?'<button type="button" class="btn outline" data-imeclear="1">Remove list</button>':"")+'</div>'+
      '<div class="sub" style="margin-top:6px">Promote a term (reviewer-added important medical event)</div><div style="display:flex;gap:8px;flex-wrap:wrap;margin:6px 0"><input id="imept" placeholder="MedDRA preferred term"><input id="imenote" placeholder="Note (optional)"><button type="button" class="btn outline" data-imepromo="1">Promote</button></div>'+
      (data.config.imePromotions||[]).map(p=>'<div class="row"><span>'+esc(p.pt_name)+'<div class="sub">'+esc(p.note||"")+' '+esc((p.promoted_at||"").slice(0,10))+'</div></span><button type="button" class="btn outline sm" data-imeunpromo="'+esc(p.pt_name)+'">Remove</button></div>').join(""),
      "Events found in articles are matched against the EMA list of important medical events (ICH E2A criterion 6, other medically important condition). Upload PV Nexus's ime-meddra.json (it holds MedDRA 29.1, EMA/211097/2026) or a CSV/TXT with one preferred term per line. The list is stored with your data, not in the source code, because MedDRA content is licensed. Matching uses preferred-term wording, so lay phrases may need MeSH or PubTator hints or a promoted term.")+
    panel("Marketing authorisations by country",'<textarea id="matext" rows="6" placeholder="molecule, country, status, MAH, MA number, serious days, non-serious days">'+esc("molecule,country,status,MAH,MA number,serious_days,nonserious_days"+NL+(data.config.ma||[]).map(e=>[e.molecule,e.country,e.status,e.mah,e.number,e.serious_days||"",e.nonserious_days||""].join(",")).join(NL))+'</textarea><div style="margin-top:10px"><button type="button" class="btn" data-masave="1">Save authorisations</button> <span class="sub">'+(data.config.ma||[]).length+' records</span></div>',
      "There is no open worldwide source for marketing-authorisation status, so this table is yours to maintain. The country decides the regulator, whether the product is authorised there, and the reporting clock shown on ICSR cases (default 15 days for serious and 90 for non-serious cases unless a row says otherwise; confirm with local regulations). Statuses are read as Authorised, Not authorised, Withdrawn or Under review.")+
    panel("PV Nexus (ICSR processing)",'<form class="grid" data-route="settings"><label>PV Nexus API address (optional)<input name="pvNexusUrl" value="'+esc((data.config.pvNexus||{}).url||"")+'" placeholder="https://your-pv-nexus-backend"'+((data.config.pvNexus||{}).urlFromEnv?" disabled":"")+'></label><label>API token (optional)<input type="password" name="pvNexusToken" autocomplete="off" placeholder="'+((data.config.pvNexus||{}).tokenSet?"Token is set; leave blank to keep it":"Sent as a Bearer token if your gateway needs one")+'"></label><div><button class="btn">Save</button>'+((data.config.pvNexus||{}).tokenSet?' <button type="button" class="btn outline" data-pvremove="1">Remove token</button>':"")+'</div></form>',
      "ICSR cases are assessed here with a port of PV Nexus's deterministic rules (validity, QC, causality suggestion, follow-up questions), checked to give identical results. If you enter the address of a PV Nexus backend, the same checks are run by it instead, and LiteraSift falls back to the local rules if it is unreachable.")+
    panel("Publisher and aggregator access",'<form class="grid" data-route="settings"><label>CORE API key (free, core.ac.uk)<input type="password" name="coreApiKey" autocomplete="off" placeholder="'+((data.config.retrievalKeys||{}).core?"Set; leave blank to keep":"Paste your CORE key")+'"></label><label>Wiley text-mining token<input type="password" name="wileyTdmToken" autocomplete="off" placeholder="'+((data.config.retrievalKeys||{}).wiley?"Set; leave blank to keep":"Wiley-TDM-Client-Token")+'"></label><label>Elsevier API key<input type="password" name="elsevierApiKey" autocomplete="off" placeholder="'+((data.config.retrievalKeys||{}).elsevier?"Set; leave blank to keep":"X-ELS-APIKey")+'"></label><label>Elsevier institution token (optional)<input type="password" name="elsevierInsttoken" autocomplete="off" placeholder="'+((data.config.retrievalKeys||{}).elsevierInst?"Set; leave blank to keep":"X-ELS-Insttoken")+'"></label><div><button class="btn">Save</button> '+Object.entries({coreApiKey:"core",wileyTdmToken:"wiley",elsevierApiKey:"elsevier",elsevierInsttoken:"elsevierInst"}).filter(([,k])=>(data.config.retrievalKeys||{})[k]).map(([f,k])=>'<button type="button" class="btn outline sm" data-keyremove="'+f+'">Remove '+esc(k)+'</button>').join(" ")+'</div></form>',"Extra places to look for full texts, each used only with a key you hold. CORE searches open repository copies. The Wiley and Elsevier text-mining services return only what your institution is licensed to read, and may refuse requests from this server if your licence is tied to your campus network. Those texts are stored as restricted. Leave all blank to skip.")+
    panel("Coding memory",'<div id="memorybox"><div class="empty">Loading…</div></div>',"When a reviewer marks an event coding as Reviewed, LiteraSift remembers it and suggests it for similar events in other cases. Deleting an entry or the whole memory only stops those suggestions: the cases keep their codings. Every deletion is recorded in the audit trail.")+
    panel("Closed-access articles",'<form class="grid" data-route="settings"><label class="wide">Library proxy address (optional)<input name="proxyPrefix" value="'+esc(data.config.proxyPrefix||"")+'" placeholder="https://ezproxy.your-library.edu/login?url="></label><div><button class="btn">Save</button></div></form>',"For articles behind a paywall. With your library's proxy address, every closed article gets an Open with your institution link that signs in through your library. You can then download the PDF and upload it on the article, or paste the text; it flows into event detection and Synchrony like any other full text. LiteraSift does not bypass paywalls.")+
    panel("Synchrony (ICSR workbench)",'<form class="grid" data-route="settings"><label>Add full-text articles automatically<select name="autoIcsr"><option value="on"'+(data.config.autoIcsr?" selected":"")+'>On: draft a case for each article with stored full text and detected events</option><option value="off"'+(data.config.autoIcsr?"":" selected")+'>Off: add them with the button on the Synchrony tab</option></select></label><label>Assign new cases automatically<select name="autoAssignCases"><option value="on"'+(data.config.autoAssignCases?" selected":"")+'>On: molecule owner, else the reviewer with the fewest open cases</option><option value="off"'+(data.config.autoAssignCases?"":" selected")+'>Off: managers assign by hand</option></select></label><label>Sender organisation<input name="senderOrg" value="'+esc((data.config.sender||{}).org||"")+'" placeholder="Your company"></label><label>Sender contact name<input name="senderName" value="'+esc((data.config.sender||{}).name||"")+'"></label><label>Sender e-mail<input name="senderEmail" value="'+esc((data.config.sender||{}).email||"")+'"></label><label>Sender phone<input name="senderPhone" value="'+esc((data.config.sender||{}).phone||"")+'"></label><label>Sender country<input name="senderCountry" value="'+esc((data.config.sender||{}).country||"")+'"></label><label>E2B sender identifier<input name="senderId" value="'+esc((data.config.e2b||{}).sender||"")+'" placeholder="Your organisation ID (N.2.r.2)"></label><label>E2B receiver identifier<input name="receiverId" value="'+esc((data.config.e2b||{}).receiver||"")+'" placeholder="Regulator or partner ID (N.2.r.3)"></label><div><button class="btn">Save</button></div></form>',"E2B(R3) files carry these identifiers in the message header.")+
    panel("NCBI / PubMed access",'<form class="grid" data-route="settings"><label>Contact email for NCBI<input type="email" name="ncbiEmail" value="'+esc((data.config.ncbi||{}).email||"")+'" placeholder="you@example.com"'+((data.config.ncbi||{}).emailFromEnv?" disabled":"")+'></label><label>NCBI API key (optional)<input type="password" name="ncbiApiKey" autocomplete="off" placeholder="'+((data.config.ncbi||{}).keySet?"Key is set; leave blank to keep it":"Paste a free key to allow 10 requests a second")+'"'+((data.config.ncbi||{}).keyFromEnv?" disabled":"")+'></label><div><button class="btn">Save</button>'+(((data.config.ncbi||{}).keySet&&!(data.config.ncbi||{}).keyFromEnv)?' <button type="button" class="btn outline" data-ncbiremove="1">Remove key</button>':"")+'</div></form>',
      "PubMed is read through NCBI's E-utilities only; its web pages are never scraped, which NCBI forbids. NCBI asks automated tools to identify themselves with a contact email, and allows 3 requests a second, or 10 with a free API key (create one in your NCBI account settings). The key is stored with the app data; for a server install it is safer in /etc/literasift.env as NCBI_API_KEY.")+
    panel("Sources",(data.config.sources||[]).map(x=>'<div class="row"><span><b>'+esc(x.label)+'</b><div class="sub">'+esc(x.note)+'</div></span>'+(x.active?badge("Active","green"):badge("Not enabled","amber"))+'</div>').join(""),
      "Each source is stored and filed separately: its own badge and filter in the queues, its own top-level Library folder, and a Source column in every export. Only PubMed is connected today; agency feeds would plug in here.")+
    panel("Restricted-licence full text",'<form class="grid" data-route="settings"><label class="wide">Store open-access copies under restrictive licences<select name="storeRestricted"><option value="true"'+(data.config.storeRestricted?" selected":"")+'>Yes, store them (internal use)</option><option value="false"'+(data.config.storeRestricted?"":" selected")+'>No, only open licences (CC0, CC BY, CC BY-SA, CC BY-ND)</option></select></label><div><button class="btn">Save</button></div></form>',
      "Covers free-to-read copies found by PubMed Central, Europe PMC and Unpaywall that carry licences such as CC BY-NC or publisher terms, or none at all. They are marked 'Restricted licence' and meant for internal screening only; do not redistribute them. Only copies the publisher or a repository offers legally for free are fetched. Turning this on retries articles that only had a link.")+
    (data.config.libraryPath?panel("Library folder on the server",'<div class="row"><span>Path</span><b>'+esc(data.config.libraryPath)+'</b></div>',"The same Molecule / Date range folders are kept on disk (full texts, extracted text, record snapshots, an _index.csv per folder), refreshed after every scheduled run, so they can be copied or backed up directly."):"")+
    panel("Article screenshots",'<div class="row"><span>Status</span>'+(data.config.screenshots?badge("Active","green"):badge("Not configured","amber"))+'</div>',data.config.screenshots?"A snapshot of each article's PubMed record (title, authors, abstract, MeSH, status) is rendered and embedded in PDF exports.":"PDF exports include a screenshot of each article once capture is enabled. On the VPS, run: bash /opt/literasift-src/deploy/enable-screenshots.sh")+
    panel("Extraction sources",['PubMed (E-utilities): citations, abstracts, authors, MeSH terms','PubMed Central open-access bucket: full text under open licences','Europe PMC: abstracts, keywords, citation counts, full-text XML for open-licensed articles','OpenAlex: citation counts, topics, abstract fallback','Crossref and PubMed: retraction notices','Unpaywall: open-access status and PDF fallback'].map(t=>'<div class="row"><span>'+esc(t)+'</span>'+badge("On","green")+'</div>').join("")+
      '<div class="row"><span>GROBID: structured text from PDFs (self-hosted, optional)</span>'+(data.config.grobid?badge("On","green"):badge("Not configured","amber"))+'</div>',"All sources are free and open; none needs an account. Full text is stored only when its licence allows it. Key passages are sentences mentioning the molecule and a safety term.")+
    panel("What Unpaywall adds across the site",'<div class="row"><span>Overview</span><span class="sub">Open-access share and breakdown</span></div><div class="row"><span>Queues</span><span class="sub">OA badge on every citation and an access filter</span></div><div class="row"><span>Full text</span><span class="sub">Fallback when PubMed Central has no eligible copy</span></div><div class="row"><span>CSV export</span><span class="sub">OA status, licence and link columns</span></div>');
  if(tab==="Account") html=panel("Change password",'<form class="grid" data-route="/host/change-password"><label>Current password<input type="password" name="current" autocomplete="current-password" required></label><label>New password<input type="password" name="next" autocomplete="new-password" minlength="12" required></label><label>Confirm new password<input type="password" name="confirm" autocomplete="new-password" minlength="12" required></label><div><button class="btn">Change password</button></div></form>',"At least 12 characters. Changing it signs you out everywhere else.")+
    panel("Your account",'<div class="row"><span>Name</span><b>'+esc(data.viewer.name)+'</b></div><div class="row"><span>Email</span><b>'+esc(data.viewer.email)+'</b></div><div class="row"><span>Role</span>'+badge(data.viewer.role,data.viewer.role==="manager"?"blue":"")+'</div>');
  if(tab==="Team"){
    const hosted=data.config.accounts, accts=data.accounts.users;
    html=panel(hosted?"Invite or update a reviewer":"Add or update a reviewer",'<form class="grid" data-route="'+(hosted?"/host/invite":"profile")+'"><label>Name<input name="name" required></label><label>Sign-in email<input type="email" name="email" required></label><label>Portfolio<input name="portfolio" placeholder="All portfolios"></label><label>Open assignment limit<input type="number" name="capacity" min="1" max="500" value="25" required></label><label>Availability<select name="active"><option value="true">Active</option><option value="false">Unavailable</option></select></label><div><button class="btn">'+(hosted?"Save and invite":"Save reviewer")+'</button></div></form>',
        hosted?(data.accounts.mail?"New reviewers get an email with a link to set their password.":"Email delivery isn't configured, so you'll be shown a link to send to each new reviewer yourself."):"")+
      panel("Team",table(hosted?["Name","Email","Role","Portfolio","Open","Screened","Sign-in",""]:["Name","Email","Role","Portfolio","Open","Screened"],data.profiles.map(p=>{
        const own=items.filter(a=>a.reviewer===p.email), fin=own.filter(a=>a.status==="Complete").length;
        const row=[esc(p.name),esc(p.email),badge(p.role,p.role==="manager"?"blue":""),esc(p.portfolio||"All"),own.length-fin,fin+" / "+own.length+(own.length?" ("+Math.round(fin/own.length*100)+"%)":"")];
        if(hosted){
          const st=accts[p.email];
          row.push(st==="active"?badge("Active","green"):st==="invited"?badge("Invited","amber"):badge("No account"));
          row.push(p.email===data.viewer.email?"":'<button class="btn outline sm" data-resetlink="'+esc(p.email)+'">'+(st==="active"?"Reset password":"Send invite")+'</button> '+(st?'<button class="btn outline sm" data-revoke="'+esc(p.email)+'">Revoke</button>':""));
        }
        return row;
      }),"No profiles."),"",true);
  }
  if(tab==="Batches") html=panel("Backfill a date range",watchOptions?
    '<form class="grid" data-route="import"><label>Watchlist<select name="watch">'+watchOptions+'</select></label><label>From<input name="from" type="date" required></label><label>Through<input name="to" type="date" required></label><div><button class="btn">Import citations</button></div></form>':
    '<div class="empty">Save a watchlist before importing a batch.</div>')+
    panel("Batch archive",'<form data-route="evidence" style="margin:0 0 8px"><button class="btn outline">Process pending evidence</button></form>'+table(["Watchlist","Date range","Citations","Status","Manifest"],data.runs.map(r=>[esc(r.portfolio+(r.molecule?" · "+r.molecule:"")),esc(r.from)+" → "+esc(r.to),r.count,badge(r.error||r.status,r.status==="Imported"?"green":"red"),r.status==="Imported"?'<button class="btn outline sm" data-export="'+esc(r.id)+'">CSV</button> <button class="btn outline sm" data-pdfrun="'+esc(r.id)+'">PDF</button> <button class="btn outline sm" data-zip="'+esc(r.id)+'">ZIP</button>':""]),"No batches yet."));
  if(tab==="Batches"){
    const closedList=Object.values(data.articles).filter(a=>!a.fullTextKey&&a.title&&data.assignments.some(x=>x.pmid===a.id)).slice(0,200), prefix=data.config.proxyPrefix||"";
    html+=panel("Closed articles waiting for a full text ("+closedList.length+(closedList.length===200?"+":"")+")",
      '<div class="row"><span>Download the PDFs you are licensed to use, name each file with its PMID or DOI, and add them all at once.</span><span style="display:flex;gap:8px;flex-wrap:wrap"><input type="file" id="bulkft" multiple accept=".pdf,.xml"><button type="button" class="btn" data-bulkft="1">Match and upload</button></span></div><div id="bulkftresult" class="sub" style="padding:6px 0"></div>'+
      table(["Article","Status","Get it","Ask the author"],closedList.map(a=>{const link=a.doi?"https://doi.org/"+a.doi:a.url||"";return ['<a href="'+esc(a.url||"#")+'" target="_blank" rel="noopener">'+esc(String(a.title).slice(0,90))+'</a><div class="sub">PMID '+esc(a.id)+(a.doi?" · "+esc(a.doi):"")+'</div>',esc(a.fullTextStatus||"Pending"),(prefix&&link?'<a class="btn outline sm" href="'+esc(prefix+link)+'" target="_blank" rel="noopener">Via your library</a>':'<span class="sub">set a proxy in Settings</span>'),'<button type="button" class="btn outline sm" data-authornote="'+esc(a.id)+'">Copy request</button>'];}),"Every article in the queues has a full text."),
      "Open-access sources are tried automatically (PMC, Europe PMC, Unpaywall, Semantic Scholar, preprints). What is left is closed. Only use copies you are licensed to use.");
  }
  $("content").innerHTML=html;
  animate();
  drawProgress();
  if(tab==="Watchlists"&&$("rkrows")){rkAddRow(1,20);rkAddRow(21,30);}
  if(tab==="Settings"&&$("memorybox"))loadMemory();
  if(tab==="Synchrony"){
    document.querySelectorAll("[data-assignsel]").forEach(el=>{el.onchange=()=>api("case-assign",{ids:[el.dataset.assignsel],assignee:el.value}).then(()=>{message(el.value?"Case assigned.":"Case unassigned.");return refresh();}).catch(e=>message(e.message,true));});
  }
  if(tab==="Audit"){
    $("auditmonth").onchange=e=>{auditMonth=e.target.value;loadAudit();};
    $("auditq").oninput=e=>{auditQ=e.target.value;drawAudit();};
    $("auditaction").onchange=e=>{auditAction=e.target.value;drawAudit();};
    if(auditData&&auditData.month===auditMonth)drawAudit();else loadAudit();
  }
}
function animate(){
  const reduce=matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.querySelectorAll("[data-count]").forEach(el=>{
    const end=Number(el.dataset.count);
    if(reduce||end<2){el.textContent=end.toLocaleString();return;}
    const start=performance.now();
    const step=now=>{const t=Math.min(1,(now-start)/700);el.textContent=Math.round(end*(1-Math.pow(1-t,3))).toLocaleString();if(t<1)requestAnimationFrame(step);};
    requestAnimationFrame(step);
  });
  requestAnimationFrame(()=>document.querySelectorAll("[data-width]").forEach(el=>el.style.width=el.dataset.width+"%"));
}
async function refresh(){
  data=await api("state");
  data.accounts={users:{},mail:false};
  if(data.config.accounts&&data.viewer.role==="manager")data.accounts=await api("/host/users").catch(()=>data.accounts);
  render();
}
function showLink(title,note,link){
  $("linktitle").textContent=title;$("linknote").textContent=note;$("linkvalue").value=link;
  $("linkshare").style.display=navigator.share?"":"none";$("linkdlg").showModal();$("linkvalue").select();
}
function download(id) {
  const run=data.runs.find(r=>r.id===id);
  const cell=value=>'"'+String(value??"").replace(/^[=+@\\-]/,"'$&").replaceAll('"','""')+'"';
  const rows=[["Source","PMID","Title","Journal","Date","DOI","PubMed URL","Portfolio","Molecules","Reviewer","Status","Full text","Screenshot","Retraction check","OA status","OA licence","OA link","Cited by","Abstract","Key passages"]];
  run.ids.forEach(pmid=>{
    const a=data.articles[pmid], item=data.assignments.find(x=>x.pmid===pmid&&x.portfolio===run.portfolio);
    rows.push([sourceOf(a),pmid,a.title,a.journal,a.date,a.doi,a.url,run.portfolio,(item?.molecules||[]).join("; "),item?.reviewer,item?.status,a.fullTextStatus||"Pending",a.screenshotStatus||"Pending",a.retractionStatus||"Pending",a.oaStatus||"Pending",a.oaLicense||"",a.oaUrl||"",a.citedBy??"",a.abstract||"",(a.keyPassages||[]).join(" | ")]);
  });
  const url=URL.createObjectURL(new Blob([rows.map(row=>row.map(cell).join(",")).join("\\r\\n")],{type:"text/csv"}));
  const link=document.createElement("a");link.href=url;link.download="pubmed-"+run.from+"-"+run.to+".csv";link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function setTheme(mode){
  document.documentElement.dataset.theme=mode;
  try{localStorage.setItem("literasift-theme",mode);}catch{}
  $("theme").innerHTML=ic(mode==="dark"?"sun":"moon");
}
setTheme((()=>{try{return localStorage.getItem("literasift-theme");}catch{}})()||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"));
$("theme").onclick=()=>setTheme(document.documentElement.dataset.theme==="dark"?"light":"dark");
document.addEventListener("input",event=>{
  const key=event.target.dataset?.filter;
  if(!key)return;
  filt[key]=event.target.value;
  $("qtable").innerHTML=queueRows(applyFilter(shown));
});
document.addEventListener("click",event=>{
  const target=event.target.closest("[data-pickevent],[data-codesuggest],[data-codeapply],[data-libmode],[data-imeup],[data-imeclear],[data-imepromo],[data-imeunpromo],[data-masave],[data-pvremove],[data-opencase],[data-newcase],[data-icsrintake],[data-synfilter],[data-ftupload],[data-libdel],[data-articledel],[data-memdel],[data-unfetched],[data-keyremove],[data-bulkft],[data-authornote],[data-ftpaste],[data-backtolit],[data-autoassign],[data-synexport],[data-caseact],[data-ncbiremove],[data-rkadd],[data-rkdel],[data-rkpreview],[data-rkapply],[data-auditcsv],[data-auditverify],[data-auditanchor],[data-signopen],[data-signgo],[data-signsup],[data-tab],[data-export],[data-review],[data-pdf],[data-pdfrun],[data-zip],[data-cite],[data-retrieval],[data-suggest],[data-addsyn],[data-resetlink],[data-revoke],[data-libopen],[data-libzip],[data-libpdf],[data-libris],[data-delwatch]");
  if(!target)return;
  if(target.dataset.codesuggest!==undefined){
    collectCase();const i=Number(target.dataset.codesuggest),ev=curCase.data.events[i],box=$("codesug"+i);
    if(!ev||!(ev.verbatim||{}).value){message("Enter the event wording first.",true);return;}
    box.innerHTML='<span class="sub">Looking…</span>';
    api("case-coding",{id:curCase.id,verbatim:ev.verbatim.value}).then(r=>{
      codeSug[i]=[].concat((r.ime||[]).map(h=>({pt:h.term,pt_code:h.code,soc:h.soc,status:"Proposed (IME list)",label:h.term+" (IME list"+(h.soc?", "+h.soc:"")+")"})),(r.memory||[]).map(m=>({llt:m.llt,pt:m.pt,pt_code:m.pt_code,hlt:m.hlt,hlgt:m.hlgt,soc:m.soc,version:m.version,status:"Proposed (earlier reviewed case)",label:m.pt+" (from "+m.case+", match "+Math.round(m.score*100)+"%)"})));
      box.innerHTML=codeSug[i].length?'<div class="chips" style="margin-top:6px">'+codeSug[i].map((c,j)=>'<button type="button" class="badge" style="cursor:pointer" data-codeapply="'+i+"|"+j+'">'+esc(c.label)+'</button>').join("")+'</div>':'<span class="sub">No suggestion: this wording is not on the IME list and has not been coded in an earlier case. Enter the terms from your licensed MedDRA source.</span>';
    }).catch(e=>{box.innerHTML="";message(e.message,true);});
    return;
  }
  if(target.dataset.codeapply){
    collectCase();const [i,j]=target.dataset.codeapply.split("|").map(Number),c=(codeSug[i]||[])[j],ev=curCase.data.events[i];if(!c||!ev)return;
    const put=(k,v)=>{if(v)ev[k]={value:v,normalized_value:null,state:"proposed",evidence:(ev[k]||{}).evidence||[]};};
    ["llt","pt","pt_code","hlt","hlgt","soc"].forEach(k=>put(k,c[k]));put("meddra_version",c.version);put("coding_status",c.status);
    renderCase();return;
  }
  if(target.dataset.pickevent){
    collectCase();const art=data.articles[curCase.pmid]||{},e=(art.events||[]).find(x=>x.term===target.dataset.pickevent);if(!e)return;
    const ev=blankEvent();ev.verbatim={value:e.term,normalized_value:null,state:"proposed",evidence:[{source_file:"PMID "+curCase.pmid,excerpt:(e.evidence||e.term).slice(0,300),confidence:0.5}]};
    if(e.ime){ev.coded_term={value:e.term,normalized_value:null,state:"proposed",evidence:[]};ev.seriousness.other_medically_important=true;}
    Object.keys(e.serious||{}).forEach(k=>{if(e.serious[k])ev.seriousness[k]=true;});
    ev.seriousness.serious=Object.keys(ev.seriousness).some(k=>k!=="serious"&&ev.seriousness[k]);
    if(curCase.data.events.length===1&&!(curCase.data.events[0].verbatim||{}).value)curCase.data.events[0]=ev;else curCase.data.events.push(ev);
    renderCase();return;
  }
  if(target.dataset.libmode){libMode=target.dataset.libmode;libPath="/";libSortFor="";render();return;}
  if(target.dataset.imeup){
    const file=$("imefile").files[0];if(!file){message("Choose the IME file first.",true);return;}
    if(file.size>5000000){message("That file is too large for an IME list.",true);return;}
    target.disabled=true;(/\.xlsx$/i.test(file.name)?file.arrayBuffer().then(buf=>{let bin="";const u=new Uint8Array(buf);for(let i=0;i<u.length;i+=8192)bin+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return api("ime-upload",{base64:btoa(bin),filename:file.name});}):file.text().then(text=>api("ime-upload",{text,filename:file.name}))).then(r=>{message("IME list loaded: "+r.info.label+", "+r.info.count+" terms. Events are re-detected in the background.");return refresh();}).catch(e=>message(e.message,true)).finally(()=>{target.disabled=false;});return;
  }
  if(target.dataset.imeclear){if(!confirm("Remove the stored IME list? Important-medical-event flags will disappear until a list is loaded."))return;api("ime-clear",{}).then(()=>{message("IME list removed.");return refresh();}).catch(e=>message(e.message,true));return;}
  if(target.dataset.imepromo){const pt=$("imept").value.trim();if(!pt){message("Enter the MedDRA preferred term.",true);return;}api("ime-promote",{pt_name:pt,note:$("imenote").value}).then(()=>{message("Term promoted.");return refresh();}).catch(e=>message(e.message,true));return;}
  if(target.dataset.imeunpromo){api("ime-promote",{pt_name:target.dataset.imeunpromo,remove:true}).then(()=>refresh()).catch(e=>message(e.message,true));return;}
  if(target.dataset.masave){target.disabled=true;api("ma-save",{text:$("matext").value}).then(r=>{message(r.saved+" marketing-authorisation records saved"+(r.errors.length?". Skipped: "+r.errors.join("; "):"."),r.errors.length>0);return refresh();}).catch(e=>message(e.message,true)).finally(()=>{target.disabled=false;});return;}
  if(target.dataset.pvremove){api("settings",{pvNexusToken:null}).then(()=>{message("Token removed.");return refresh();}).catch(e=>message(e.message,true));return;}
  if(target.dataset.opencase){
    event.preventDefault();const c=(data.cases||[]).find(x=>x.id===target.dataset.opencase);if(!c)return;
    api("case-assess",{id:c.id}).then(r=>{if($("dialog").open)$("dialog").close();openCaseData(c,r.assessment);}).catch(e=>message(e.message,true));return;
  }
  if(target.dataset.backtolit){const item=(data.assignments||[]).find(x=>x.pmid===curCase.pmid);if(!item){message("That article is not in your queue.",true);return;}$("casedlg").close();const open=document.querySelector('[data-review="'+item.id+'"]');if(open)open.click();else{tab=data.viewer.role==="manager"?"All Assignments":"My Queue";render();}return;}
  if(target.dataset.unfetched){
    const run=data.runs.find(r=>r.id===target.dataset.unfetched);if(!run)return;
    const rows=run.ids.filter(id=>!(data.articles[id]||{}).fullTextKey).map(id=>id+((data.articles[id]||{}).batchName?String.fromCharCode(9)+data.articles[id].batchName:""));
    if(!rows.length){message("Every article in this list has a full text.");return;}
    const link=document.createElement("a");link.href=URL.createObjectURL(new Blob([rows.join(NL)+NL],{type:"text/tab-separated-values"}));link.download="unfetched_pmids.tsv";link.click();setTimeout(()=>URL.revokeObjectURL(link.href),4000);
    message(rows.length+" PMID"+(rows.length===1?"":"s")+" still without a full text.");return;
  }
  if(target.dataset.authornote){
    const a=data.articles[target.dataset.authornote]||{},first=(a.authors||[])[0]||"author",note="Dear "+first+",\\n\\nI am writing to ask whether you could share a copy of your article \\""+(a.title||"")+"\\" ("+[a.journal,a.date].filter(Boolean).join(", ")+(a.doi?", DOI "+a.doi:"")+"). We review the safety literature for medicines and cannot access this article through our subscriptions. A PDF of the accepted or published version would be very helpful.\\n\\nThank you,\\n"+data.viewer.name;
    (navigator.clipboard?navigator.clipboard.writeText(note):Promise.reject()).then(()=>message("Request note copied. Paste it into an email to the corresponding author.")).catch(()=>{prompt("Copy this request note:",note);});return;
  }
  if(target.dataset.bulkft){
    const files=[...($("bulkft").files||[])];if(!files.length){message("Choose the files first.",true);return;}
    const byDoi=new Map(Object.values(data.articles).filter(a=>a.doi).map(a=>[a.doi.toLowerCase(),a.id]));
    const match=name=>{const base=name.replace(/\\.(pdf|xml)$/i,"");const pm=/(?:^|\\D)(\\d{6,9})(?:\\D|$)/.exec(base);if(pm&&data.articles[pm[1]])return pm[1];const d=/(10\\.\\d{4,9})[_\\/-]([^\\s]+)/.exec(base);if(d){const doi=(d[1]+"/"+d[2].replace(/_/g,"/")).toLowerCase();for(const [k,id] of byDoi)if(k===doi||doi.startsWith(k)||k.replace(/[\\/\\-_.]/g,"")===doi.replace(/[\\/\\-_.]/g,""))return id;}return "";};
    target.disabled=true;const out=$("bulkftresult");out.textContent="Working…";let ok=0;const bad=[];
    (async()=>{for(const f of files){const id=match(f.name);if(!id){bad.push(f.name+" (no PMID or DOI in the name matches an article)");continue;}if(f.size>20000000){bad.push(f.name+" (over 20 MB)");continue;}
      try{const buf=await f.arrayBuffer();let bin="";const u=new Uint8Array(buf);for(let i=0;i<u.length;i+=8192)bin+=String.fromCharCode.apply(null,u.subarray(i,i+8192));await api("fulltext-upload",{pmid:id,base64:btoa(bin)});ok++;out.textContent=ok+" uploaded…";}catch(e){bad.push(f.name+" ("+e.message+")");}}
      out.innerHTML=ok+" uploaded."+(bad.length?'<br><b style="color:var(--red)">Not added:</b> '+bad.map(esc).join("; "):"");message(ok+" full text"+(ok===1?"":"s")+" added.",bad.length>0);await refresh();})().finally(()=>{target.disabled=false;});
    return;
  }
  if(target.dataset.ftupload||target.dataset.ftpaste){
    const id=target.dataset.ftupload||target.dataset.ftpaste, done=r=>{message("Full text added"+(r.textRead?"; "+r.events+" event"+(r.events===1?"":"s")+" detected.":". Its text could not be read, so events come from the abstract."));return refresh().then(()=>{const open=document.querySelector('[data-review="'+active.id+'"]');if(open){$("dialog").close();open.click();}});};
    if(target.dataset.ftpaste){target.disabled=true;api("fulltext-upload",{pmid:id,text:$("ftpaste").value}).then(done).catch(e=>message(e.message,true)).finally(()=>{target.disabled=false;});return;}
    const file=$("ftfile").files[0];if(!file){message("Choose a PDF or XML file first.",true);return;}
    if(file.size>20000000){message("That file is larger than 20 MB.",true);return;}
    target.disabled=true;file.arrayBuffer().then(buf=>{let bin="";const u=new Uint8Array(buf);for(let i=0;i<u.length;i+=8192)bin+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return api("fulltext-upload",{pmid:id,base64:btoa(bin)});}).then(done).catch(e=>message(e.message,true)).finally(()=>{target.disabled=false;});
    return;
  }
  if(target.dataset.synfilter){synFilter=target.dataset.synfilter;render();return;}
  if(target.dataset.autoassign){target.disabled=true;api("cases-autoassign",{}).then(async r=>{await refresh();message(r.moved+" case"+(r.moved===1?"":"s")+" assigned.");}).catch(e=>{message(e.message,true);target.disabled=false;});return;}
  if(target.dataset.synexport){
    const ids=(data.cases||[]).filter(c=>{const s=synFilter;return s==="all"?!["Sent to PV Nexus","Closed: not a valid ICSR"].includes(c.status):s==="mine"?c.assignee===data.viewer.email:s==="unassigned"?!c.assignee:true;}).map(c=>c.id);
    target.disabled=true;
    fetch("/api/cases-export",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({format:target.dataset.synexport,ids:ids.length?ids:undefined})}).then(async res=>{if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(e.error||"Export failed.");}const name=(/filename="([^"]+)"/.exec(res.headers.get("Content-Disposition")||"")||[])[1]||"export";const link=document.createElement("a");link.href=URL.createObjectURL(await res.blob());link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),4000);}).catch(e=>message(e.message,true)).finally(()=>{target.disabled=false;});
    return;
  }
  if(target.dataset.icsrintake){
    target.disabled=true;
    api("icsr-intake",{}).then(async r=>{await refresh();message(r.created.length+" case"+(r.created.length===1?"":"s")+" added to the workbench"+(r.noEvents?" ("+r.noEvents+" skipped: no events detected)":"")+".");}).catch(e=>{message(e.message,true);target.disabled=false;});
    return;
  }
  if(target.dataset.newcase){
    target.disabled=true;
    api("case-create",{pmid:target.dataset.newcase}).then(async r=>{await refresh();if($("dialog").open)$("dialog").close();openCaseData(r.case,r.assessment);message("Case "+r.case.number+" created. Review the proposed values.");}).catch(e=>message(e.message,true)).finally(()=>{target.disabled=false;});return;
  }
  if(target.dataset.caseact){
    const act=target.dataset.caseact;
    if(act==="close"){$("casedlg").close();return;}
    if(act==="addprod"){collectCase();curCase.data.products.push(blankProduct());renderCase();return;}
    if(act==="addevent"){collectCase();curCase.data.events.push(blankEvent());renderCase();return;}
    target.disabled=true;
    (async()=>{
      try{
        if(["json","package","e2b","cioms","fhir","csv"].includes(act)){await downloadCase(act);}
        else if(act==="delete"){if(!confirm("Delete "+curCase.number+"? This cannot be undone (the audit trail keeps a record)."))return;await api("case-delete",{id:curCase.id});$("casedlg").close();await refresh();message("Case deleted.");}
        else{
          collectCase();
          if(act==="assess"){const r=await api("case-assess",{id:curCase.id,data:curCase.data});curAssess=r.assessment;$("caseassess").innerHTML=assessmentHtml(curAssess);}
          else{const r=await api("case-save",{id:curCase.id,status:curCase.status,data:curCase.data,notes:curCase.notes});curCase=JSON.parse(JSON.stringify(r.case));curAssess=r.assessment;renderCase();await refresh();message("Case saved.");}
        }
      }catch(e){$("caseerr").textContent=e.message;message(e.message,true);}
      finally{target.disabled=false;}
    })();
    return;
  }
  if(target.dataset.memdel){
    const all=target.dataset.memdel==="all";
    if(all&&!confirm("Delete all coding memory? Suggestions from earlier reviewed codings stop. Cases are not changed. This is recorded in the audit trail."))return;
    const reason=prompt(all?"Reason for deleting the memory (recorded in the audit trail):":"Reason for deleting this entry (recorded in the audit trail):","");
    if(reason===null)return;
    api("memory-delete",all?{all:true,reason}:{key:target.dataset.memdel,reason}).then(r=>{message(r.deleted+" entr"+(r.deleted===1?"y":"ies")+" deleted. Recorded in the audit trail.");return loadMemory();}).catch(e=>message(e.message,true));return;
  }
  if(target.dataset.keyremove){api("settings",{[target.dataset.keyremove]:null}).then(()=>{message("Key removed.");return refresh();}).catch(e=>message(e.message,true));return;}
  if(target.dataset.ncbiremove){api("settings",{ncbiApiKey:null}).then(()=>{message("API key removed.");return refresh();}).catch(e=>message(e.message,true));return;}
  if(target.dataset.rkadd){const rows=document.querySelectorAll(".rkrow"),last=rows.length?Number(rows[rows.length-1].querySelector(".rkt").value):0;rkAddRow(last?last+1:1,"");return;}
  if(target.dataset.rkdel){target.closest(".rkrow").remove();return;}
  if(target.dataset.rkpreview||target.dataset.rkapply){
    const ranges=rkRanges();
    const bad=ranges.some(r=>!Number.isInteger(r.from)||!Number.isInteger(r.to)||r.from<1||r.to<r.from||!r.owner);
    if(target.dataset.rkapply&&(!ranges.length||bad)){message("Give every range a start, an end and a person.",true);return;}
    if(target.dataset.rkapply&&!confirm("Assign these ranges now? This overwrites the current reviewer on those articles."))return;
    target.disabled=true;
    if(target.dataset.rkapply){
      api("assign-ranges",{...rkBody(),ranges}).then(r=>{message("Assigned "+Object.entries(r.per).map(([e,n])=>n+" to "+((data.profiles.find(p=>p.email===e)||{name:e}).name)).join(", ")+" (of "+r.total+" in the list).");return refresh();}).catch(e=>message(e.message,true)).finally(()=>{target.disabled=false;});
    }else{
      api("rank-list",rkBody()).then(r=>{
        const who=n=>{const x=ranges.find(q=>n>=q.from&&n<=q.to&&q.owner);return x?(data.profiles.find(p=>p.email===x.owner)||{name:x.owner}).name:"";};
        $("rkpreview").innerHTML=r.total?'<div class="sub" style="margin:6px 0">'+r.total+' articles in this list'+(r.total>300?" (first 300 shown)":"")+'</div>'+table(["#","Article","Relevance","Now","Will go to"],r.items.map(i=>[i.n,esc(i.title),'<span class="badge '+(levelColor[i.level]||"")+'">'+esc(i.level)+" "+i.score+'</span>',i.reviewer?esc((data.profiles.find(p=>p.email===i.reviewer)||{name:i.reviewer}).name):'<span class="sub">Unassigned</span>',who(i.n)?"<b>"+esc(who(i.n))+"</b>":'<span class="sub">—</span>']),"Nothing to list."):'<div class="empty">No articles match this list.</div>';
      }).catch(e=>message(e.message,true)).finally(()=>{target.disabled=false;});
    }
    return;
  }
  if(target.dataset.auditverify){
    target.disabled=true;$("auditverdict").textContent="Verifying every entry…";
    api("audit-verify",{}).then(r=>{$("auditverdict").innerHTML=r.ok?'<span class="badge green">Whole chain verified: '+r.entries_checked+' entries, none altered, removed or reordered.</span>':'<span class="badge red">Chain broken at entry '+esc(String(r.first_broken_sequence))+': '+esc(r.reason||"")+'</span>';}).catch(e=>message(e.message,true)).finally(()=>{target.disabled=false;});
    return;
  }
  if(target.dataset.auditanchor==="get"){
    api("audit-anchor",{}).then(r=>{const link=document.createElement("a");link.href=URL.createObjectURL(new Blob([JSON.stringify(r.anchor,null,2)],{type:"application/json"}));link.download="literasift-audit-anchor-"+new Date().toISOString().slice(0,10)+".json";link.click();setTimeout(()=>URL.revokeObjectURL(link.href),4000);message("Anchor downloaded. Keep it somewhere the app cannot write to, such as email or a locked folder.");}).catch(e=>message(e.message,true));
    return;
  }
  if(target.dataset.auditanchor==="check"){
    const input=document.createElement("input");input.type="file";input.accept=".json,application/json";
    input.onchange=async()=>{try{const anchor=JSON.parse(await input.files[0].text()),r=await api("audit-anchor-check",{anchor});$("auditverdict").innerHTML=r.ok?'<span class="badge green">Matches the anchor: nothing up to entry '+esc(String(r.sequence))+' changed since it was taken.</span>':'<span class="badge red">Does not match the anchor: '+esc(r.reason||"")+'</span>';}catch(e){message(e.message||"Could not read that file.",true);}};
    input.click();return;
  }
  if(target.dataset.signopen){openSign(target.dataset.signopen,target.dataset.id);return;}
  if(target.dataset.signgo){
    const b=target.dataset.signgo==="sign";target.disabled=true;$("signerr").textContent="";
    (async()=>{
      try{
        if(b){
          const pw=$("signpw");
          await api("sign",{kind:signCtx.kind,id:signCtx.id,meaning:$("signmeaning")?$("signmeaning").value:"",expected_content_sha256:signCtx.pre.content_sha256,reviewed_evidence_sha256:signCtx.pre.evidence_sha256,password:pw?pw.value:""});
          message("Signed.");
        }else{
          await api("supersede",{kind:signCtx.kind,id:signCtx.id,reason:$("signreason").value});message("Signature superseded and kept in the record.");
        }
        await refresh();if(curCase&&signCtx.kind==="case"&&$("casedlg").open){const c=(data.cases||[]).find(x=>x.id===curCase.id);if(c){curCase=JSON.parse(JSON.stringify(c));renderCase();}}
        await openSign(signCtx.kind,signCtx.id);
      }catch(e){$("signerr").textContent=e.message;}
      finally{target.disabled=false;}
    })();
    return;
  }
  if(target.dataset.auditcsv&&auditData){
    const q=auditQ.trim().toLowerCase(), rows=auditData.entries.filter(e=>(!auditAction||e.action.split(".")[0]===auditAction)&&(!q||(e.by+" "+e.action+" "+e.target+" "+e.detail).toLowerCase().includes(q)));
    const cell=v=>'"'+String(v??"").replace(/^[=+@\\-]/,"'$&").replaceAll('"','""')+'"';
    const link=document.createElement("a");link.href=URL.createObjectURL(new Blob([[["Sequence","Time (UTC)","User","Action","Entity","Detail","Hash"]].concat(rows.map(e=>[e.sequence==null?"":e.sequence,e.at,e.by,e.action,(e.entityType?e.entityType+" ":"")+e.target,e.detail,e.hash||""])).map(r=>r.map(cell).join(",")).join("\\r\\n")],{type:"text/csv"}));
    link.download="literasift-audit-"+auditData.month+".csv";link.click();setTimeout(()=>URL.revokeObjectURL(link.href),4000);
    return;
  }
  if(target.dataset.libopen){event.preventDefault();libPath=target.dataset.libopen;render();return;}
  if(target.dataset.delwatch){
    if(!confirm("Delete this watchlist? It stops pulling new articles. Articles, files and past pulls are kept."))return;
    api("delete-watch",{watch:target.dataset.delwatch}).then(()=>{message("Watchlist deleted.");return refresh();}).catch(e=>message(e.message,true));
    return;
  }
  if(target.dataset.libdel||target.dataset.articledel){
    const ids=target.dataset.articledel?[target.dataset.articledel]:libIds(target.dataset.libdel);
    if(!ids.length){message("Nothing to delete here.",true);return;}
    if(!confirm("Delete "+ids.length+" article"+(ids.length===1?"":"s")+" from the library? Their stored files, screenshots and queue entries are removed. Articles that have an ICSR case are kept. This is recorded in the audit trail and cannot be undone."))return;
    const reason=prompt("Reason for deleting (recorded in the audit trail):","");if(!reason)return;
    target.disabled=true;
    api("library-delete",{pmids:ids,reason}).then(async r=>{await refresh();if($("dialog").open)$("dialog").close();if(!target.dataset.articledel&&target.dataset.libdel!=="/"&&!libIds(target.dataset.libdel).length){libPath="/";}render();message(r.deleted+" article"+(r.deleted===1?"":"s")+" deleted. Recorded in the audit trail."+(r.kept.length?" Kept because they have cases: "+r.kept.join(", ")+".":""),r.kept.length>0);}).catch(e=>message(e.message,true)).finally(()=>{target.disabled=false;});
    return;
  }
  if(target.dataset.libzip||target.dataset.libpdf||target.dataset.libris){
    const kind=target.dataset.libzip?"zip":target.dataset.libpdf?"pdf":"ris", path=target.dataset[kind==="zip"?"libzip":kind==="pdf"?"libpdf":"libris"];
    const ids=libIds(path), name=path==="/"?"LiteraSift library":path.replace("/"," ").replace(/_to_/g," to ");
    target.disabled=true;
    (kind==="zip"?exportFile("export-fulltext","zip",ids,name,"","ZIP",{layout:libMode==="country"?"country":true}):kind==="pdf"?exportFile("export","pdf",ids,name,"Library folder "+path,"PDF",{layout:libMode==="country"?"country":true}):exportFile("export-citations","ris",ids,name+" citations","","citations",{format:"ris"}))
      .catch(e=>message(e.message,true)).finally(()=>{target.disabled=false;});
    return;
  }
  if(target.dataset.retrieval){
    const list=applyFilter(shown).filter(a=>!(data.articles[a.pmid]||{}).fullTextKey);
    if(!list.length){message("Every article in this list already has full text stored.");return;}
    if(target.dataset.retrieval==="flag"){
      target.disabled=true;
      api("bulk-status",{ids:list.map(a=>a.pmid),status:"Full text needed"}).then(r=>{message(r.updated+" article"+(r.updated===1?"":"s")+" flagged.");return refresh();}).catch(e=>message(e.message,true)).finally(()=>{target.disabled=false;});
      return;
    }
    const cell=v=>'"'+String(v??"").replace(/^[=+@\\-]/,"'$&").replaceAll('"','""')+'"';
    const rows=[["Source","PMID","Title","Journal","Date","DOI","DOI link","PubMed link","Access","Full-text status","Free LinkOut link","Portfolio","Molecules","Reviewer"]].concat(list.map(a=>{const x=data.articles[a.pmid]||{};
      return [sourceOf(x),a.pmid,x.title,x.journal,x.date,x.doi,x.doi?"https://doi.org/"+x.doi:"",x.url,x.oaStatus||"",x.fullTextStatus||"",((x.linkOut||[]).find(l=>l.free)||{}).url||"",a.portfolio,(a.molecules||[]).join("; "),a.reviewer||""];}));
    const link=document.createElement("a");link.href=URL.createObjectURL(new Blob([rows.map(r=>r.map(cell).join(",")).join("\\r\\n")],{type:"text/csv"}));
    link.download="literasift-retrieval-list.csv";link.click();setTimeout(()=>URL.revokeObjectURL(link.href),4000);
    message(list.length+" articles listed.");
    return;
  }
  if(target.dataset.cite){
    const run=target.dataset.scope!=="queue"&&data.runs.find(r=>r.id===target.dataset.scope);
    const mine=new Set(data.assignments.map(a=>a.pmid));
    const ids=run?run.ids.filter(id=>mine.has(id)):applyFilter(shown).map(a=>a.pmid);
    const fmt=target.dataset.cite;
    target.disabled=true;
    exportFile("export-citations",fmt==="bibtex"?"bib":"ris",ids,run?(run.molecule||run.portfolio)+" citations":"LiteraSift citations","","citations",{format:fmt}).catch(e=>message(e.message,true)).finally(()=>{target.disabled=false;});
    return;
  }
  if(target.dataset.suggest){
    const name=document.querySelector('form[data-route=pull] [name=molecule]').value.trim();
    if(!name){message("Type the molecule name first.",true);return;}
    target.disabled=true;
    api("suggest-synonyms",{name}).then(r=>{
      $("suggest").innerHTML=r.names.length?'<div class="sub" style="margin:8px 0 4px">Tap to add (RxNorm brands and ingredients, PubChem synonyms):</div><div class="chips">'+r.names.map(n=>'<button type="button" class="badge" style="cursor:pointer" data-addsyn="'+esc(n)+'">+ '+esc(n)+'</button>').join("")+'</div>':'<div class="sub" style="margin-top:8px">No suggestions found.</div>';
    }).catch(e=>message(e.message,true)).finally(()=>{target.disabled=false;});
    return;
  }
  if(target.dataset.addsyn){
    const input=document.querySelector('form[data-route=pull] [name=synonyms]'), current=input.value.split(/[,;]/).map(x=>x.trim()).filter(Boolean);
    if(!current.some(x=>x.toLowerCase()===target.dataset.addsyn.toLowerCase()))current.push(target.dataset.addsyn);
    input.value=current.join(", ");target.style.opacity=.4;
    return;
  }
  if(target.dataset.zip){
    const run=target.dataset.zip!=="queue"&&data.runs.find(r=>r.id===target.dataset.zip);
    const mine=new Set(data.assignments.map(a=>a.pmid));
    const ids=run?run.ids.filter(id=>mine.has(id)):applyFilter(shown).map(a=>a.pmid);
    const title=run?(run.molecule||run.portfolio)+" full text "+run.from+" to "+run.to:"LiteraSift full text "+(filt.portfolio||"all portfolios");
    target.disabled=true;
    exportFile("export-fulltext","zip",ids,title,"","ZIP").catch(e=>message(e.message,true)).finally(()=>{target.disabled=false;});
    return;
  }
  if(target.dataset.resetlink){
    target.disabled=true;
    api("/host/reset-link",{email:target.dataset.resetlink}).then(async r=>{
      if(r.emailed)message("Email sent to "+target.dataset.resetlink+".");
      else showLink("Link for "+target.dataset.resetlink,(r.mailError?r.mailError+" ":"")+"Send this link to them yourself. It works once.",r.link);
      await refresh();
    }).catch(e=>message(e.message,true)).finally(()=>{target.disabled=false;});
    return;
  }
  if(target.dataset.revoke){
    if(!confirm("Remove sign-in access for "+target.dataset.revoke+"? Their assignments stay."))return;
    api("/host/revoke",{email:target.dataset.revoke}).then(()=>{message("Access revoked.");return refresh();}).catch(e=>message(e.message,true));
    return;
  }
  if(target.dataset.pdf||target.dataset.pdfrun){
    const run=target.dataset.pdfrun&&data.runs.find(r=>r.id===target.dataset.pdfrun);
    const mine=new Set(data.assignments.map(a=>a.pmid));
    const ids=run?run.ids.filter(id=>mine.has(id)):applyFilter(shown).map(a=>a.pmid);
    const title=run?(run.molecule||run.portfolio)+" "+run.from+" to "+run.to:"LiteraSift "+(filt.portfolio||"all portfolios");
    target.disabled=true;
    exportPdf(ids,title,run?"Articles pulled for "+(run.molecule||run.portfolio)+", "+run.from+" to "+run.to+".":"Filtered list from the screening queue.").catch(e=>message(e.message,true)).finally(()=>{target.disabled=false;});
    return;
  }
  if(target.dataset.tab){tab=target.dataset.tab;render();}
  if(target.dataset.export)download(target.dataset.export);
  if(target.dataset.review){
    active=data.assignments.find(a=>a.id===target.dataset.review);
    const art=data.articles[active.pmid];
    $("citation").textContent=art.title;
    $("screensign").dataset.id=active.id;$("screensign").textContent=(active.signatures||[]).some(x=>!x.superseded)?"Signed · view signature":"Sign decision…";
    $("detail").innerHTML=(art.abstract?'<div class="sub" style="margin-bottom:4px">Abstract'+(art.abstractSource?" ("+esc(art.abstractSource)+")":"")+'</div><div style="font-size:13px;line-height:1.55">'+mark(art.abstract,active.molecules,(art.entities||{}).diseases)+'</div>':'<div class="sub">No abstract available yet.</div>')+
      (((art.entities||{}).diseases||[]).length?'<div class="sub" style="margin:10px 0 4px">Conditions mentioned (PubTator)</div><div class="chips">'+art.entities.diseases.map(t=>badge(t,"amber")).join("")+'</div>':"")+
      (((art.entities||{}).chemicals||[]).length?'<div class="sub" style="margin:10px 0 4px">Chemicals mentioned</div><div class="chips">'+art.entities.chemicals.map(t=>badge(t)).join("")+'</div>':"")+
      ((art.keyPassages||[]).length?'<div class="sub" style="margin:10px 0 4px">Key passages from the full text</div>'+art.keyPassages.map(t=>'<div style="font-size:13px;margin-bottom:6px">“'+mark(t,active.molecules)+'”</div>').join(""):"")+
      ((art.meshTerms||[]).length?'<div class="chips">'+art.meshTerms.slice(0,12).map(t=>badge(t)).join("")+'</div>':"")+
      ((art.authors||[]).length?'<div class="sub" style="margin-top:8px">'+esc(art.authors.join(", "))+'</div>':"")+
      factsHtml(art.caseFacts,active.molecules)+
      (((art.events||[]).length)?'<div class="sub" style="margin:10px 0 4px">Detected events'+(data.config.ime&&data.config.ime.loaded?" (IME list: MedDRA "+esc(data.config.ime.version)+")":" (load the IME list in Settings to flag important medical events)")+'</div>'+art.events.map(e=>'<div class="row" style="align-items:flex-start"><span>'+(e.ime?badge("IME","red")+" ":"")+'<b>'+esc(e.term)+'</b>'+(e.confidence!==undefined?" "+tbadge(Math.round(e.confidence*100)+"%",e.confidence>=0.7?"green":e.confidence>=0.45?"amber":"","Confidence: "+(e.why||[]).join("; ")):"")+(e.withDrug?" "+badge("with "+(active.molecules[0]||"drug"),"blue"):"")+'<div class="sub">'+esc((e.kinds||[]).join(" · "))+(e.evidence?" · “"+esc(e.evidence)+"”":"")+'</div></span></div>').join(""):"")+
      (artCountry(art)?'<div class="sub" style="margin:10px 0 4px">Country</div><div class="chips"><span class="badge">'+esc(artCountry(art))+' · '+esc(artCountryBasis(art))+'</span>'+(art.patientCountry?'<span class="badge">Patient: '+esc(art.patientCountry.name)+'</span>':'')+(art.affiliationCountry?'<span class="badge">Author affiliation: '+esc(art.affiliationCountry)+'</span>':'')+(art.journalCountry?'<span class="badge">Journal: '+esc(art.journalCountry)+'</span>':'')+maChip(active.molecules,artCountry(art))+'</div>':'')+
      ((art.linkOut||[]).length?'<div class="sub" style="margin:10px 0 4px">PubMed LinkOut'+(art.pubmedCitedBy!==undefined?" · cited by "+art.pubmedCitedBy+" in PubMed":"")+'</div><div class="chips">'+art.linkOut.map(l=>'<a class="badge '+(l.free?"green":"blue")+'" target="_blank" rel="noopener" href="'+esc(l.url)+'">'+esc((l.free?"Free: ":"")+l.provider)+'</a>').join("")+'</div>':"")+
      '<div style="margin-top:10px"><button type="button" class="btn outline sm" data-newcase="'+esc(active.pmid)+'">Send to Synchrony</button> '+(data.cases||[]).filter(c=>c.pmid===active.pmid).map(c=>'<a href="#" data-opencase="'+esc(c.id)+'">'+esc(c.number)+'</a>').join(" · ")+'</div>'+
      (art.fullTextKey?'<div style="margin-top:8px"><a href="/api/full-text/'+esc(active.pmid)+'">Download full text</a>'+(art.fullTextOrigin==="Uploaded"?' <span class="sub">(uploaded by '+esc(art.fullTextUploadedBy||"")+')</span>':"")+'</div>':"")+
      closedAccessHtml(art)+(data.viewer.role==="manager"?'<div style="margin-top:12px"><button type="button" class="btn outline sm" data-articledel="'+esc(active.pmid)+'" style="color:var(--red)">Delete this article from the library</button></div>':"");
    $("review").elements.status.value=active.status;
    $("review").elements.note.value=active.note||"";
    $("dialog").showModal();
  }
});
$("close").onclick=()=>$("dialog").close();
$("linkclose").onclick=()=>$("linkdlg").close();
$("linkcopy").onclick=async()=>{try{await navigator.clipboard.writeText($("linkvalue").value);message("Link copied.");}catch{$("linkvalue").select();message("Press and hold the link to copy it.");}};
$("linkshare").onclick=()=>navigator.share({title:"LiteraSift",url:$("linkvalue").value}).catch(()=>{});
document.addEventListener("submit",async event=>{
  if(event.target.getAttribute("action")==="/logout")return;   // a normal form post (host sign-out); the app must not intercept it
  event.preventDefault();
  const form=event.target, button=form.querySelector("button");
  const body=Object.fromEntries(new FormData(form));
  if(body.active)body.active=body.active==="true";
  if(body.storeRestricted)body.storeRestricted=body.storeRestricted==="true";
  const route=form.dataset.route || "review";
  if(route==="assign-molecule")body.reassign=body.reassign==="on";
  if(route==="review")body.id=active.id;
  if(route==="pull"){["safety","humans","caseReports","english","noReviews"].forEach(k=>{body[k==="safety"?"safetyOnly":k]=body[k]==="on";});}
  if(route==="watches"){
    body.safetyOnly=body.safety==="on";
    body.rows=body.list.split(/\\r?\\n/).map(line=>line.split(/[,;\\t]/).map(x=>x.trim()).filter(Boolean)).filter(n=>n.length).map(n=>({molecule:n[0],synonyms:n.slice(1)}));
  }
  if(route==="/host/change-password"){
    if(body.next!==body.confirm){message("The new passwords don't match.",true);return;}
    delete body.confirm;
  }
  button.disabled=true;message(route==="import"||route==="pull"||route==="pmid-batch"?"Retrieving PubMed citations…":"Saving…");
  try {const result=await api(route,body);if(route==="review")$("dialog").close();await refresh();
    if(route==="pull"){pullRun=result.id;drawProgress();extractRun(result.id);}
    if(route==="social-add"){form.reset();message(result.added+" post"+(result.added===1?"":"s")+" added; personal data masked.");return;}
    if(route==="pmid-batch"){pullRun=result.run.id;drawProgress();extractRun(result.run.id);form.reset();message(result.run.count+" of "+result.requested+" article"+(result.requested===1?"":"s")+" added; looking for full texts."+(result.missing.length?" Not found in PubMed: "+result.missing.slice(0,10).join(", ")+(result.missing.length>10?"…":"")+".":""),result.missing.length>0);return;}
    if(route==="/host/invite"&&result.link)showLink("Invite link for "+body.email,(result.mailError?result.mailError+" ":"Email isn't configured. ")+"Send this link to them yourself. It works once and expires in 7 days.",result.link);
    if(route==="/host/change-password")form.reset();
    message(route==="assign-molecule"?result.moved+" article"+(result.moved===1?"":"s")+" assigned.":route==="/host/invite"?(result.existing?"Profile updated.":result.emailed?"Invite emailed to "+body.email+".":"Profile saved."):route==="/host/change-password"?"Password changed.":route==="recheck-access"?"Open-access check queued for all articles.":route==="import"?"Batch imported.":route==="pull"?result.count+" articles pulled for "+(result.molecule||result.portfolio)+".":route==="watches"?result.created+" molecule watchlists saved."+(result.skipped.length?" Skipped (invalid or too long): "+result.skipped.join(", "):""):"Saved.");}
  catch(error){message(error.message,true);if(route==="review")$("dialog").close();if(route==="import"||route==="pull")await refresh().catch(()=>{});}
  finally{button.disabled=false;}
});
refresh().catch(error=>message(error.message,true));
</script></html>`;

const importTool = {
  name: "run_pubmed_watchlists",
  description: "Run saved Literature Bench watchlists through the last complete IST calendar day. Save the batch, deduplicate PMIDs and allocate reviewer work.",
  inputSchema: { type:"object", properties:{}, additionalProperties:false }
};
async function mcp(request, env) {
  const call = await request.clone().json();
  const reply = result => json({ jsonrpc:"2.0", id:call.id, result });
  if (call.method === "server/discover") return reply({ supportedVersions:["2026-07-28"], capabilities:{ tools:{} }, serverInfo:{ name:"literature-bench",version:"1.0.0" } });
  if (call.method === "initialize") return reply({ protocolVersion:call.params?.protocolVersion || "2025-03-26", capabilities:{tools:{}}, serverInfo:{name:"literature-bench",version:"1.0.0"} });
  if (call.method === "notifications/initialized") return new Response(null,{status:202});
  if (call.method === "tools/list") return reply({ tools:[importTool] });
  if (call.method === "tools/call" && call.params?.name === importTool.name) {
    let result;
    try { result = await api(request, env, "/api/scheduled"); }
    catch (error) { result = json({ error:error.message },500); }
    const body = await result.json();
    return reply({ isError:!result.ok || Boolean(body.results?.some(row=>row.error)), content:[{type:"text",text:JSON.stringify(body)}] });
  }
  return json({jsonrpc:"2.0",id:call.id,error:{code:-32601,message:"Method not found"}});
}

export default {
  execute, libraryLayout, maskPii, parsePmidList, captureFromPreprint, captureFromWiley, captureFromElsevier, captureFromCore, captureFromRxiv, applyDetection, seriesSummary, robustHikes, ciomsPdf, fhirBundle, lineListing, e2bBatch, caseNarrativeText, normalizeCase, readXlsx, parseImeWorkbook, audit, verifyAuditChain, auditAnchor,
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/mcp" && request.method === "POST") return mcp(request,env);
    if (!path.startsWith("/api/")) return new Response(html, { headers: { "Content-Type":"text/html; charset=utf-8" } });
    try { return await api(request, env, path); }
    catch (error) { return json({ error:error.message }, 500); }
  }
};
