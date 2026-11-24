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
    await new Promise(resolve => setTimeout(resolve, 350));
    const details = await fetchPubmedDetails(ids).catch(() => ({}));
    for (const id of ids) if (details[id]) Object.assign(articles[id], details[id], { abstractSource:details[id].abstract ? "PubMed" : "", abstractCheckedAt:new Date().toISOString() });
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
    out[pmid] = { abstract, authors, meshTerms:[...new Set(list(/<DescriptorName[^>]*>([^<]+)</g))].slice(0, 30),
      keywords:[...new Set(list(/<Keyword[^>]*>([\s\S]*?)<\/Keyword>/g))].slice(0, 20), pubTypes:[...new Set(list(/<PublicationType[^>]*>([^<]+)</g))].slice(0, 8) };
  }
  return out;
}
async function fetchPubmedDetails(ids) {
  const url = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi");
  url.search = new URLSearchParams({ db:"pubmed", tool:"literature_bench", retmode:"xml", id:ids.join(",") });
  const response = await fetch(url, { signal:AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error("PubMed efetch returned HTTP " + response.status);
  return parsePubmedXml(await response.text());
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
    const details = (await fetchPubmedDetails([article.id]))[article.id];
    if (details) { got = true; Object.assign(fields, details); if (details.abstract) fields.abstractSource = "PubMed"; }
  } catch (error) { errors.push(error.message); }
  const core = await coreOnce();
  if (core) {
    got = true;
    if (!fields.abstract && core.abstractText) { fields.abstract = xmlText(core.abstractText); fields.abstractSource = "Europe PMC"; }
    if (!fields.keywords?.length && core.keywordList?.keyword) fields.keywords = core.keywordList.keyword.slice(0, 20);
    if (!fields.meshTerms?.length && core.meshHeadingList?.meshHeading) fields.meshTerms = core.meshHeadingList.meshHeading.map(m => m.descriptorName).filter(Boolean).slice(0, 30);
    if (core.citedByCount !== undefined) fields.citedBy = Number(core.citedByCount);
  }
  try {
    const work = await openAlexWork(env, article);
    if (work) {
      got = true;
      if (work.cited_by_count !== undefined) fields.citedBy = Math.max(fields.citedBy || 0, Number(work.cited_by_count));
      fields.topic = work.primary_topic?.display_name || "";
      fields.workType = work.type || "";
      const text = invertedToText(work.abstract_inverted_index);
      if (!fields.abstract && !article.abstract && text) { fields.abstract = text; fields.abstractSource = "OpenAlex"; }
    }
  } catch (error) { errors.push(error.message); }
  if (got) { fields.enrichedAt = new Date().toISOString(); fields.abstractCheckedAt = fields.enrichedAt; }
  if (errors.length) fields.enrichError = errors.join("; ");
  return fields;
}
// Text of the main sections from JATS (PMC / Europe PMC) or TEI (GROBID) XML.
function xmlToText(xml) {
  const cleaned = String(xml).replace(/<xref\b[^>]*>[\s\S]*?<\/xref>/g, "").replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/g, "").replace(/<table-wrap\b[\s\S]*?<\/table-wrap>/g, "");
  const body = /<body\b[\s\S]*?<\/body>/.exec(cleaned)?.[0] || /<text\b[\s\S]*?<\/text>/.exec(cleaned)?.[0] || "";
  const abstract = /<abstract\b[\s\S]*?<\/abstract>/.exec(cleaned)?.[0] || "";
  return [abstract, body].flatMap(part => [...part.matchAll(/<(title|head|p)\b[^>]*>([\s\S]*?)<\/\1>/g)].map(m => xmlText(m[2]))).filter(t => t.length > 1).join("\n").replace(/[ \t]+([.,;:)])/g, "$1");
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
  if (!env.GROBID_URL) return "";
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
  for (const location of pdfs.slice(0, 3)) {
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
        fullTextOrigin:"Unpaywall", fullTextVersion:location.version || "", fullTextRestricted:!permissive(location), _text:text };
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
async function captureFullText(env, article, lookupOnce, coreOnce) {
  const pmc = await captureFromPmc(env, article);
  if (pmc.fullTextStatus === "Captured") return pmc;
  const europe = await captureFromEuropePmc(env, article, coreOnce, pmc.fullTextStatus);
  if (europe.fullTextStatus === "Captured") return europe;
  return captureFromUnpaywall(env, article, pmc.fullTextStatus, lookupOnce);
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
  const sections = [];
  for (const id of wanted) {
    const article = state.articles[id];
    const item = state.assignments.find(a => a.pmid === id && (manager || a.reviewer === viewer.email));
    if (!article || !item) continue;
    let png = null;
    if (article.screenshotKey) { const object = await env.BUCKET.get(article.screenshotKey); if (object) png = new Uint8Array(await object.arrayBuffer()); }
    const lines = ["PMID " + id + " · " + [article.journal, article.date].filter(Boolean).join(" · "),
      "DOI: " + (article.doi || "-") + " · " + article.url,
      "Portfolio: " + item.portfolio + ((item.molecules || []).filter(m => m !== item.portfolio).length ? " · Molecules: " + item.molecules.join(", ") : ""),
      "Reviewer: " + (item.reviewer || "Unassigned") + " · Status: " + item.status + (item.note ? " · Note: " + item.note : ""),
      "Retraction check: " + (article.retractionStatus || "Pending") + " · Access: " + (article.oaStatus || "Pending") + " · Full text: " + (article.fullTextStatus || "Pending") +
        (article.citedBy !== undefined ? " · Cited by: " + article.citedBy : "")];
    if ((article.authors || []).length) lines.push("Authors: " + article.authors.join(", "));
    if ((article.meshTerms || []).length) lines.push("MeSH: " + article.meshTerms.slice(0, 12).join("; "));
    if (article.abstract) lines.push("Abstract: " + article.abstract.replace(/\s+/g, " ").slice(0, 1800));
    for (const passage of (article.keyPassages || []).slice(0, 4)) lines.push("Key passage: " + passage);
    sections.push({ title:article.title, lines, png });
  }
  if (!sections.length) return null;
  return buildPdf(String(body.title || "LiteraSift export").slice(0, 100), String(body.subtitle || "PubMed citations with page screenshots.").slice(0, 300), sections);
}
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
  const files = [], rows = [["PMID", "Title", "DOI", "Full text status", "Source", "Licence", "Source URL", "Access", "Files"]];
  let total = 0;
  for (const id of ids) {
    const article = state.articles[id];
    if (!article || !state.assignments.some(a => a.pmid === id && (manager || a.reviewer === viewer.email))) continue;
    const names = [];
    for (const [key, name] of [[article.fullTextKey, "PMID_" + id + "." + (/\.(\w+)$/.exec(article.fullTextKey || "")?.[1] || "bin")], [article.fullTextTextKey, "PMID_" + id + "_text.txt"]]) {
      if (!key) continue;
      const object = await env.BUCKET.get(key);
      if (!object) continue;
      const data = new Uint8Array(await object.arrayBuffer());
      total += data.length;
      if (total > 150 * 1024 * 1024) throw new Error("Selection too large for one ZIP; export fewer articles.");
      files.push({ name, data }); names.push(name);
    }
    rows.push([id, article.title, article.doi, article.fullTextStatus || "Pending", article.fullTextOrigin || "", article.fullTextLicense || "", article.fullTextSource || article.fullTextLink || "", article.oaStatus || "", names.join(" ")]);
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
  const env = Object.assign(Object.create(baseEnv), { UNPAYWALL_EMAIL:baseEnv.UNPAYWALL_EMAIL || state.settings?.unpaywallEmail || "",
    ALLOW_RESTRICTED:state.settings?.storeRestricted !== false });
  const articles = ids ? ids.map(id=>state.articles[id]).filter(Boolean) : Object.values(state.articles);
  const enabled = Boolean(env.SCREENSHOT_FN || (env.SCREENSHOT_ENDPOINT && env.SCREENSHOT_TOKEN));
  const needsFullText = a => !a.fullTextStatus || a.fullTextStatus === "Retry needed" ||
    (Boolean(env.UNPAYWALL_EMAIL) && ["No PMC record","No eligible PMC file"].includes(a.fullTextStatus));
  // Local captures made before screenshotKind existed may be saved error pages, so they are taken again.
  const needsScreen = a => enabled && (!a.screenshotKey || (Boolean(env.SCREENSHOT_FN) && !a.screenshotKind));
  const needsEnrich = a => !a.enrichedAt;
  const needsOa = a => Boolean(env.UNPAYWALL_EMAIL) && (!a.oaCheckedAt ||
    (!a.oaIsOpen && Date.now() - Date.parse(a.oaCheckedAt) > oaRecheckMs));
  const needsRetraction = a => !a.retractionCheckedAt || Date.now() - Date.parse(a.retractionCheckedAt) > retractionRecheckMs;
  const pending = articles.filter(a=>needsFullText(a) || needsScreen(a) || needsRetraction(a) || needsOa(a) || needsEnrich(a))
    .sort((a,b)=>String(a.evidenceAttempt || "").localeCompare(String(b.evidenceAttempt || ""))).slice(0,4);
  for (const article of pending) {
    const status = {evidenceAttempt:new Date().toISOString()};
    let lookup; // at most one Unpaywall request per article per pass
    const lookupOnce = async () => (lookup ||= await unpaywallLookup(env,article));
    let core;
    const coreOnce = async () => (core ||= { value:await europePmcCore(article).catch(() => null) }).value;
    if (needsEnrich(article)) {
      try { Object.assign(status,await enrichMetadata(env,article,coreOnce)); }
      catch (error) { status.enrichError = error.message; }
    }
    if (needsFullText(article)) {
      try { Object.assign(status,await captureFullText(env,article,lookupOnce,coreOnce)); }
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
    if (status._text) {
      const molecules = [...new Set(state.assignments.filter(a => a.pmid === article.id).flatMap(a => a.molecules || []))];
      try {
        const textKey = "evidence/" + article.id + "/fulltext.txt";
        await env.BUCKET.put(textKey, status._text.slice(0, 2_000_000), { httpMetadata:{ contentType:"text/plain; charset=utf-8" } });
        status.fullTextTextKey = textKey;
        status.keyPassages = keyPassages(status._text, molecules);
      } catch { /* best effort */ }
    }
    delete status._text;
    await write(env, data => Object.assign(data.articles[article.id],status));
  }
  if (state.assignments.some(a => !a.reviewer)) await write(env, data => data.assignments.filter(a => !a.reviewer).forEach(a => allocate(data, a)));
  const queued = articles.filter(a=>needsFullText(a) || needsScreen(a) || needsRetraction(a) || needsOa(a)).length;
  return {processed:pending.length, queued, unattempted:articles.filter(a=>!a.evidenceAttempt).length,
    screenshotConfigured:enabled, unpaywallConfigured:Boolean(env.UNPAYWALL_EMAIL), grobidConfigured:Boolean(env.GROBID_URL)};
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
    return json({ viewer, config:{ storeRestricted:state.settings?.storeRestricted !== false, grobid:Boolean(env.GROBID_URL), terms:safetyTerms, accounts:Boolean(env.HOST_ACCOUNTS), screenshots:Boolean(env.SCREENSHOT_FN || (env.SCREENSHOT_ENDPOINT && env.SCREENSHOT_TOKEN)), unpaywall:Boolean(env.UNPAYWALL_EMAIL || state.settings?.unpaywallEmail), unpaywallFromEnv:Boolean(env.UNPAYWALL_EMAIL),
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
  if (path === "/api/settings") {
    const email = String(body.unpaywallEmail ?? "").trim();
    if ("unpaywallEmail" in body && email && (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200)) return json({error:"Enter a valid contact email for Unpaywall."},400);
    await write(env, data => {
      const settings = data.settings ||= {};
      if ("unpaywallEmail" in body) settings.unpaywallEmail = email;
      if ("storeRestricted" in body) {
        const turnedOn = body.storeRestricted === true && settings.storeRestricted === false;
        settings.storeRestricted = body.storeRestricted === true;
        // Articles that only had a link (or no eligible copy) are tried again under the wider rule.
        if (turnedOn) for (const a of Object.values(data.articles)) if (/^(Open access link only|No eligible PMC file|No PMC record|No downloadable open-access copy)$/.test(a.fullTextStatus || "")) { delete a.fullTextStatus; delete a.evidenceAttempt; }
      }
    });
    return json({ ok:true });
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
  } else if (path === "/api/watch") {
    const watch = { portfolio:String(body.portfolio || "").trim(), molecule:String(body.molecule || "").trim().slice(0,100), query:String(body.query || "").trim() };
    if (!watch.portfolio || !watch.query || watch.query.length > 1500) return json({error:"Enter a portfolio and a PubMed query."},400);
    await write(env, data => {
      keepOwner(data, watch);
      data.watches = data.watches.filter(w => watchKey(w) !== watchKey(watch));
      data.watches.push(watch);
    });
  } else if (path === "/api/watches") {
    const portfolio = String(body.portfolio || "").trim();
    if (!portfolio || !Array.isArray(body.rows) || !body.rows.length || body.rows.length > 500) return json({error:"Enter a portfolio and 1 to 500 molecules."},400);
    const created = [], skipped = [];
    const bulkOwner = String(body.owner || "").trim().toLowerCase();
    if (bulkOwner && !state.profiles.some(p => p.email === bulkOwner && p.active)) return json({error:"Choose an active team member."},400);
    for (const row of body.rows) {
      const names = [row?.molecule, ...(Array.isArray(row?.synonyms) ? row.synonyms : [])];
      const molecule = String(row?.molecule || "").trim().slice(0,100);
      const query = molecule && buildQuery(names, body.safetyOnly === true);
      if (query) created.push({ portfolio, molecule, query, ...(bulkOwner ? { owner:bulkOwner } : {}) }); else skipped.push(molecule || "(blank)");
    }
    await write(env, data => {
      const keys = new Set(created.map(watchKey));
      created.forEach(w => keepOwner(data, w));
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
    const owner = String(body.owner || "").trim().toLowerCase();
    if (owner && !state.profiles.some(p => p.email === owner && p.active)) return json({error:"Choose an active team member."},400);
    const watch = { portfolio, molecule, query, ...(owner ? { owner } : {}) };
    await write(env, data => {
      keepOwner(data, watch);
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
<dialog id="linkdlg"><h2 id="linktitle"></h2><p id="linknote" class="sub"></p><div style="display:grid;gap:12px"><input id="linkvalue" readonly aria-label="Link"><div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn" id="linkcopy">Copy link</button><button type="button" class="btn outline" id="linkshare">Share…</button><button type="button" class="btn outline" id="linkclose">Done</button></div></div></dialog>
<dialog id="dialog"><h2>Screen citation</h2><p id="citation" class="sub"></p><div id="detail" style="max-height:38vh;overflow:auto;margin-bottom:12px"></div><form id="review"><label>Status<select name="status"><option>Pending</option><option>In review</option><option>Full text needed</option><option>Complete</option></select></label><label>Decision notes<textarea name="note" rows="4"></textarea></label><div style="display:flex;gap:8px"><button class="btn">Save decision</button><button type="button" class="btn outline" id="close">Cancel</button></div></form></dialog>
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
  Account:'<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  Team:'<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M17 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6"/>',
  moon:'<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>', sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  alert:'<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'
};
const ic = name => '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+paths[name]+'</svg>';
const subtitles = {Overview:"Screening progress across portfolios.","My Queue":"Citations assigned to you.","All Assignments":"Every citation across the team.","Search & Pull":"Type a molecule and a date range to pull every matching PubMed article.",Batches:"Imports and evidence processing.",Watchlists:"Molecules and PubMed queries that feed the screening queue.",Team:"Reviewers and capacity.",Settings:"Integrations and open-access checks.",Account:"Your sign-in and password."};
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
async function exportFile(route,ext,pmids,title,subtitle,label){
  pmids=[...new Set(pmids)];
  if(!pmids.length)throw new Error("Nothing to export.");
  const parts=Math.ceil(pmids.length/40);
  for(let i=0;i<parts;i++){
    message("Building "+label+" "+(i+1)+" of "+parts+"…");
    const res=await fetch("/api/"+route,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pmids:pmids.slice(i*40,i*40+40),title:title+(parts>1?" (part "+(i+1)+" of "+parts+")":""),subtitle})});
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
let extracting=null, pullRun="";
function drawProgress(){
  const box=$("progress");if(!box)return;
  const runs=data.runs.filter(r=>r.status==="Imported"&&r.ids.length);
  if(!runs.length){box.innerHTML="";return;}
  const run=runs.find(r=>r.id===pullRun)||runs[0], st=runStats(run), got=st.pmc+st.epmc+st.unpaywall;
  const bar=(label,value,color)=>'<div class="row"><span>'+label+'</span><span class="sub">'+value+" / "+st.n+'</span></div><div class="bar"><i style="width:'+(st.n?Math.round(value/st.n*100):0)+'%"></i></div>';
  box.innerHTML=panel("Full-text extraction",'<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px"><select id="runpick" aria-label="Pull">'+runs.slice(0,15).map(r=>'<option value="'+esc(r.id)+'"'+(r.id===run.id?" selected":"")+'>'+esc((r.molecule||r.portfolio)+" · "+r.from+" → "+r.to+" ("+r.count+")")+'</option>').join("")+'</select>'+
    (extracting?'<button class="btn outline" id="extractstop">Stop</button><span class="sub" style="align-self:center">Working… '+got+' full texts so far</span>':'<button class="btn" id="extractgo">Extract full text now</button>')+
    '<button class="btn outline" data-zip="'+esc(run.id)+'">Download full texts (ZIP)</button><button class="btn outline" data-pdfrun="'+esc(run.id)+'">PDF with snapshots</button></div>'+
    bar("Abstracts and metadata",st.abstracts)+bar("Open access checked (Unpaywall)",st.oaChecked)+bar("Retraction checked",st.retr)+
    '<div class="row"><span>Full text stored</span><b>'+got+'</b></div><div class="row"><span class="sub">PubMed Central '+st.pmc+' · Europe PMC '+st.epmc+' · Unpaywall '+st.unpaywall+'</span></div>'+
    '<div class="row"><span>Open access, link only (licence does not allow storing)</span><b>'+st.linkOnly+'</b></div><div class="row"><span>Closed access</span><b>'+st.closed+'</b></div><div class="row"><span>With key passages extracted</span><b>'+st.passages+'</b></div>',
    "Starts automatically after a pull. For each article: PubMed Central, then Europe PMC, then Unpaywall, stored only under open licences.");
  $("runpick").onchange=e=>{pullRun=e.target.value;drawProgress();};
  if($("extractgo"))$("extractgo").onclick=()=>extractRun(run.id);
  if($("extractstop"))$("extractstop").onclick=()=>{if(extracting)extracting.stop=true;};
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
let data, tab, active, filt={q:"",status:"",portfolio:"",oa:"",ft:""}, shown=[];
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
function mark(text,molecules){
  const names=(molecules||[]).filter(Boolean), terms=(data.config.terms||[]).concat(names);
  if(!terms.length)return esc(text);
  const re=new RegExp("("+terms.map(t=>t.replace(/[.*+?^()|\\[\\]\\\\]/g,"\\\\$&")).join("|")+")","gi");
  return String(text).split(re).map((part,i)=>i%2?'<mark class="'+(names.some(n=>n.toLowerCase()===part.toLowerCase())?"mol":"ae")+'">'+esc(part)+"</mark>":esc(part)).join("");
}
const badge=(text,color="")=>'<span class="badge '+color+'">'+esc(text)+'</span>';
const flagged=item=>["Retracted","Expression of concern"].includes(item?.retractionStatus);
function evidenceChips(item){
  const chips=[];
  if(flagged(item))chips.push(badge(item.retractionStatus,"red"));
  else if(item.retractionStatus==="Correction")chips.push(badge("Correction","amber"));
  if(item.citedBy!==undefined)chips.push(badge("Cited "+item.citedBy+"×"));
  if(item.oaStatus)chips.push('<span class="badge '+(oaColor[item.oaStatus]||"")+'" title="'+esc((item.oaLicense?"Licence: "+item.oaLicense+". ":"")+(item.oaVersion?"Version: "+item.oaVersion+". ":"")+(item.oaHostType?"Host: "+item.oaHostType+".":""))+'">'+esc(oaLabel(item))+'</span>');
  if(item.fullTextKey&&item.fullTextRestricted)chips.push('<span class="badge amber" title="Open-access copy under a restrictive licence: internal screening use only">Restricted licence'+(item.fullTextLicense?" · "+esc(item.fullTextLicense):"")+'</span>');
  chips.push(item.fullTextKey?'<a class="badge green" href="/api/full-text/'+esc(item.id)+'">Full text</a>':item.fullTextLink?'<a class="badge blue" target="_blank" rel="noopener" href="'+esc(item.fullTextLink)+'">Open-access link</a>':badge(item.fullTextStatus||"Full text pending"));
  chips.push(item.screenshotKey?'<a class="badge green" href="/api/screenshot/'+esc(item.id)+'">Screenshot</a>':badge(item.screenshotStatus||"Screenshot pending"));
  return '<div class="chips">'+chips.join("")+"</div>";
}
function queueRows(items){
  return table(["Article","Portfolio","Reviewer","Status",""],items.slice(0,200).map(a=>{
    const item=data.articles[a.pmid]||{};
    return ['<a class="title" target="_blank" rel="noopener" href="'+esc(item.url)+'">'+esc(item.title)+'</a><div class="sub">PMID '+esc(a.pmid)+' · '+esc(item.journal)+' · '+esc(item.date)+((item.authors||[]).length?' · '+esc(item.authors.slice(0,3).join(", ")+(item.authors.length>3?" et al.":"")):"")+'</div>'+evidenceChips({...item,id:a.pmid})+
        (item.abstract?'<details class="abs"><summary>Abstract</summary><div>'+mark(item.abstract.slice(0,2500),a.molecules)+'</div></details>':""),
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
    '<select data-filter="oa" aria-label="Access"><option value="">All access</option>'+[["open","Open access"],["closed","Closed access"],["unchecked","Not yet checked"]].map(([v,l])=>'<option value="'+v+'"'+(filt.oa===v?" selected":"")+'>'+l+"</option>").join("")+"</select>"+
    '<select data-filter="ft" aria-label="Full text"><option value="">All full-text states</option>'+[["stored","Full text stored"],["link","Open-access link only"],["none","No full text"]].map(([v,l])=>'<option value="'+v+'"'+(filt.ft===v?" selected":"")+'>'+l+"</option>").join("")+"</select>"+
    '<button class="btn outline" data-pdf="queue" title="Download the filtered list as a PDF with a snapshot of each article">Export PDF</button><button class="btn outline" data-zip="queue" title="Download stored full texts for the filtered list as a ZIP">Full texts (ZIP)</button>'+
    '<select data-filter="portfolio" aria-label="Portfolio"><option value="">All portfolios</option>'+portfolios.map(p=>'<option'+(filt.portfolio===p?" selected":"")+'>'+esc(p)+"</option>").join("")+"</select></div>"+
    '<div id="qtable">'+queueRows(applyFilter(items))+"</div></section>";
}
function applyFilter(items){
  const q=filt.q.trim().toLowerCase();
  return items.filter(a=>(!filt.status||a.status===filt.status)&&(!filt.portfolio||a.portfolio===filt.portfolio)&&(!filt.oa||oaGroup(data.articles[a.pmid]||{})===filt.oa)&&(!filt.ft||ftGroup(data.articles[a.pmid]||{})===filt.ft)&&
    (!q||(a.pmid+" "+(data.articles[a.pmid]?.title||"")+" "+(a.molecules||[]).join(" ")).toLowerCase().includes(q)));
}
function stat(label,value,icon,warn){return '<div class="card'+(warn&&value?" warn":"")+'"><div class="lbl">'+label+ic(icon)+'</div><b data-count="'+value+'">0</b></div>';}
function render() {
  const manager=data.viewer.role==="manager";
  const tabs=(manager?["Overview","Search & Pull","My Queue","All Assignments","Batches","Watchlists","Team","Settings"]:["My Queue"]).concat(data.config.accounts?["Account"]:[]);
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
    const checkedOa=arts.filter(a=>a.oaCheckedAt), openOa=checkedOa.filter(a=>a.oaIsOpen);
    const oaCounts={};checkedOa.forEach(a=>{oaCounts[a.oaStatus]=(oaCounts[a.oaStatus]||0)+1;});
    html='<div class="cards">'+stat("Unique citations",arts.length,"Batches")+stat("Assigned",items.filter(a=>a.reviewer).length,"Team")+stat("Unassigned",items.filter(a=>!a.reviewer).length,"alert",true)+stat("Complete",done,"My Queue")+stat("Retraction alerts",alerts,"alert",true)+stat("Open access %",checkedOa.length?Math.round(openOa.length/checkedOa.length*100):0,"Watchlists")+'</div>'+
      '<div class="grid2">'+panel("Screening progress",'<div class="row"><span>'+done+" of "+items.length+' complete</span><b>'+pct+'%</b></div><div class="bar"><i data-width="'+pct+'"></i></div>'+
        portfolios.map(p=>{const list=items.filter(a=>a.portfolio===p),d=list.filter(a=>a.status==="Complete").length;return '<div class="row"><span>'+esc(p)+'</span><span class="sub">'+d+" / "+list.length+"</span></div>";}).join(""))+
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
    html=panel("Pull articles for a molecule",'<form class="grid" data-route="pull"><label>Molecule<input name="molecule" required placeholder="e.g. aciclovir"></label><label>Synonyms, brands (optional)<input name="synonyms" placeholder="acyclovir, Zovirax"></label><label>From<input name="from" type="date" required value="'+start+'" max="'+today+'"></label><label>Through<input name="to" type="date" required value="'+today+'" max="'+today+'"></label><label>Portfolio (optional)<input name="portfolio" placeholder="Defaults to the molecule name"></label><label>Assign to<select name="owner">'+peopleOptions("","Auto-assign")+'</select></label><label class="check"><input type="checkbox" name="safety">&nbsp;Safety-related articles only</label><div><button class="btn">Pull articles</button></div></form>',"Searches PubMed by the date each article was added, saves the molecule as a watchlist so new articles keep arriving daily, and assigns the results to reviewers.")+'<div id="progress"></div>'+
      panel("Recent pulls",table(["Watchlist","Date range","Citations","Status",""],data.runs.slice(0,8).map(r=>[esc(r.portfolio+(r.molecule?" · "+r.molecule:"")),esc(r.from)+" → "+esc(r.to),r.count,badge(r.error||r.status,r.status==="Imported"?"green":"red"),r.status==="Imported"?'<button class="btn outline sm" data-pdfrun="'+esc(r.id)+'">PDF with screenshots</button>':""]),"No pulls yet."),"",true);
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
    panel("Saved watchlists ("+data.watches.length+")",table(["Portfolio","Molecule","Owner","Query"],data.watches.map(w=>[esc(w.portfolio),esc(w.molecule||"—"),w.owner?esc((data.profiles.find(p=>p.email===w.owner)||{name:w.owner}).name):'<span class="sub">Auto</span>','<span class="sub">'+esc(w.query)+"</span>"]),"Add a molecule or portfolio watchlist to start."),"",true);
  if(tab==="Settings") html=panel("Unpaywall (open access)",'<form class="grid" data-route="settings"><label class="wide">Contact email for Unpaywall<input type="email" name="unpaywallEmail" value="'+esc(data.config.unpaywallEmail)+'" placeholder="you@example.com"'+(data.config.unpaywallFromEnv?' disabled':'')+'></label><div><button class="btn"'+(data.config.unpaywallFromEnv?' disabled':'')+'>Save</button></div></form>'+
      '<div class="row"><span>Status</span>'+(data.config.unpaywall?badge("Active","green"):badge("Not configured","amber"))+'</div>'+
      '<form data-route="recheck-access" style="margin-top:10px"><button class="btn outline">Re-check open access for all articles</button></form>',
      "Unpaywall requires a contact email on each request; it is sent to Unpaywall only. Every article with a DOI gets an open-access status (gold, hybrid, green, bronze or closed). Permissively licensed PDFs are stored, other open copies are linked. Closed articles are re-checked every 30 days."+(data.config.unpaywallFromEnv?" The email is set by the server environment (UNPAYWALL_EMAIL).":""))+
    panel("Restricted-licence full text",'<form class="grid" data-route="settings"><label class="wide">Store open-access copies under restrictive licences<select name="storeRestricted"><option value="true"'+(data.config.storeRestricted?" selected":"")+'>Yes, store them (internal use)</option><option value="false"'+(data.config.storeRestricted?"":" selected")+'>No, only open licences (CC0, CC BY, CC BY-SA, CC BY-ND)</option></select></label><div><button class="btn">Save</button></div></form>',
      "Covers free-to-read copies found by PubMed Central, Europe PMC and Unpaywall that carry licences such as CC BY-NC or publisher terms, or none at all. They are marked 'Restricted licence' and meant for internal screening only; do not redistribute them. Only copies the publisher or a repository offers legally for free are fetched. Turning this on retries articles that only had a link.")+
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
  $("content").innerHTML=html;
  animate();
  drawProgress();
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
  const rows=[["PMID","Title","Journal","Date","DOI","PubMed URL","Portfolio","Molecules","Reviewer","Status","Full text","Screenshot","Retraction check","OA status","OA licence","OA link","Cited by","Abstract","Key passages"]];
  run.ids.forEach(pmid=>{
    const a=data.articles[pmid], item=data.assignments.find(x=>x.pmid===pmid&&x.portfolio===run.portfolio);
    rows.push([pmid,a.title,a.journal,a.date,a.doi,a.url,run.portfolio,(item?.molecules||[]).join("; "),item?.reviewer,item?.status,a.fullTextStatus||"Pending",a.screenshotStatus||"Pending",a.retractionStatus||"Pending",a.oaStatus||"Pending",a.oaLicense||"",a.oaUrl||"",a.citedBy??"",a.abstract||"",(a.keyPassages||[]).join(" | ")]);
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
  const target=event.target.closest("[data-tab],[data-export],[data-review],[data-pdf],[data-pdfrun],[data-zip],[data-resetlink],[data-revoke]");
  if(!target)return;
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
    $("detail").innerHTML=(art.abstract?'<div class="sub" style="margin-bottom:4px">Abstract'+(art.abstractSource?" ("+esc(art.abstractSource)+")":"")+'</div><div style="font-size:13px;line-height:1.55">'+mark(art.abstract,active.molecules)+'</div>':'<div class="sub">No abstract available yet.</div>')+
      ((art.keyPassages||[]).length?'<div class="sub" style="margin:10px 0 4px">Key passages from the full text</div>'+art.keyPassages.map(t=>'<div style="font-size:13px;margin-bottom:6px">“'+mark(t,active.molecules)+'”</div>').join(""):"")+
      ((art.meshTerms||[]).length?'<div class="chips">'+art.meshTerms.slice(0,12).map(t=>badge(t)).join("")+'</div>':"")+
      ((art.authors||[]).length?'<div class="sub" style="margin-top:8px">'+esc(art.authors.join(", "))+'</div>':"")+
      (art.fullTextKey?'<div style="margin-top:8px"><a href="/api/full-text/'+esc(active.pmid)+'">Download full text</a></div>':"");
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
  event.preventDefault();
  const form=event.target, button=form.querySelector("button");
  const body=Object.fromEntries(new FormData(form));
  if(body.active)body.active=body.active==="true";
  if(body.storeRestricted)body.storeRestricted=body.storeRestricted==="true";
  const route=form.dataset.route || "review";
  if(route==="assign-molecule")body.reassign=body.reassign==="on";
  if(route==="review")body.id=active.id;
  if(route==="watches"){
    body.safetyOnly=body.safety==="on";
    body.rows=body.list.split(/\\r?\\n/).map(line=>line.split(/[,;\\t]/).map(x=>x.trim()).filter(Boolean)).filter(n=>n.length).map(n=>({molecule:n[0],synonyms:n.slice(1)}));
  }
  if(route==="/host/change-password"){
    if(body.next!==body.confirm){message("The new passwords don't match.",true);return;}
    delete body.confirm;
  }
  button.disabled=true;message(route==="import"||route==="pull"?"Retrieving PubMed citations…":"Saving…");
  try {const result=await api(route,body);if(route==="review")$("dialog").close();await refresh();
    if(route==="pull"){pullRun=result.id;drawProgress();extractRun(result.id);}
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
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/mcp" && request.method === "POST") return mcp(request,env);
    if (!path.startsWith("/api/")) return new Response(html, { headers: { "Content-Type":"text/html; charset=utf-8" } });
    try { return await api(request, env, path); }
    catch (error) { return json({ error:error.message }, 500); }
  }
};
