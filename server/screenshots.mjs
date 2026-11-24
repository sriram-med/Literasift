// Optional local screenshot capture for PubMed article pages, using Playwright if it is installed
// (see deploy/enable-screenshots.sh). Returns null when Playwright is not available.
const candidates = [process.env.PLAYWRIGHT_MODULE, "/opt/literasift-shots/node_modules/playwright/index.mjs", "playwright"].filter(Boolean);
export async function makeScreenshotFn() {
  let chromium;
  for (const candidate of candidates) {
    try { ({ chromium } = await import(candidate)); if (chromium) break; } catch { /* try the next location */ }
  }
  if (!chromium) return null;
  let browser, queue = Promise.resolve();
  const capture = async url => {
    if (!/^https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/\d{1,9}\/$/.test(url)) throw new Error("Only PubMed article pages can be captured.");
    if (!browser?.isConnected()) browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    try {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(1200);
      return await page.screenshot({ fullPage: true, type: "png", timeout: 30000 });
    } finally { await context.close().catch(() => {}); }
  };
  // One capture at a time with a pause between pages, to stay polite to PubMed.
  return url => (queue = queue.catch(() => {}).then(async () => { const png = await capture(url); await new Promise(r => setTimeout(r, 1500)); return png; }));
}
