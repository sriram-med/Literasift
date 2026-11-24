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
async function importWatch(env, watch, from, to) {
  const date = value => value.replaceAll("-", "/");
  const term = "(" + watch.query + ") AND (" + date(from) + "[crdt]:" + date(to) + "[crdt])";
  const { esearchresult: result } = await pubmed("esearch", { term, retmode: "json", retmax: "9999" });
  if (!result || Number(result.count) !== result.idlist.length) throw new Error("Search exceeds the batch limit or was incomplete. Use a shorter date range.");
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
    const run = { id:crypto.randomUUID(), portfolio:watch.portfolio, from, to, count:result.idlist.length,
      ids:result.idlist, time:new Date().toISOString(), query:watch.query, status:"Imported" };
    state.runs.unshift(run);
    for (const id of result.idlist) {
      if (state.assignments.some(a => a.pmid === id && a.portfolio === watch.portfolio)) continue;
      const item = { id:crypto.randomUUID(), pmid:id, portfolio:watch.portfolio, reviewer:"", status:"Pending" };
      allocate(state, item);
      state.assignments.push(item);
    }
    return run;
  });
}
async function execute(env, watch, from, to) {
  try { return await importWatch(env, watch, from, to); }
  catch (error) {
    await write(env, state => state.runs.unshift({ id:crypto.randomUUID(), portfolio:watch.portfolio, from, to,
      query:watch.query, status:"Failed", error:error.message, time:new Date().toISOString(), ids:[], count:0 }));
    throw error;
  }
}
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
    for (const watch of state.watches) {
      const previous = state.runs.find(r => r.portfolio === watch.portfolio && r.query === watch.query && r.status === "Imported");
      const to = new Date(Date.parse(day()) - 86400000).toISOString().slice(0,10);
      if (previous?.to >= to) continue;
      try { results.push(await execute(env, watch, previous?.to || to, to)); }
      catch (error) { results.push({ portfolio:watch.portfolio, error:error.message }); }
    }
    return json({ results, evidence:await collectEvidence(env) });
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
    const watch = { portfolio:String(body.portfolio || "").trim(), query:String(body.query || "").trim() };
    if (!watch.portfolio || !watch.query || watch.query.length > 1500) return json({error:"Enter a portfolio and a PubMed query."},400);
    await write(env, data => {
      data.watches = data.watches.filter(w => w.portfolio !== watch.portfolio);
      data.watches.push(watch);
    });
  } else if (path === "/api/import") {
    const watch = state.watches.find(w => w.portfolio === body.portfolio);
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
<title>Literature Bench</title><style>
*{box-sizing:border-box}body{margin:0;background:#f3f5f9;color:#182739;font:16px system-ui,sans-serif}header{background:#10283f;color:white;padding:22px max(5vw,18px);display:flex;justify-content:space-between;align-items:center;gap:15px}header strong{font-size:20px}header span{font-size:14px;color:#b9d4dd}main{max-width:1320px;margin:auto;padding:38px max(4vw,16px)}h1{font-size:clamp(32px,5vw,50px);margin:0;letter-spacing:-.045em}h2{font-size:22px;margin:0 0 18px}p{line-height:1.55;color:#485d71}nav{display:flex;gap:8px;flex-wrap:wrap;margin:26px 0}button,input,select,textarea{font:inherit}button{background:#126359;color:#fff;border:0;border-radius:8px;padding:10px 15px;cursor:pointer;font-weight:600}button:disabled{opacity:.55;cursor:wait}nav button{background:white;color:#234047;border:1px solid #d5dfe5}nav button[aria-current]{background:#126359;color:white}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:12px}.card,section{background:#fff;border:1px solid #dce4eb;border-radius:14px;padding:20px}.card b{font-size:34px;display:block}.card span{color:#485d71}section{margin:18px 0;overflow:auto}table{border-collapse:collapse;width:100%;text-align:left}td,th{padding:13px 9px;vertical-align:top;border-bottom:1px solid #e6edf1}th{font-size:14px;color:#485d71}a{color:#116158}label{display:flex;flex-direction:column;gap:6px;font-weight:600}input,select,textarea{padding:9px;border:1px solid #b6c7d3;border-radius:7px;background:white;color:#182739;max-width:100%}form{display:grid;gap:13px;align-items:end;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin-bottom:20px}form .wide{grid-column:1/-1}.msg{color:#8e331e}small{font-size:14px;color:#485d71}dialog{border:1px solid #b6c7d3;border-radius:14px;width:min(560px,94vw);padding:24px}dialog::backdrop{background:#10283f80}.alert{display:inline-block;background:#f8dcd5;color:#8e331e;font-weight:600;padding:3px 8px;border-radius:7px;margin-bottom:4px}.tag{display:inline-block;background:#e3f0ee;padding:4px 9px;border-radius:7px;white-space:nowrap}
</style><header><strong>Literature Bench</strong><span id="identity"></span></header>
<main><h1>Literature screening</h1><p>PubMed batches, reviewer assignments, and screening decisions.</p><nav id="nav" aria-label="Literature Bench"></nav><p id="message" role="status"></p><div id="content"></div></main>
<dialog id="dialog"><h2>Screen citation</h2><p id="citation"></p><form id="review"><label>Status<select name="status"><option>Pending</option><option>In review</option><option>Full text needed</option><option>Complete</option></select></label><label class="wide">Decision notes<textarea name="note" rows="4"></textarea></label><button>Save decision</button><button type="button" id="close">Cancel</button></form></dialog>
<script>
const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let data, tab, active;
const message = (value, error=false) => { $("message").textContent=value; $("message").className=error?"msg":""; };
async function api(route, body) {
  const res = await fetch("/api/"+route, body === undefined ? {} : {
    method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || "Request failed.");
  return result;
}
const table=(headers,rows,empty)=>rows.length?
  "<table><thead><tr>"+headers.map(h=>"<th>"+h+"</th>").join("")+"</tr></thead><tbody>"+
  rows.map(row=>"<tr>"+row.map(cell=>"<td>"+cell+"</td>").join("")+"</tr>").join("")+"</tbody></table>":
  "<p>"+empty+"</p>";
const panel=(title,body)=>"<section><h2>"+title+"</h2>"+body+"</section>";
function queue(items) {
  return table(["Article","Portfolio","Reviewer","Status",""],items.map(a=>{
    const item=data.articles[a.pmid];
    return [(["Retracted","Expression of concern"].includes(item.retractionStatus)?'<span class="alert">'+esc(item.retractionStatus)+'</span><br>':'')+'<a target="_blank" rel="noopener" href="'+esc(item.url)+'">'+esc(item.title)+'</a><br><small>PMID '+esc(a.pmid)+' · '+esc(item.journal)+'</small><br>'+(item.fullTextKey?'<a href="/api/full-text/'+esc(a.pmid)+'">Download full text</a>':(item.fullTextLink?'<a target="_blank" rel="noopener" href="'+esc(item.fullTextLink)+'">Open-access link</a>':'<small>'+esc(item.fullTextStatus || "Full text pending")+'</small>'))+' · '+(item.screenshotKey?'<a href="/api/screenshot/'+esc(a.pmid)+'">Screenshot</a>':'<small>'+esc(item.screenshotStatus || "Screenshot pending")+'</small>'),
      esc(a.portfolio),esc(a.reviewer || "Unassigned"),'<span class="tag">'+esc(a.status)+'</span>',
      '<button data-review="'+esc(a.id)+'">Review</button>'];
  }),"No articles in this queue.");
}
function render() {
  const manager=data.viewer.role==="manager";
  const tabs=manager?["Overview","My Queue","Batches","Watchlists","Team"]:["My Queue"];
  tab ||= tabs[0];
  $("identity").textContent=data.viewer.name+" · "+data.viewer.role;
  $("nav").innerHTML=tabs.map(x=>'<button data-tab="'+x+'" '+(x===tab?'aria-current="page"':'')+'>'+x+'</button>').join("");
  const items=data.assignments;
  const watchOptions=data.watches.map(w=>'<option>'+esc(w.portfolio)+'</option>').join("");
  if(tab==="Overview"){
    const metrics=[["Unique citations",Object.keys(data.articles).length],["Assigned",items.filter(a=>a.reviewer).length],["Unassigned",items.filter(a=>!a.reviewer).length],["Complete",items.filter(a=>a.status==="Complete").length]];
    $("content").innerHTML='<div class="cards">'+metrics.map(([label,num])=>'<div class="card"><b>'+num+'</b><span>'+label+'</span></div>').join("")+'</div>'+panel("All assignments",queue(items));
  }
  if(tab==="My Queue") $("content").innerHTML=panel("My assignments",queue(items.filter(a=>a.reviewer===data.viewer.email)));
  if(tab==="Watchlists") $("content").innerHTML=panel("PubMed watchlists",'<form data-route="watch"><label>Portfolio<input name="portfolio" required></label><label>PubMed query<input name="query" required placeholder="e.g. aciclovir OR acyclovir"></label><button>Save watchlist</button></form>'+table(["Portfolio","Query"],data.watches.map(w=>[esc(w.portfolio),esc(w.query)]),"Add a product or portfolio watchlist to start."));
  if(tab==="Team") $("content").innerHTML=panel("Reviewer profiles",'<form data-route="profile"><label>Name<input name="name" required></label><label>Sign-in email<input type="email" name="email" required></label><label>Portfolio<input name="portfolio" placeholder="All portfolios"></label><label>Open assignment limit<input type="number" name="capacity" min="1" max="500" value="25" required></label><label>Availability<select name="active"><option value="true">Active</option><option value="false">Unavailable</option></select></label><button>Save reviewer</button></form>'+table(["Name","Email","Role","Portfolio","Open"],data.profiles.map(p=>[esc(p.name),esc(p.email),esc(p.role),esc(p.portfolio||"All"),items.filter(a=>a.reviewer===p.email&&a.status!=="Complete").length]),"No profiles."));
  if(tab==="Batches") $("content").innerHTML=panel("Backfill a date range",watchOptions?
    '<form data-route="import"><label>Portfolio<select name="portfolio">'+watchOptions+'</select></label><label>From<input name="from" type="date" required></label><label>Through<input name="to" type="date" required></label><button>Import citations</button></form>':
    '<p>Save a watchlist before importing a batch.</p>')+panel("Batch archive",'<form data-route="evidence"><button>Process pending evidence</button></form>'+table(["Portfolio","Create Date range","Citations","Status","Manifest"],data.runs.map(r=>[esc(r.portfolio),esc(r.from)+" to "+esc(r.to),r.count,esc(r.error||r.status),r.status==="Imported"?'<button data-export="'+esc(r.id)+'">CSV</button>':""]),"No batches yet."));
}
async function refresh(){data=await api("state");render();}
function download(id) {
  const run=data.runs.find(r=>r.id===id);
  const cell=value=>'"'+String(value??"").replace(/^[=+@\-]/,"'$&").replaceAll('"','""')+'"';
  const rows=[["PMID","Title","Journal","Date","DOI","PubMed URL","Portfolio","Reviewer","Status","Full text","Screenshot","Retraction check"]];
  run.ids.forEach(pmid=>{
    const a=data.articles[pmid], item=data.assignments.find(x=>x.pmid===pmid&&x.portfolio===run.portfolio);
    rows.push([pmid,a.title,a.journal,a.date,a.doi,a.url,run.portfolio,item?.reviewer,item?.status,a.fullTextStatus||"Pending",a.screenshotStatus||"Pending",a.retractionStatus||"Pending"]);
  });
  const url=URL.createObjectURL(new Blob([rows.map(row=>row.map(cell).join(",")).join("\\r\\n")],{type:"text/csv"}));
  const link=document.createElement("a");link.href=url;link.download="pubmed-"+run.from+"-"+run.to+".csv";link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
document.addEventListener("click",event=>{
  const target=event.target.closest("button");if(!target)return;
  if(target.dataset.tab){tab=target.dataset.tab;message("");render();}
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
  button.disabled=true;message(route==="import"?"Retrieving PubMed citations…":"Saving…");
  try {await api(route,body);if(route==="review")$("dialog").close();await refresh();message(route==="import"?"Batch imported.":"Saved.");}
  catch(error){message(error.message,true);if(route==="review")$("dialog").close();if(route==="import")await refresh().catch(()=>{});}
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
