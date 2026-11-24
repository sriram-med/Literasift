// Optional local screenshots with Playwright (see deploy/enable-screenshots.sh). Returns null when Playwright is not installed.
// Each snapshot is a "record card" rendered from the data we already hold. The live PubMed web pages are deliberately NOT scraped:
// NCBI directs automated access to the E-utilities API and blocks automated browsing of its web interface.
const candidates = [process.env.PLAYWRIGHT_MODULE, "/opt/literasift-shots/node_modules/playwright/index.mjs", "playwright"].filter(Boolean);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function recordCardHtml(a) {
  const chips = list => (list || []).map(t => `<span class="chip">${esc(t)}</span>`).join("");
  const row = (k, v) => v ? `<div class="row"><b>${esc(k)}</b><span>${esc(v)}</span></div>` : "";
  return `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;padding:36px 44px;width:1000px;background:#fff;color:#18181b;font:16px/1.55 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif}
.brand{color:#0f766e;font-weight:700;letter-spacing:.02em;font-size:13px;text-transform:uppercase;border-bottom:2px solid #0f766e;padding-bottom:8px;margin-bottom:18px;display:flex;justify-content:space-between}
h1{font-size:26px;line-height:1.25;margin:0 0 10px;letter-spacing:-.01em}.meta{color:#52525b;margin-bottom:14px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#71717a;margin:22px 0 6px}.abs{white-space:pre-wrap}
.row{display:flex;gap:12px;padding:4px 0;border-top:1px solid #f0f0f2}.row b{width:170px;flex:none;color:#52525b;font-weight:600}
.chip{display:inline-block;background:#f4f4f5;border:1px solid #e4e4e7;border-radius:99px;padding:1px 10px;margin:0 6px 6px 0;font-size:13px}</style>
<div class="brand"><span>LiteraSift · PubMed record</span><span>PMID ${esc(a.id)}</span></div>
<h1>${esc(a.title)}</h1>
<div class="meta">${esc([a.journal, a.date].filter(Boolean).join(" · "))}${(a.authors || []).length ? "<br>" + esc(a.authors.join(", ")) : ""}</div>
<h2>Abstract</h2><div class="abs">${a.abstract ? esc(a.abstract.slice(0, 4000)) : "<i>No abstract available.</i>"}</div>
${(a.meshTerms || []).length ? `<h2>MeSH terms</h2><div>${chips(a.meshTerms)}</div>` : ""}
${(a.keywords || []).length ? `<h2>Keywords</h2><div>${chips(a.keywords)}</div>` : ""}
<h2>Record</h2>${row("DOI", a.doi)}${row("PubMed", a.url)}${row("Retraction check", a.retractionStatus)}${row("Access", a.oaStatus)}${row("Full text", a.fullTextStatus)}${row("Cited by", a.citedBy)}${row("Captured", new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC")}`;
}

export async function makeScreenshotFn() {
  let chromium;
  for (const candidate of candidates) {
    try { ({ chromium } = await import(candidate)); if (chromium) break; } catch { /* try the next location */ }
  }
  if (!chromium) return null;
  let browser, queue = Promise.resolve();
  const capture = async article => {
    if (!browser?.isConnected()) browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.setContent(recordCardHtml(article), { waitUntil: "load" });
      return { bytes: await page.screenshot({ fullPage: true, type: "png", timeout: 30000 }), kind: "record" };
    } finally { await context.close().catch(() => {}); }
  };
  // One capture at a time.
  return article => (queue = queue.catch(() => {}).then(() => capture(article)));
}
