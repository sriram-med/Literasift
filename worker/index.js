const KEY = "bench.json";
const blank = () => ({ profiles: [], watches: [], articles: {}, assignments: [], runs: [] });
const shiftDay = (value, offset) => new Date(Date.parse(value) + offset * 86400000).toISOString().slice(0,10);
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
async function pubmed(env, operation, params) {
  const url = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/" + operation + ".fcgi");
  url.search = new URLSearchParams({ db: "pubmed", tool: "literature_bench", ...params });
  if (env.NCBI_EMAIL) url.searchParams.set("email",env.NCBI_EMAIL);
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
function safetyPriority(title, abstract = "") {
  const text = title + " " + abstract;
  const rules = [
    ["case report or case series", /\bcase (report|series)\b|\bwe report\b|\bwe describe\b/i],
    ["suspected adverse reaction", /\badverse (drug )?(reaction|event|effect)s?\b|\bdrug.induced\b|\btoxicity\b|\btoxicities\b|\bassociated with\b/i],
    ["serious outcome signal", /\b(anaphylaxis|death|fatal|life.threatening|hospitali[sz]ation|overdose|acute liver failure|status epilepticus)\b/i],
    ["special situation", /\b(pregnancy exposure|medication error|off.label use|lack of efficacy|drug abuse|misuse)\b/i]
  ];
  const reasons = rules.filter(([,pattern])=>pattern.test(text)).map(([label])=>label);
  return { level:reasons.length?"Priority review":"Routine review", reasons, source:abstract?"Title and abstract":"Title only", assessedAt:new Date().toISOString() };
}
async function importWatch(env, watch, from, to, mode = "manual") {
  const date = value => value.replaceAll("-", "/");
  const term = "(" + watch.query + ") AND (" + date(from) + ":" + date(to) + "[crdt])";
  const { esearchresult: result } = await pubmed(env,"esearch", { term, retmode: "json", retmax: "9999" });
  if (!result || Number(result.count) !== result.idlist.length) throw new Error("Search exceeds the batch limit or was incomplete. Use a shorter date range.");
  const {state: existing} = await load(env);
  const articles = {};
  const fetchIds = result.idlist.filter(id => !existing.articles[id]?.title);
  for (let offset = 0; offset < fetchIds.length; offset += 100) {
    const ids = fetchIds.slice(offset, offset + 100);
    await new Promise(resolve => setTimeout(resolve, 350));
    const { result: summary } = await pubmed(env,"esummary", { id: ids.join(","), retmode: "json" });
    for (const id of ids) {
      const citation = summary?.[id];
      if (!citation?.title) throw new Error("Missing citation for PMID " + id);
      articles[id] = { id, title:citation.title, journal:citation.fulljournalname, date:citation.pubdate,
        doi:citation.articleids?.find(a => a.idtype === "doi")?.value || "",
        pmcid:citation.articleids?.find(a => a.idtype === "pmc")?.value || "",
        url:"https://pubmed.ncbi.nlm.nih.gov/" + id + "/", priority:safetyPriority(citation.title) };
    }
  }
  return write(env, state => {
    for (const [id, article] of Object.entries(articles)) state.articles[id] = { ...state.articles[id], ...article };
    const run = { id:crypto.randomUUID(), portfolio:watch.portfolio, from, to, count:result.idlist.length,
      ids:result.idlist, time:new Date().toISOString(), query:watch.query, status:"Imported", mode, newAssignments:0 };
    state.runs.unshift(run);
    for (const id of result.idlist) {
      if (state.assignments.some(a => a.pmid === id && a.portfolio === watch.portfolio)) continue;
      const item = { id:crypto.randomUUID(), pmid:id, portfolio:watch.portfolio, reviewer:"", status:"Pending" };
      allocate(state, item);
      item.discoveredAt = run.time;
      state.assignments.push(item);
      run.newAssignments++;
    }
    return run;
  });
}
async function execute(env, watch, from, to, mode = "manual") {
  try { return await importWatch(env, watch, from, to, mode); }
  catch (error) {
    await write(env, state => state.runs.unshift({ id:crypto.randomUUID(), portfolio:watch.portfolio, from, to,
      query:watch.query, mode, status:"Failed", error:error.message, time:new Date().toISOString(), ids:[], count:0 }));
    throw error;
  }
}
const pmcOrigin = "https://pmc-oa-opendata.s3.amazonaws.com";
async function captureFullText(env, article) {
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
  return {fullTextStatus:"Captured", fullTextKey:key, fullTextLicense:item.license_code, fullTextSource:url};
}
async function captureScreenshot(env, article) {
  const endpoint = new URL(env.SCREENSHOT_ENDPOINT);
  if (endpoint.protocol !== "https:") throw new Error("Screenshot endpoint must use HTTPS.");
  const headers = {"Content-Type":"application/json"};
  if (env.SCREENSHOT_AUTH === "bearer") headers.Authorization = "Bearer " + env.SCREENSHOT_TOKEN;
  else endpoint.searchParams.set("token",env.SCREENSHOT_TOKEN);
  const response = await fetch(endpoint, {method:"POST",redirect:"error",signal:AbortSignal.timeout(30000),
    headers,body:JSON.stringify({url:article.url,options:{fullPage:true,type:"png"}})});
  if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("image/png")) {
    throw new Error("Screenshot service returned HTTP " + response.status);
  }
  const key = "evidence/" + article.id + "/pubmed.png";
  await env.BUCKET.put(key,response.body,{httpMetadata:{contentType:"image/png"}});
  return { screenshotKey:key, screenshotStatus:"Captured", screenshotAt:new Date().toISOString() };
}
async function captureCitationXml(env, article) {
  const url = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi");
  url.search = new URLSearchParams({ db:"pubmed", id:article.id, retmode:"xml", tool:"literature_bench" });
  if (env.NCBI_EMAIL) url.searchParams.set("email",env.NCBI_EMAIL);
  const response = await fetch(url,{signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error("PubMed EFetch returned HTTP " + response.status);
  const xml = await response.text();
  if (!/<PubmedArticleSet[\s>]/.test(xml) || !new RegExp("<PMID(?: [^>]*)?>" + article.id + "</PMID>").test(xml)) {
    throw new Error("PubMed EFetch did not return the requested citation");
  }
  const key = "evidence/" + article.id + "/pubmed.xml";
  await env.BUCKET.put(key,xml,{httpMetadata:{contentType:"application/xml"}});
  const abstract = [...xml.matchAll(/<AbstractText(?:\s[^>]*)?>([\s\S]*?)<\/AbstractText>/g)].map(m=>m[1].replace(/<[^>]+>/g," ")).join(" ");
  return {citationXmlKey:key,citationXmlStatus:"Captured",priority:safetyPriority(article.title,abstract)};
}
async function collectEvidence(env, ids) {
  const {state} = await load(env);
  const articles = ids ? ids.map(id=>state.articles[id]).filter(Boolean) : Object.values(state.articles);
  const enabled = Boolean(env.SCREENSHOT_ENDPOINT && env.SCREENSHOT_TOKEN);
  const needsFullText = a => !a.fullTextStatus || a.fullTextStatus === "Retry needed";
  const needsScreen = a => enabled && !a.screenshotKey;
  const pending = articles.filter(a=>!a.citationXmlKey || !a.priority || needsFullText(a) || needsScreen(a))
    .sort((a,b)=>String(a.evidenceAttempt || "").localeCompare(String(b.evidenceAttempt || ""))).slice(0,4);
  for (const article of pending) {
    await new Promise(resolve => setTimeout(resolve,350));
    const status = {evidenceAttempt:new Date().toISOString()};
    if (!article.citationXmlKey) {
      try { Object.assign(status,await captureCitationXml(env,article)); }
      catch { status.citationXmlStatus = "Retry needed"; }
    }
    if (article.citationXmlKey && !article.priority) {
      try {
        const saved = await env.BUCKET.get(article.citationXmlKey);
        const xml = saved ? await saved.text() : "";
        const abstract = [...xml.matchAll(/<AbstractText(?:\s[^>]*)?>([\s\S]*?)<\/AbstractText>/g)].map(m=>m[1].replace(/<[^>]+>/g," ")).join(" ");
        status.priority = safetyPriority(article.title,abstract);
      } catch {}
    }
    if (needsFullText(article)) {
      try { Object.assign(status,await captureFullText(env,article)); }
      catch (error) { Object.assign(status,{fullTextStatus:"Retry needed",fullTextError:error.message}); }
    }
    if (needsScreen(article)) {
      try { Object.assign(status,await captureScreenshot(env,article)); }
      catch { status.screenshotStatus="Retry needed"; }
    }
    await write(env, data => Object.assign(data.articles[article.id],status));
  }
  return {processed:pending.length, unattempted:articles.filter(a=>!a.evidenceAttempt).length,
    screenshotConfigured:enabled};
}

const pushWorker = `self.addEventListener("push",event=>{
  event.waitUntil((async()=>{
    let payload={};try{payload=event.data?.json()||{}}catch{}
    await self.registration.showNotification("LiteraSift",{
      body:payload.priority?"A safety citation requires priority review.":"New literature is ready for review.",
      tag:payload.id||"literasift",data:{url:"/"}
    });
  })());
});
self.addEventListener("notificationclick",event=>{
  event.notification.close();event.waitUntil(clients.openWindow("/"));
});`;
function weeklyWindow(watch,today) {
  const weekday = Number.isInteger(watch.triggerDay) && watch.triggerDay>=0 && watch.triggerDay<=6 ? watch.triggerDay : 2;
  const delta = (new Date(today+"T00:00:00Z").getUTCDay()-weekday+7)%7;
  const trigger = shiftDay(today,-delta);
  return {trigger,from:shiftDay(trigger,-7),to:shiftDay(trigger,-1)};
}
async function reconcileExtended(env,watch,today,history) {
  // Weekly 30 complete days, one slice per scheduler invocation per portfolio.
  const anchor = weeklyWindow(watch,today).trigger;
  const from = shiftDay(anchor,-30), to = shiftDay(anchor,-1);
  for(let cursor=from;cursor<=to;cursor=shiftDay(cursor,7)){
    const end = shiftDay(cursor,6)<to?shiftDay(cursor,6):to;
    if(!history.some(r=>r.mode==="audit30" && r.from===cursor && r.to===end && r.time>=anchor+"T00:00:00")) {
      return execute(env,watch,cursor,end,"audit30");
    }
  }
  return null;
}
async function deliverAlerts(env) {
  if (!env.ALERT_GATEWAY_URL || !env.ALERT_GATEWAY_TOKEN) return {configured:false,accepted:0,failed:0};
  const endpoint = new URL(env.ALERT_GATEWAY_URL);
  if(endpoint.protocol!=="https:" || endpoint.username || endpoint.password) throw new Error("Alert gateway must use HTTPS.");
  const {state}=await load(env);
  const pending=[];
  for(const p of state.profiles.filter(p=>p.active)){
    const prefs=state.alertPreferences?.[p.email];
    if(!prefs)continue;
    for(const a of state.assignments){
      if(!a.discoveredAt || a.discoveredAt < prefs.enabledAt || (p.role!=="manager" && a.reviewer!==p.email))continue;
      const priority=state.articles[a.pmid]?.priority?.level==="Priority review";
      const events=priority?["new","priority"]:["new"];
      for(const event of events){
        for(const channel of ["email","mobile","push"]){
          if(!prefs[channel] || (channel==="push"&&!prefs.subscription) || (channel==="mobile"&&!prefs.mobileDestination))continue;
          const id=[a.id,p.email,event,channel].join("|");
          const previous=state.alertDelivery?.[id];
          if(previous?.accepted || (previous?.nextAttempt && previous.nextAttempt>Date.now()))continue;
          pending.push({id,event,channel,priority:event==="priority",email:p.email,subscription:channel==="push"?prefs.subscription:undefined,mobileDestination:channel==="mobile"?prefs.mobileDestination:undefined});
        }
      }
    }
  }
  let accepted=0,failed=0;
  for(const job of pending.slice(0,8)){
    let ok=false;
    try {
      // No case narratives, titles, client names or patient details leave the application.
      const response=await fetch(endpoint,{method:"POST",redirect:"error",headers:{"Authorization":"Bearer "+env.ALERT_GATEWAY_TOKEN,"Content-Type":"application/json","Idempotency-Key":job.id},body:JSON.stringify({...job,title:"LiteraSift",body:job.priority?"A safety citation requires priority review.":"New literature is ready for review.",url:"https://literasift.tech/"}),signal:AbortSignal.timeout(5000)});
      ok=response.ok;
    } catch {}
    await write(env,data=>{
      data.alertDelivery ||= {};
      const prior=data.alertDelivery[job.id]||{};
      const attempts=(prior.attempts||0)+1;
      data.alertDelivery[job.id]={accepted:ok,attempts,at:new Date().toISOString(),nextAttempt:ok?null:Date.now()+Math.min(3600000,60000*2**Math.min(attempts,6))};
    });
    if(ok)accepted++;else failed++;
  }
  return {configured:true,accepted,failed,pending:Math.max(0,pending.length-accepted)};
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
      alertConfig:{gateway:Boolean(env.ALERT_GATEWAY_URL && env.ALERT_GATEWAY_TOKEN),vapidPublicKey:env.VAPID_PUBLIC_KEY||"",preferences:state.alertPreferences?.[email]?{...state.alertPreferences[email],subscription:undefined}:null},
      priorityAlerts:assignments.filter(a=>state.articles[a.pmid]?.priority?.level==="Priority review").map(a=>a.id),
      notifications: assignments.filter(a=>a.discoveredAt).map(a=>({id:a.id,pmid:a.pmid,portfolio:a.portfolio,at:a.discoveredAt,read:Boolean(a.notificationReadBy?.includes(email))})).sort((a,b)=>b.at.localeCompare(a.at)),
      articles:manager ? state.articles : Object.fromEntries(assignments.map(a => [a.pmid, state.articles[a.pmid]])) });
  }
  if (request.method === "GET" && (path.startsWith("/api/full-text/") || path.startsWith("/api/screenshot/") || path.startsWith("/api/citation-xml/"))) {
    const id = path.split("/").pop();
    const article = state.articles[id];
    const key = { "/api/screenshot":article?.screenshotKey, "/api/citation-xml":article?.citationXmlKey,
      "/api/full-text":article?.fullTextKey }[path.slice(0,path.lastIndexOf("/"))];
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
  if (path === "/api/alert-preferences" && viewer) {
    const subscription=body.subscription;
    if(subscription && (typeof subscription.endpoint!=="string" || !subscription.endpoint.startsWith("https://") || subscription.endpoint.length>2048 || !subscription.keys?.p256dh || !subscription.keys?.auth)) return json({error:"Invalid push subscription."},400);
    const mobileDestination=String(body.mobileDestination||"").trim();
    if(body.mobile===true && !/^\+[1-9]\d{7,14}$/.test(mobileDestination))return json({error:"Enter an international mobile number."},400);
    await write(env,data=>{
      data.alertPreferences ||= {};
      const old=data.alertPreferences[email]||{};
      data.alertPreferences[email]={email:body.email===true,mobile:body.mobile===true,push:body.push===true,mobileDestination:body.mobile===true?mobileDestination:"",subscription:body.push===true?(subscription||old.subscription||null):null,enabledAt:old.enabledAt||new Date().toISOString()};
    });
    return json({ok:true});
  }
  if (path === "/api/notification-read" && viewer) {
    await write(env,data=>{ for (const a of data.assignments) if ((manager || a.reviewer===email) && (body.id===a.id || body.all===true) && a.discoveredAt) { a.notificationReadBy ||= []; if (!a.notificationReadBy.includes(email)) a.notificationReadBy.push(email); } });
    return json({ok:true});
  }
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
    const today = day();
    const now = Date.now();
    for (const watch of state.watches) {
      if (watch.active === false) continue;
      const history = state.runs.filter(r => r.portfolio === watch.portfolio && r.query === watch.query && r.status === "Imported");
      const last = history.filter(r => r.mode === "continuous").reduce((n,r)=>Math.max(n,Date.parse(r.time)||0),0);
      if (now - last < 15 * 60000) continue;
      const audit = history.filter(r => r.mode === "reconciliation").reduce((n,r)=>Math.max(n,Date.parse(r.time)||0),0);
      const previous = history.reduce((latest,r)=>r.to > latest ? r.to : latest,"");
      const reconcile = now - audit >= 86400000;
      const from = shiftDay(today,reconcile ? -7 : -2);
      const cursor = previous && previous < from ? previous : from;
      try {
        // Bound catch-up windows to avoid oversized searches and advance only on success.
        const through = shiftDay(cursor, 7) < today ? shiftDay(cursor,7) : today;
        results.push(await execute(env, watch, cursor, through, "continuous"));
        if (reconcile && through === today) results.push(await execute(env, watch, shiftDay(today,-7), today, "reconciliation"));
      } catch (error) { results.push({ portfolio:watch.portfolio, error:error.message }); }
    }
    // Formal report is an actual reconciliation of the previous seven complete days.
    // Process at most one extra historical job per invocation to limit load.
    const refreshed=(await load(env)).state;
    for(const watch of refreshed.watches){
      if(watch.active===false)continue;
      const history=refreshed.runs.filter(r=>r.portfolio===watch.portfolio&&r.query===watch.query&&r.status==="Imported");
      const week=weeklyWindow(watch,today);
      try{
        if(!history.some(r=>r.mode==="weekly-report"&&r.from===week.from&&r.to===week.to)){
          results.push(await execute(env,watch,week.from,week.to,"weekly-report"));break;
        }
        const audit=await reconcileExtended(env,watch,today,history);
        if(audit){results.push(audit);break;}
      }catch(error){results.push({portfolio:watch.portfolio,error:error.message});break;}
    }
    const alerts=await deliverAlerts(env);
    return json({ results, alerts, evidence:await collectEvidence(env) });
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
    const watch = { portfolio:String(body.portfolio || "").trim(), query:String(body.query || "").trim(), client:String(body.client || "").trim(), active:body.active !== false, triggerDay:body.triggerDay===undefined?2:Number(body.triggerDay) };
    if (!watch.portfolio || !watch.query || watch.query.length > 1500 || !Number.isInteger(watch.triggerDay) || watch.triggerDay<0 || watch.triggerDay>6) return json({error:"Enter a portfolio and a PubMed query."},400);
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
*{box-sizing:border-box}body{margin:0;background:#f3f5f9;color:#182739;font:16px system-ui,sans-serif}header{background:#10283f;color:white;padding:22px max(5vw,18px);display:flex;justify-content:space-between;align-items:center;gap:15px}header strong{font-size:20px}header span{font-size:14px;color:#b9d4dd}main{max-width:1320px;margin:auto;padding:38px max(4vw,16px)}h1{font-size:clamp(32px,5vw,50px);margin:0;letter-spacing:-.045em}h2{font-size:22px;margin:0 0 18px}p{line-height:1.55;color:#485d71}nav{display:flex;gap:8px;flex-wrap:wrap;margin:26px 0}button,input,select,textarea{font:inherit}button{background:#126359;color:#fff;border:0;border-radius:8px;padding:10px 15px;cursor:pointer;font-weight:600}button:disabled{opacity:.55;cursor:wait}nav button{background:white;color:#234047;border:1px solid #d5dfe5}nav button[aria-current]{background:#126359;color:white}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:12px}.card,section{background:#fff;border:1px solid #dce4eb;border-radius:14px;padding:20px}.card b{font-size:34px;display:block}.card span{color:#485d71}section{margin:18px 0;overflow:auto}table{border-collapse:collapse;width:100%;text-align:left}td,th{padding:13px 9px;vertical-align:top;border-bottom:1px solid #e6edf1}th{font-size:14px;color:#485d71}a{color:#116158}label{display:flex;flex-direction:column;gap:6px;font-weight:600}input,select,textarea{padding:9px;border:1px solid #b6c7d3;border-radius:7px;background:white;color:#182739;max-width:100%}form{display:grid;gap:13px;align-items:end;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin-bottom:20px}form .wide{grid-column:1/-1}.msg{color:#8e331e}small{font-size:14px;color:#485d71}dialog{border:1px solid #b6c7d3;border-radius:14px;width:min(560px,94vw);padding:24px}dialog::backdrop{background:#10283f80}.tag{display:inline-block;background:#e3f0ee;padding:4px 9px;border-radius:7px;white-space:nowrap}
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
    return ['<a target="_blank" rel="noopener" href="'+esc(item.url)+'">'+esc(item.title)+'</a><br><small>PMID '+esc(a.pmid)+' · '+esc(item.journal)+'</small><br>'+(item.fullTextKey?'<a href="/api/full-text/'+esc(a.pmid)+'">Download PMC full text</a>':'<small>'+esc(item.fullTextStatus || "Full text pending")+'</small>')+' · '+(item.screenshotKey?'<a href="/api/screenshot/'+esc(a.pmid)+'">Screenshot</a>':'<small>'+esc(item.screenshotStatus || "Screenshot pending")+'</small>')+(item.citationXmlKey?' · <a href="/api/citation-xml/'+esc(a.pmid)+'">Citation XML</a>':''),
      esc(a.portfolio)+(item.priority?.level==="Priority review"?"<br><small>Priority review (not a confirmed ICSR)</small>":""),esc(a.reviewer || "Unassigned"),'<span class="tag">'+esc(a.status)+'</span>',
      '<button data-review="'+esc(a.id)+'">Review</button>'];
  }),"No articles in this queue.");
}
function render() {
  const manager=data.viewer.role==="manager";
  const tabs=manager?["Overview","My Queue","Notifications","Reports","Batches","Clients","Watchlists","Team"]:["My Queue","Notifications"];
  tab ||= tabs[0];
  $("identity").textContent=data.viewer.name+" · "+data.viewer.role+" · "+(data.notifications||[]).filter(n=>!n.read).length+" unread";
  $("nav").innerHTML=tabs.map(x=>'<button data-tab="'+x+'" '+(x===tab?'aria-current="page"':'')+'>'+x+'</button>').join("");
  const items=data.assignments;
  const watchOptions=data.watches.map(w=>'<option>'+esc(w.portfolio)+'</option>').join("");
  if(tab==="Overview"){
    const metrics=[["Unique citations",Object.keys(data.articles).length],["Assigned",items.filter(a=>a.reviewer).length],["Unassigned",items.filter(a=>!a.reviewer).length],["Complete",items.filter(a=>a.status==="Complete").length]];
    $("content").innerHTML='<div class="cards">'+metrics.map(([label,num])=>'<div class="card"><b>'+num+'</b><span>'+label+'</span></div>').join("")+'</div>'+panel("All assignments",queue(items));
  }
  if(tab==="My Queue") $("content").innerHTML=panel("My assignments",queue(items.filter(a=>a.reviewer===data.viewer.email)));
  if(tab==="Reports") $("content").innerHTML=panel("Weekly reconciliation reports",table(["Portfolio","Coverage","Retrieved","New assignments","Generated","Export"],data.runs.filter(r=>r.mode==="weekly-report"&&r.status==="Imported").map(r=>[esc(r.portfolio),esc(r.from)+" to "+esc(r.to),r.count,r.newAssignments||0,esc(new Date(r.time).toLocaleString()),'<button data-export="'+esc(r.id)+'">CSV</button>']),"No completed weekly reports."))+panel("30-day reconciliation slices",table(["Portfolio","From","Through","Status"],data.runs.filter(r=>r.mode==="audit30").map(r=>[esc(r.portfolio),esc(r.from),esc(r.to),esc(r.error||r.status)]),"No audit slices yet."));
  if(tab==="Notifications") $("content").innerHTML=panel("Alert preferences",'<p>'+ (data.alertConfig.gateway?"Delivery gateway configured.":"External delivery is not configured; in-app alerts remain available.") +'</p><form data-route="alert-preferences"><label>Email alerts<select name="email"><option value="false">Off</option><option value="true" '+(data.alertConfig.preferences?.email?'selected':'')+'>On</option></select></label><label>Mobile alerts<select name="mobile"><option value="false">Off</option><option value="true" '+(data.alertConfig.preferences?.mobile?'selected':'')+'>On</option></select></label><label>Mobile number<input name="mobileDestination" value="'+esc(data.alertConfig.preferences?.mobileDestination||"")+'" placeholder="+91..."></label><label>Browser push<select name="push"><option value="false">Off</option><option value="true" '+(data.alertConfig.preferences?.push?'selected':'')+'>On</option></select></label><button>Save alert preferences</button></form>')+panel("New article alerts",'<form data-route="notification-read"><input type="hidden" name="all" value="true"><button>Mark all as read</button></form>'+table(["Article","Portfolio","Priority","Detected","Status"],(data.notifications||[]).map(n=>['<a target="_blank" rel="noopener" href="https://pubmed.ncbi.nlm.nih.gov/'+esc(n.pmid)+'/">'+esc(data.articles[n.pmid]?.title||n.pmid)+'</a>',esc(n.portfolio),esc(data.articles[n.pmid]?.priority?.level||"Awaiting screening"),esc(new Date(n.at).toLocaleString()),n.read?"Read":"New"]),"No new article alerts."));
  if(tab==="Clients") $("content").innerHTML=panel("Client portfolios",table(["Client","Portfolio","Surveillance"],data.watches.map(w=>[esc(w.client||"Unassigned"),esc(w.portfolio),w.active===false?"Paused":"Every 15 min"]),"No clients yet. Set a client on a watchlist."));
  if(tab==="Watchlists") $("content").innerHTML=panel("PubMed watchlists",'<form data-route="watch"><label>Client<input name="client" placeholder="Client name"></label><label>Portfolio<input name="portfolio" required></label><label>Surveillance<select name="active"><option value="true">Active</option><option value="false">Paused</option></select></label><label>Weekly trigger<select name="triggerDay"><option value="2">Tuesday</option><option value="1">Monday</option><option value="3">Wednesday</option><option value="4">Thursday</option><option value="5">Friday</option><option value="6">Saturday</option><option value="0">Sunday</option></select></label><label>PubMed query<input name="query" required placeholder="e.g. aciclovir OR acyclovir"></label><button>Save watchlist</button></form>'+table(["Client","Portfolio","Query","Status"],data.watches.map(w=>[esc(w.client||"Unassigned"),esc(w.portfolio),esc(w.query),w.active===false?"Paused":"Active"]),"Add a product or portfolio watchlist to start."));
  if(tab==="Team") $("content").innerHTML=panel("Reviewer profiles",'<form data-route="profile"><label>Name<input name="name" required></label><label>Sign-in email<input type="email" name="email" required></label><label>Portfolio<input name="portfolio" placeholder="All portfolios"></label><label>Open assignment limit<input type="number" name="capacity" min="1" max="500" value="25" required></label><label>Availability<select name="active"><option value="true">Active</option><option value="false">Unavailable</option></select></label><button>Save reviewer</button></form>'+table(["Name","Email","Role","Portfolio","Open"],data.profiles.map(p=>[esc(p.name),esc(p.email),esc(p.role),esc(p.portfolio||"All"),items.filter(a=>a.reviewer===p.email&&a.status!=="Complete").length]),"No profiles."));
  if(tab==="Batches") $("content").innerHTML=panel("Backfill a date range",watchOptions?
    '<form data-route="import"><label>Portfolio<select name="portfolio">'+watchOptions+'</select></label><label>From<input name="from" type="date" required></label><label>Through<input name="to" type="date" required></label><button>Import citations</button></form>':
    '<p>Save a watchlist before importing a batch.</p>')+panel("Batch archive",'<form data-route="evidence"><button>Process pending evidence</button></form>'+table(["Portfolio","Create Date range","Citations","Status","Manifest"],data.runs.map(r=>[esc(r.portfolio),esc(r.from)+" to "+esc(r.to),r.count,esc(r.error||r.status),r.status==="Imported"?'<button data-export="'+esc(r.id)+'">CSV</button>':""]),"No batches yet."));
}
async function refresh(){data=await api("state");render();}
function download(id) {
  const run=data.runs.find(r=>r.id===id);
  const cell=value=>'"'+String(value??"").replace(/^[=+@\-]/,"'$&").replaceAll('"','""')+'"';
  const rows=[["PMID","Title","Journal","Date","DOI","PubMed URL","Portfolio","Reviewer","Status","Full text","Screenshot","Citation XML"]];
  run.ids.forEach(pmid=>{
    const a=data.articles[pmid], item=data.assignments.find(x=>x.pmid===pmid&&x.portfolio===run.portfolio);
    rows.push([pmid,a.title,a.journal,a.date,a.doi,a.url,run.portfolio,item?.reviewer,item?.status,a.fullTextStatus||"Pending",a.screenshotStatus||"Pending",a.citationXmlStatus||"Pending"]);
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
  if(body.all)body.all=body.all==="true";
  const route=form.dataset.route || "review";
  if(route==="review")body.id=active.id;
  button.disabled=true;message(route==="import"?"Retrieving PubMed citations…":"Saving…");
  try {
    if(route==="alert-preferences"){
      for(const k of ["email","mobile","push"])body[k]=body[k]==="true";
      if(body.push){
        if(!data.alertConfig.gateway||!data.alertConfig.vapidPublicKey||!("serviceWorker" in navigator)||!("PushManager" in window)||!("Notification" in window))throw new Error("Browser push requires configured delivery, VAPID and a supported browser.");
        if(await Notification.requestPermission()!=="granted")throw new Error("Notification permission was not granted.");
        await navigator.serviceWorker.register("/sw.js");
        const registration=await navigator.serviceWorker.ready;
        const key=data.alertConfig.vapidPublicKey.replace(/-/g,"+").replace(/_/g,"/");
        const bytes=Uint8Array.from(atob(key.padEnd(Math.ceil(key.length/4)*4,"=")),c=>c.charCodeAt(0));
        const subscription=await registration.pushManager.getSubscription()||await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes});
        body.subscription=subscription.toJSON();
      }
    }
    await api(route,body);if(route==="review")$("dialog").close();await refresh();message(route==="import"?"Batch imported.":"Saved.");}
  catch(error){message(error.message,true);if(route==="review")$("dialog").close();if(route==="import")await refresh().catch(()=>{});}
  finally{button.disabled=false;}
});
refresh().catch(error=>message(error.message,true));
setInterval(async()=>{if(document.hidden||$("dialog").open||document.activeElement?.closest("form"))return;try{const next=await api("state");data=next;if(tab==="Notifications"||tab==="Overview"||tab==="My Queue")render();else $("identity").textContent=data.viewer.name+" · "+data.viewer.role+" · "+(data.notifications||[]).filter(n=>!n.read).length+" unread";}catch{}},60000);
</script></html>`;

const importTool = {
  name: "run_pubmed_watchlists",
  description: "Run saved Literature Bench watchlists continuously, reconcile historical dates and deliver configured alerts. Save the batch, deduplicate PMIDs and allocate reviewer work.",
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
    if (path === "/sw.js" && request.method === "GET") return new Response(pushWorker,{headers:{"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"no-cache","Service-Worker-Allowed":"/"}});
    if (path === "/mcp" && request.method === "POST") return mcp(request,env);
    if (!path.startsWith("/api/")) return new Response(html, { headers: { "Content-Type":"text/html; charset=utf-8" } });
    try { return await api(request, env, path); }
    catch (error) { return json({ error:error.message }, 500); }
  }
};
