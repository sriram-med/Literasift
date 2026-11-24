const KEY = "bench.json";
const blank = () => ({ profiles: [], watches: [], articles: {}, assignments: [], runs: [] });
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
async function pubmed(operation, params) {
  const url = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/" + operation + ".fcgi");
  url.search = new URLSearchParams({ db: "pubmed", tool: "literature_bench", ...params });
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error("PubMed returned HTTP " + response.status);
  return response.json();
}
function allocate(state, item) {
  const candidates = state.profiles.filter(p => p.role === "reviewer" && p.active &&
    (!p.portfolio || p.portfolio.toLowerCase() === item.portfolio.toLowerCase()));
  const open = p => state.assignments.filter(a => a.reviewer === p.email && a.status !== "Complete").length;
  const reviewer = candidates.map(p => ({ ...p, open: open(p) }))
    .filter(p => p.open < p.capacity).sort((a, b) => a.open - b.open || a.email.localeCompare(b.email))[0];
  if (reviewer) item.reviewer = reviewer.email;
}
const addDays = (value, days) => new Date(Date.parse(value) + days * 86400000).toISOString().slice(0, 10);
// A search over the 9,999-record limit is split into halves of the date range until every part fits.
async function searchIds(watch, from, to, depth = 0) {
  const date = value => value.replaceAll("-", "/");
  const term = "(" + watch.query + ") AND (" + date(from) + "[crdt]:" + date(to) + "[crdt])";
  const { esearchresult: result } = await pubmed("esearch", { term, retmode: "json", retmax: "9999" });
  if (!result?.idlist) throw new Error("PubMed search was incomplete.");
  if (Number(result.count) === result.idlist.length) return result.idlist;
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (days < 1 || depth > 12) throw new Error("A single day exceeds the 9,999 record batch limit. Narrow the query.");
  const middle = addDays(from, Math.floor(days / 2));
  await new Promise(resolve => setTimeout(resolve, 350));
  const left = await searchIds(watch, from, middle, depth + 1);
  await new Promise(resolve => setTimeout(resolve, 350));
  const right = await searchIds(watch, addDays(middle, 1), to, depth + 1);
  return [...new Set([...left, ...right])];
}
async function importWatch(env, watch, from, to) {
  const result = { idlist: await searchIds(watch, from, to) };
  const articles = {};
  for (let offset = 0; offset < result.idlist.length; offset += 100) {
    const ids = result.idlist.slice(offset, offset + 100);
    await new Promise(resolve => setTimeout(resolve, 350));
    const { result: summary } = await pubmed("esummary", { id: ids.join(","), retmode: "json" });
    for (const id of ids) {
      const citation = summary?.[id];
      if (!citation?.title) throw new Error("Missing citation for PMID " + id);
      articles[id] = { id, title:citation.title, journal:citation.fulljournalname, date:citation.pubdate,
        doi:citation.articleids?.find(a => a.idtype === "doi")?.value || "",
        pmcid:citation.articleids?.find(a => a.idtype === "pmc")?.value || "",
        pubmedRetracted:(citation.pubtype || []).includes("Retracted Publication"),
        url:"https://pubmed.ncbi.nlm.nih.gov/" + id + "/" };
    }
  }
  return write(env, state => {
    for (const [id, article] of Object.entries(articles)) state.articles[id] = { ...state.articles[id], ...article };
    const run = { id:crypto.randomUUID(), portfolio:watch.portfolio, molecule:watch.molecule || "", from, to, count:result.idlist.length,
      ids:result.idlist, time:new Date().toISOString(), query:watch.query, status:"Imported" };
    state.runs.unshift(run);
    for (const id of result.idlist) {
      // One assignment per citation and portfolio; further matching molecules are tagged onto it.
      const existing = state.assignments.find(a => a.pmid === id && a.portfolio === watch.portfolio);
      if (existing) {
        if (watch.molecule && !(existing.molecules || []).includes(watch.molecule) && (existing.molecules || []).length < 20) (existing.molecules ||= []).push(watch.molecule);
        continue;
      }
      const item = { id:crypto.randomUUID(), pmid:id, portfolio:watch.portfolio, molecules:watch.molecule ? [watch.molecule] : [], reviewer:"", status:"Pending" };
      allocate(state, item);
      state.assignments.push(item);
    }
    return run;
  });
}
async function execute(env, watch, from, to) {
  try { return await importWatch(env, watch, from, to); }
  catch (error) {
    await write(env, state => state.runs.unshift({ id:crypto.randomUUID(), portfolio:watch.portfolio, molecule:watch.molecule || "", from, to,
      query:watch.query, status:"Failed", error:error.message, time:new Date().toISOString(), ids:[], count:0 }));
    throw error;
  }
}
const safetyFilter = '("adverse effects"[sh] OR "drug-related side effects and adverse reactions"[MeSH Terms] OR safety[tiab] OR toxicity[tiab] OR "adverse event*"[tiab] OR "adverse reaction*"[tiab] OR "adverse drug reaction*"[tiab] OR "side effect*"[tiab])';
function buildQuery(names, safetyOnly) {
  const clean = [...new Set(names.map(n => String(n || "").replace(/["\[\]()*]/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean))];
  if (!clean.length || clean.length > 30 || clean.some(n => n.length > 100)) return "";
  const terms = clean.map(n => '"' + n + '"[tiab] OR "' + n + '"[MeSH Terms] OR "' + n + '"[Supplementary Concept]');
  const query = "(" + terms.join(" OR ") + ")" + (safetyOnly ? " AND " + safetyFilter : "");
  return query.length <= 1500 ? query : "";
}
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
  const item = versions.filter(v => ["CC0","CC BY","CC BY-SA","CC BY-ND"].includes(String(v.license_code)
      .trim().toUpperCase().replace(/^CC[-_]/,"CC ").replace(/_/g,"-")))
    .sort((a,b) => Number(a.is_manuscript === "yes") - Number(b.is_manuscript === "yes") || Number(b.version) - Number(a.version))[0];
  if (!item) return {fullTextStatus:"No eligible PMC file"};
  const version = String(item.version);
  if (!/^[0-9]+$/.test(version)) throw new Error("Invalid PMC version.");
  const filename = article.pmcid + "." + version;
  const format = item.pdf_url ? "pdf" : "xml";
  const file = filename + "." + format;
  const url = pmcOrigin + "/" + filename + "/" + file;
  const response = await fetch(url, {signal:AbortSignal.timeout(25000)});
  if (!response.ok || !response.body) throw new Error("PMC file returned HTTP " + response.status);
  const key = "evidence/" + article.id + "/" + file;
  await env.BUCKET.put(key, response.body, {httpMetadata:{contentType:format === "pdf" ? "application/pdf" : "application/xml"}});
  return {fullTextStatus:"Captured", fullTextKey:key, fullTextLicense:item.license_code, fullTextSource:url, fullTextOrigin:"PMC"};
}
// Unpaywall fallback: only stores PDFs under the same permissive licences accepted for PMC; otherwise keeps the link only.
const openLicenses = ["cc0","cc-by","cc-by-sa","cc-by-nd"];
const maxPdfBytes = 25 * 1024 * 1024;
async function captureFromUnpaywall(env, article, reason) {
  if (!env.UNPAYWALL_EMAIL) return { fullTextStatus:reason };
  if (!/^10\.\d{4,9}\/\S+$/.test(article.doi)) return { fullTextStatus:"No DOI for open-access lookup" };
  const lookup = new URL("https://api.unpaywall.org/v2/" + encodeURIComponent(article.doi));
  lookup.searchParams.set("email", env.UNPAYWALL_EMAIL);
  const response = await fetch(lookup, { signal:AbortSignal.timeout(15000) });
  if (response.status === 404) return { fullTextStatus:"Not in Unpaywall" };
  if (!response.ok) throw new Error("Unpaywall returned HTTP " + response.status);
  const data = await response.json();
  if (!data.is_oa) return { fullTextStatus:"No open-access copy" };
  const locations = [data.best_oa_location, ...(data.oa_locations || [])].filter(Boolean);
  const license = l => String(l.license || "").toLowerCase();
  const rank = l => (l.version === "publishedVersion" ? 0 : l.version === "acceptedVersion" ? 1 : 2);
  const pdfs = locations.filter(l => /^https:\/\//.test(l.url_for_pdf || "") && openLicenses.includes(license(l))).sort((a, b) => rank(a) - rank(b));
  for (const location of pdfs.slice(0, 3)) {
    try {
      const file = await fetch(location.url_for_pdf, { signal:AbortSignal.timeout(25000), headers:{ Accept:"application/pdf" } });
      if (!file.ok) continue;
      const bytes = await file.arrayBuffer();
      if (bytes.byteLength > maxPdfBytes || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") continue;
      const key = "evidence/" + article.id + "/unpaywall.pdf";
      await env.BUCKET.put(key, bytes, { httpMetadata:{ contentType:"application/pdf" } });
      return { fullTextStatus:"Captured", fullTextKey:key, fullTextLicense:license(location), fullTextSource:location.url_for_pdf,
        fullTextOrigin:"Unpaywall", fullTextVersion:location.version || "" };
    } catch { /* try the next location */ }
  }
  const link = locations.map(l => l.url_for_landing_page || l.url).find(u => /^https:\/\//.test(u || ""));
  return link ? { fullTextStatus:"Open access link only", fullTextLink:link } : { fullTextStatus:"No downloadable open-access copy" };
}
async function captureFullText(env, article) {
  const pmc = await captureFromPmc(env, article);
  if (pmc.fullTextStatus === "Captured") return pmc;
  return captureFromUnpaywall(env, article, pmc.fullTextStatus);
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
async function captureScreenshot(env, article) {
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
async function collectEvidence(env, ids) {
  const {state} = await load(env);
  const articles = ids ? ids.map(id=>state.articles[id]).filter(Boolean) : Object.values(state.articles);
  const enabled = Boolean(env.SCREENSHOT_ENDPOINT && env.SCREENSHOT_TOKEN);
  const needsFullText = a => !a.fullTextStatus || a.fullTextStatus === "Retry needed" ||
    (Boolean(env.UNPAYWALL_EMAIL) && ["No PMC record","No eligible PMC file"].includes(a.fullTextStatus));
  const needsScreen = a => enabled && !a.screenshotKey;
  const needsRetraction = a => !a.retractionCheckedAt || Date.now() - Date.parse(a.retractionCheckedAt) > retractionRecheckMs;
  const pending = articles.filter(a=>needsFullText(a) || needsScreen(a) || needsRetraction(a))
    .sort((a,b)=>String(a.evidenceAttempt || "").localeCompare(String(b.evidenceAttempt || ""))).slice(0,4);
  for (const article of pending) {
    const status = {evidenceAttempt:new Date().toISOString()};
    if (needsFullText(article)) {
      try { Object.assign(status,await captureFullText(env,article)); }
      catch (error) { Object.assign(status,{fullTextStatus:"Retry needed",fullTextError:error.message}); }
    }
    if (needsScreen(article)) {
      try { Object.assign(status,await captureScreenshot(env,article)); }
      catch { status.screenshotStatus="Retry needed"; }
    }
    if (needsRetraction(article)) {
      try { Object.assign(status,await checkRetraction(env,article)); }
      catch (error) { status.retractionError = error.message; }
    }
    await write(env, data => Object.assign(data.articles[article.id],status));
  }
  return {processed:pending.length, unattempted:articles.filter(a=>!a.evidenceAttempt).length,
    screenshotConfigured:enabled};
}

async function api(request, env, path) {
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
    const assignments = state.assignments.filter(a => manager || a.reviewer === email);
    return json({ viewer, profiles:manager ? state.profiles : [viewer], watches:manager ? state.watches : [],
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
    const headers = new Headers({"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff",
      "Content-Disposition":'attachment; filename="'+key.split("/").pop()+'"'});
    object.writeHttpMetadata(headers);
    return new Response(object.body,{headers});
  }
  if (request.method !== "POST") return json({ error:"Route unavailable." }, 404);
  const body = await request.json().catch(() => ({}));
  if (path === "/api/review" && viewer) {
    if (!["Pending","In review","Complete","Full text needed"].includes(body.status)) return json({error:"Invalid status."},400);
    await write(env, data => {
      const item = data.assignments.find(a => a.id === body.id && (manager || a.reviewer === email));
      if (!item) throw new Error("Assignment unavailable.");
      item.status = body.status;
      item.note = String(body.note || "").slice(0, 4000);
      (item.history ||= []).push({ status:item.status, note:item.note, by:email, at:new Date().toISOString() });
    });
    return json({ ok:true });
  }
  if (path === "/api/scheduled" && (service || manager)) {
    const results = [];
    const to = new Date(Date.parse(day()) - 86400000).toISOString().slice(0,10);
    const same = watch => r => r.portfolio === watch.portfolio && (r.molecule || "") === (watch.molecule || "") && r.query === watch.query;
    // Watchlists never attempted go first, then the least recently attempted; at most maxWatchesPerRun run per call.
    const due = state.watches.map(watch => ({ watch, previous:state.runs.find(r => same(watch)(r) && r.status === "Imported"),
        attempt:state.runs.find(same(watch))?.time || "" }))
      .filter(({ previous }) => !(previous?.to >= to)).sort((a, b) => a.attempt.localeCompare(b.attempt));
    for (const { watch, previous } of due.slice(0, maxWatchesPerRun)) {
      try { results.push(await execute(env, watch, previous?.to || to, to)); }
      catch (error) { results.push({ portfolio:watch.portfolio, molecule:watch.molecule || "", error:error.message }); }
    }
    return json({ results, remaining:Math.max(0, due.length - maxWatchesPerRun), evidence:await collectEvidence(env) });
  }
  if (!manager) return json({ error:"Manager access required." },403);
  if (path === "/api/evidence") return json(await collectEvidence(env));
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
  } else if (path === "/api/watch") {
    const watch = { portfolio:String(body.portfolio || "").trim(), molecule:String(body.molecule || "").trim().slice(0,100), query:String(body.query || "").trim() };
    if (!watch.portfolio || !watch.query || watch.query.length > 1500) return json({error:"Enter a portfolio and a PubMed query."},400);
    await write(env, data => {
      data.watches = data.watches.filter(w => watchKey(w) !== watchKey(watch));
      data.watches.push(watch);
    });
  } else if (path === "/api/watches") {
    const portfolio = String(body.portfolio || "").trim();
    if (!portfolio || !Array.isArray(body.rows) || !body.rows.length || body.rows.length > 500) return json({error:"Enter a portfolio and 1 to 500 molecules."},400);
    const created = [], skipped = [];
    for (const row of body.rows) {
      const names = [row?.molecule, ...(Array.isArray(row?.synonyms) ? row.synonyms : [])];
      const molecule = String(row?.molecule || "").trim().slice(0,100);
      const query = molecule && buildQuery(names, body.safetyOnly === true);
      if (query) created.push({ portfolio, molecule, query }); else skipped.push(molecule || "(blank)");
    }
    await write(env, data => {
      const keys = new Set(created.map(watchKey));
      data.watches = data.watches.filter(w => !keys.has(watchKey(w))).concat(created);
    });
    return json({ created:created.length, skipped });
  } else if (path === "/api/pull") {
    // One step: build the query for a molecule, save it as a watchlist, and import the date range.
    const valid = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
    const molecule = String(body.molecule || "").trim().slice(0,100);
    const synonyms = String(body.synonyms || "").split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
    const portfolio = String(body.portfolio || "").trim().slice(0,100) || molecule;
    const query = molecule && buildQuery([molecule, ...synonyms], body.safetyOnly === true);
    if (!query) return json({error:"Enter a molecule name (up to 30 names, 100 characters each)."},400);
    if (!valid(body.from) || !valid(body.to) || body.from > body.to || body.to > day()) {
      return json({error:"Choose a valid date range through today."},400);
    }
    const watch = { portfolio, molecule, query };
    await write(env, data => {
      data.watches = data.watches.filter(w => watchKey(w) !== watchKey(watch));
      data.watches.push(watch);
    });
    const run = await execute(env, watch, body.from, body.to);
    await collectEvidence(env, run.ids);
    return json(run);
  } else if (path === "/api/import") {
    const [portfolio, molecule = ""] = String(body.watch || "").split("|").map(decodeURIComponent);
    const watch = state.watches.find(w => w.portfolio === portfolio && (w.molecule || "") === molecule);
    const valid = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
    if (!watch || !valid(body.from) || !valid(body.to) || body.from > body.to || body.to > day()) {
      return json({error:"Choose a saved portfolio and a valid date range through today."},400);
    }
    const run = await execute(env, watch, body.from, body.to);
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
aside{border-right:1px solid var(--border);background:var(--card);padding:18px 12px;display:flex;flex-direction:column;gap:6px;position:sticky;top:0;height:100vh}
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
<dialog id="dialog"><h2>Screen citation</h2><p id="citation" class="sub"></p><form id="review"><label>Status<select name="status"><option>Pending</option><option>In review</option><option>Full text needed</option><option>Complete</option></select></label><label>Decision notes<textarea name="note" rows="4"></textarea></label><div style="display:flex;gap:8px"><button class="btn">Save decision</button><button type="button" class="btn outline" id="close">Cancel</button></div></form></dialog>
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
  Team:'<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M17 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6"/>',
  moon:'<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>', sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  alert:'<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'
};
const ic = name => '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+paths[name]+'</svg>';
const subtitles = {Overview:"Screening progress across portfolios.","My Queue":"Citations assigned to you.","All Assignments":"Every citation across the team.","Search & Pull":"Type a molecule and a date range to pull every matching PubMed article.",Batches:"Imports and evidence processing.",Watchlists:"Molecules and PubMed queries that feed the screening queue.",Team:"Reviewers and capacity."};
let data, tab, active, filt={q:"",status:"",portfolio:""}, shown=[];
let toastTimer;
const message = (value, error=false) => { const t=$("toast"); t.textContent=value; t.className="show"+(error?" err":""); clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.className="",error?6000:2800); };
async function api(route, body) {
  const res = await fetch("/api/"+route, body === undefined ? {} : {
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
const badge=(text,color="")=>'<span class="badge '+color+'">'+esc(text)+'</span>';
const flagged=item=>["Retracted","Expression of concern"].includes(item?.retractionStatus);
function evidenceChips(item){
  const chips=[];
  if(flagged(item))chips.push(badge(item.retractionStatus,"red"));
  else if(item.retractionStatus==="Correction")chips.push(badge("Correction","amber"));
  chips.push(item.fullTextKey?'<a class="badge green" href="/api/full-text/'+esc(item.id)+'">Full text</a>':item.fullTextLink?'<a class="badge blue" target="_blank" rel="noopener" href="'+esc(item.fullTextLink)+'">Open-access link</a>':badge(item.fullTextStatus||"Full text pending"));
  chips.push(item.screenshotKey?'<a class="badge green" href="/api/screenshot/'+esc(item.id)+'">Screenshot</a>':badge(item.screenshotStatus||"Screenshot pending"));
  return '<div class="chips">'+chips.join("")+"</div>";
}
function queueRows(items){
  return table(["Article","Portfolio","Reviewer","Status",""],items.slice(0,200).map(a=>{
    const item=data.articles[a.pmid]||{};
    return ['<a class="title" target="_blank" rel="noopener" href="'+esc(item.url)+'">'+esc(item.title)+'</a><div class="sub">PMID '+esc(a.pmid)+' · '+esc(item.journal)+' · '+esc(item.date)+'</div>'+evidenceChips({...item,id:a.pmid}),
      esc(a.portfolio)+((a.molecules||[]).length?'<div class="chips">'+a.molecules.map(m=>badge(m)).join("")+"</div>":""),
      a.reviewer?esc(a.reviewer):badge("Unassigned","amber"),badge(a.status,statusColor[a.status]),
      '<button class="btn outline sm" data-review="'+esc(a.id)+'">Review</button>'];
  }),"No articles match.")+(items.length>200?'<p class="sub" style="padding:10px 14px">Showing 200 of '+items.length+". Refine the filters to narrow the list.</p>":"");
}
function queueView(items){
  shown=items;
  const portfolios=[...new Set(items.map(a=>a.portfolio))].sort();
  return '<section><div class="filters"><input data-filter="q" placeholder="Search title, PMID, molecule…" value="'+esc(filt.q)+'" aria-label="Search">'+
    '<select data-filter="status" aria-label="Status"><option value="">All statuses</option>'+["Pending","In review","Full text needed","Complete"].map(s=>'<option'+(filt.status===s?" selected":"")+'>'+s+"</option>").join("")+"</select>"+
    '<select data-filter="portfolio" aria-label="Portfolio"><option value="">All portfolios</option>'+portfolios.map(p=>'<option'+(filt.portfolio===p?" selected":"")+'>'+esc(p)+"</option>").join("")+"</select></div>"+
    '<div id="qtable">'+queueRows(applyFilter(items))+"</div></section>";
}
function applyFilter(items){
  const q=filt.q.trim().toLowerCase();
  return items.filter(a=>(!filt.status||a.status===filt.status)&&(!filt.portfolio||a.portfolio===filt.portfolio)&&
    (!q||(a.pmid+" "+(data.articles[a.pmid]?.title||"")+" "+(a.molecules||[]).join(" ")).toLowerCase().includes(q)));
}
function stat(label,value,icon,warn){return '<div class="card'+(warn&&value?" warn":"")+'"><div class="lbl">'+label+ic(icon)+'</div><b data-count="'+value+'">0</b></div>';}
function render() {
  const manager=data.viewer.role==="manager";
  const tabs=manager?["Overview","Search & Pull","My Queue","All Assignments","Batches","Watchlists","Team"]:["My Queue"];
  if(!tabs.includes(tab))tab=tabs[0];
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
    html='<div class="cards">'+stat("Unique citations",arts.length,"Batches")+stat("Assigned",items.filter(a=>a.reviewer).length,"Team")+stat("Unassigned",items.filter(a=>!a.reviewer).length,"alert",true)+stat("Complete",done,"My Queue")+stat("Retraction alerts",alerts,"alert",true)+'</div>'+
      '<div class="grid2">'+panel("Screening progress",'<div class="row"><span>'+done+" of "+items.length+' complete</span><b>'+pct+'%</b></div><div class="bar"><i data-width="'+pct+'"></i></div>'+
        portfolios.map(p=>{const list=items.filter(a=>a.portfolio===p),d=list.filter(a=>a.status==="Complete").length;return '<div class="row"><span>'+esc(p)+'</span><span class="sub">'+d+" / "+list.length+"</span></div>";}).join(""))+
      panel("Needs attention",
        '<div class="row"><span>Unassigned citations</span>'+badge(items.filter(a=>!a.reviewer).length,items.some(a=>!a.reviewer)?"amber":"")+'</div>'+
        '<div class="row"><span>Retracted or expression of concern</span>'+badge(alerts,alerts?"red":"")+'</div>'+
        '<div class="row"><span>Full-text fetch needs retry</span>'+badge(retry,retry?"amber":"")+'</div>'+
        '<div class="row"><span>Flagged “Full text needed” by reviewers</span>'+badge(items.filter(a=>a.status==="Full text needed").length,"blue")+'</div>')+'</div>'+
      panel("Recent batches",table(["Watchlist","Range","Citations","Status"],data.runs.slice(0,6).map(r=>[esc(r.portfolio+(r.molecule?" · "+r.molecule:"")),esc(r.from)+" → "+esc(r.to),r.count,badge(r.error||r.status,r.status==="Imported"?"green":"red")]),"No batches yet."),"",true);
  }
  if(tab==="Search & Pull"){
    const today=new Date().toISOString().slice(0,10), start=new Date(Date.now()-30*864e5).toISOString().slice(0,10);
    html=panel("Pull articles for a molecule",'<form class="grid" data-route="pull"><label>Molecule<input name="molecule" required placeholder="e.g. aciclovir"></label><label>Synonyms, brands (optional)<input name="synonyms" placeholder="acyclovir, Zovirax"></label><label>From<input name="from" type="date" required value="'+start+'" max="'+today+'"></label><label>Through<input name="to" type="date" required value="'+today+'" max="'+today+'"></label><label>Portfolio (optional)<input name="portfolio" placeholder="Defaults to the molecule name"></label><label class="check"><input type="checkbox" name="safety">&nbsp;Safety-related articles only</label><div><button class="btn">Pull articles</button></div></form>',"Searches PubMed by the date each article was added, saves the molecule as a watchlist so new articles keep arriving daily, and assigns the results to reviewers.")+
      panel("Recent pulls",table(["Watchlist","Date range","Citations","Status"],data.runs.slice(0,8).map(r=>[esc(r.portfolio+(r.molecule?" · "+r.molecule:"")),esc(r.from)+" → "+esc(r.to),r.count,badge(r.error||r.status,r.status==="Imported"?"green":"red")]),"No pulls yet."),"",true);
  }
  if(tab==="My Queue") html=queueView(mine);
  if(tab==="All Assignments") html=queueView(items);
  if(tab==="Watchlists") html=panel("Add a watchlist",'<form class="grid" data-route="watch"><label>Portfolio<input name="portfolio" required></label><label>Molecule<input name="molecule" placeholder="Optional"></label><label class="wide">PubMed query<input name="query" required placeholder="e.g. aciclovir OR acyclovir"></label><div><button class="btn">Save watchlist</button></div></form>')+
    panel("Add molecules in bulk",'<form class="grid" data-route="watches"><label>Portfolio<input name="portfolio" required></label><label class="wide">Molecules<textarea name="list" rows="6" required placeholder="aciclovir, acyclovir, Zovirax&#10;metformin, Glucophage"></textarea></label><label class="check"><input type="checkbox" name="safety">&nbsp;Safety-related articles only</label><div><button class="btn">Save molecules</button></div></form>',"One molecule per line: the molecule first, then synonyms, brands or salts, separated by commas or tabs.")+
    panel("Saved watchlists ("+data.watches.length+")",table(["Portfolio","Molecule","Query"],data.watches.map(w=>[esc(w.portfolio),esc(w.molecule||"—"),'<span class="sub">'+esc(w.query)+"</span>"]),"Add a molecule or portfolio watchlist to start."),"",true);
  if(tab==="Team") html=panel("Add or update a reviewer",'<form class="grid" data-route="profile"><label>Name<input name="name" required></label><label>Sign-in email<input type="email" name="email" required></label><label>Portfolio<input name="portfolio" placeholder="All portfolios"></label><label>Open assignment limit<input type="number" name="capacity" min="1" max="500" value="25" required></label><label>Availability<select name="active"><option value="true">Active</option><option value="false">Unavailable</option></select></label><div><button class="btn">Save reviewer</button></div></form>')+
    panel("Reviewers",table(["Name","Email","Role","Portfolio","Open"],data.profiles.map(p=>[esc(p.name),esc(p.email),badge(p.role,p.role==="manager"?"blue":""),esc(p.portfolio||"All"),items.filter(a=>a.reviewer===p.email&&a.status!=="Complete").length]),"No profiles."),"",true);
  if(tab==="Batches") html=panel("Backfill a date range",watchOptions?
    '<form class="grid" data-route="import"><label>Watchlist<select name="watch">'+watchOptions+'</select></label><label>From<input name="from" type="date" required></label><label>Through<input name="to" type="date" required></label><div><button class="btn">Import citations</button></div></form>':
    '<div class="empty">Save a watchlist before importing a batch.</div>')+
    panel("Batch archive",'<form data-route="evidence" style="margin:0 0 8px"><button class="btn outline">Process pending evidence</button></form>'+table(["Watchlist","Date range","Citations","Status","Manifest"],data.runs.map(r=>[esc(r.portfolio+(r.molecule?" · "+r.molecule:"")),esc(r.from)+" → "+esc(r.to),r.count,badge(r.error||r.status,r.status==="Imported"?"green":"red"),r.status==="Imported"?'<button class="btn outline sm" data-export="'+esc(r.id)+'">CSV</button>':""]),"No batches yet."));
  $("content").innerHTML=html;
  animate();
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
async function refresh(){data=await api("state");render();}
function download(id) {
  const run=data.runs.find(r=>r.id===id);
  const cell=value=>'"'+String(value??"").replace(/^[=+@\\-]/,"'$&").replaceAll('"','""')+'"';
  const rows=[["PMID","Title","Journal","Date","DOI","PubMed URL","Portfolio","Molecules","Reviewer","Status","Full text","Screenshot","Retraction check"]];
  run.ids.forEach(pmid=>{
    const a=data.articles[pmid], item=data.assignments.find(x=>x.pmid===pmid&&x.portfolio===run.portfolio);
    rows.push([pmid,a.title,a.journal,a.date,a.doi,a.url,run.portfolio,(item?.molecules||[]).join("; "),item?.reviewer,item?.status,a.fullTextStatus||"Pending",a.screenshotStatus||"Pending",a.retractionStatus||"Pending"]);
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
  const target=event.target.closest("[data-tab],[data-export],[data-review]");
  if(!target)return;
  if(target.dataset.tab){tab=target.dataset.tab;render();}
  if(target.dataset.export)download(target.dataset.export);
  if(target.dataset.review){
    active=data.assignments.find(a=>a.id===target.dataset.review);
    $("citation").textContent=data.articles[active.pmid].title;
    $("review").elements.status.value=active.status;
    $("review").elements.note.value=active.note||"";
    $("dialog").showModal();
  }
});
$("close").onclick=()=>$("dialog").close();
document.addEventListener("submit",async event=>{
  event.preventDefault();
  const form=event.target, button=form.querySelector("button");
  const body=Object.fromEntries(new FormData(form));
  if(body.active)body.active=body.active==="true";
  const route=form.dataset.route || "review";
  if(route==="review")body.id=active.id;
  if(route==="watches"){
    body.safetyOnly=body.safety==="on";
    body.rows=body.list.split(/\\r?\\n/).map(line=>line.split(/[,;\\t]/).map(x=>x.trim()).filter(Boolean)).filter(n=>n.length).map(n=>({molecule:n[0],synonyms:n.slice(1)}));
  }
  button.disabled=true;message(route==="import"||route==="pull"?"Retrieving PubMed citations…":"Saving…");
  try {const result=await api(route,body);if(route==="review")$("dialog").close();await refresh();
    message(route==="import"?"Batch imported.":route==="pull"?result.count+" articles pulled for "+(result.molecule||result.portfolio)+".":route==="watches"?result.created+" molecule watchlists saved."+(result.skipped.length?" Skipped (invalid or too long): "+result.skipped.join(", "):""):"Saved.");}
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
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/mcp" && request.method === "POST") return mcp(request,env);
    if (!path.startsWith("/api/")) return new Response(html, { headers: { "Content-Type":"text/html; charset=utf-8" } });
    try { return await api(request, env, path); }
    catch (error) { return json({ error:error.message }, 500); }
  }
};
