import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { chromium } from "playwright";

const digest = value => createHash("sha256").update(value).digest();
const secret = process.env.SCREENSHOT_TOKEN;
if (!secret || secret.length < 24) throw new Error("Set a SCREENSHOT_TOKEN with at least 24 characters.");
const expected = digest(secret);
const pubmed = /^https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/([1-9][0-9]{0,11})\/$/;
const allowed = new Set(["https://pubmed.ncbi.nlm.nih.gov", "https://cdn.ncbi.nlm.nih.gov"]);
let browser;
let busy = false;

async function readBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 4096) return null;
  }
  try { return JSON.parse(body); } catch { return null; }
}

createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const fail = (status, message) => response.writeHead(status, {
    "Content-Type": "text/plain", "Cache-Control": "no-store"
  }).end(message);
  if (request.method === "GET" && url.pathname === "/health") return fail(200, "OK");
  if (request.method !== "POST" || url.pathname !== "/screenshot") return fail(404, "Not found");
  const token = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1] || "";
  if (!timingSafeEqual(expected, digest(token))) return fail(401, "Unauthorized");
  if (busy) return fail(503, "Capture worker is busy");
  busy = true;
  let context;
  try {
    const body = await readBody(request);
    const match = typeof body?.url === "string" && pubmed.exec(body.url);
    if (!match) return fail(400, "A canonical PubMed article URL is required");
    if (!browser?.isConnected()) browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
    await context.route("**/*", route => {
      const target = new URL(route.request().url());
      const navigation = route.request().isNavigationRequest();
      return (navigation ? target.href === body.url : allowed.has(target.origin)) ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    const result = await page.goto(body.url, { waitUntil: "domcontentloaded", timeout: 12000 });
    if (!result?.ok() || page.url() !== body.url) return fail(502, "PubMed page unavailable");
    await page.locator('meta[name="citation_pmid"][content="' + match[1] + '"]').waitFor({
      state: "attached", timeout: 5000
    });
    const image = await page.screenshot({ fullPage: true, type: "png", timeout: 9000 });
    response.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" }).end(image);
  } catch {
    if (!response.headersSent) fail(502, "Unable to capture PubMed page");
  } finally {
    await context?.close().catch(() => {});
    busy = false;
  }
}).listen(3000, "0.0.0.0");
