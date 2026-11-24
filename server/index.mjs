// Node host for worker/index.js: file storage, cookie sign-in, and an in-process scheduler.
import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import worker from "../worker/index.js";
import { FileBucket } from "./storage.mjs";
import { checkPassword, readUsers } from "./users.mjs";

const e = process.env;
const port = Number(e.PORT || 8787), dataDir = e.DATA_DIR || "/var/lib/literasift";
const secret = e.SESSION_SECRET || "", runToken = e.RUN_TOKEN || "";
if (secret.length < 32 || runToken.length < 32) { console.error("SESSION_SECRET and RUN_TOKEN must each be at least 32 characters."); process.exit(1); }
const secureCookie = e.COOKIE_SECURE !== "false";
const env = { BUCKET: new FileBucket(dataDir + "/objects"), RUN_TOKEN: runToken, UNPAYWALL_EMAIL: e.UNPAYWALL_EMAIL, CROSSREF_EMAIL: e.CROSSREF_EMAIL,
  SCREENSHOT_ENDPOINT: e.SCREENSHOT_ENDPOINT, SCREENSHOT_TOKEN: e.SCREENSHOT_TOKEN };

const sign = value => createHmac("sha256", secret).update(value).digest("base64url");
const makeSession = email => { const body = Buffer.from(JSON.stringify({ e: email, x: Date.now() + 7 * 86400000 })).toString("base64url"); return body + "." + sign(body); };
function sessionEmail(req) {
  const raw = /(?:^|;\s*)ls=([^;]+)/.exec(req.headers.cookie || "")?.[1] || "";
  const [body, mac] = raw.split(".");
  if (!body || !mac || mac.length !== sign(body).length || !timingSafeEqual(Buffer.from(mac), Buffer.from(sign(body)))) return "";
  try { const s = JSON.parse(Buffer.from(body, "base64url").toString()); return s.x > Date.now() ? String(s.e) : ""; } catch { return ""; }
}
const security = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'" };
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const loginPage = (error = "") => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · LiteraSift</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fafafa;color:#09090b;font:14px/1.5 ui-sans-serif,system-ui,sans-serif}
@media(prefers-color-scheme:dark){body{background:#09090b;color:#fafafa}form{background:#111113!important;border-color:#27272a!important}input{background:#111113!important;border-color:#27272a!important;color:#fafafa}}
form{width:min(380px,92vw);background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:28px;display:grid;gap:14px}h1{margin:0;font-size:20px;letter-spacing:-.02em}p{margin:0;color:#71717a}
label{display:grid;gap:5px;font-weight:500}input{padding:9px 10px;border:1px solid #e4e4e7;border-radius:8px;font:inherit}input:focus{outline:2px solid #0f766e55;border-color:#0f766e}
button{background:#0f766e;color:#fff;border:0;border-radius:8px;padding:10px;font:inherit;font-weight:600;cursor:pointer}.err{color:#dc2626}</style>
<form method="post" action="/login"><h1>LiteraSift</h1><p>Sign in to continue.</p>${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<label>Email<input name="email" type="email" autocomplete="username" required autofocus></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button>Sign in</button></form></html>`;

const failures = new Map();
const blocked = key => (failures.get(key) || []).filter(t => t > Date.now() - 900000).length >= 8;
const fail = key => failures.set(key, [...(failures.get(key) || []).filter(t => t > Date.now() - 900000), Date.now()]);
async function readBody(req, limit = 2_000_000) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error("Request too large."), { status: 413 }); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function send(res, status, body, headers = {}) { res.writeHead(status, { ...security, ...headers }); res.end(body); }

async function handler(req, res) {
  const url = new URL(req.url, "http://localhost"), path = url.pathname;
  if (path === "/healthz") return send(res, 200, "ok", { "Content-Type": "text/plain" });
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if (path === "/login" && req.method === "GET") return send(res, 200, loginPage(), { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  if (path === "/login" && req.method === "POST") {
    const form = new URLSearchParams((await readBody(req, 10000)).toString());
    const email = String(form.get("email") || "").trim().toLowerCase(), password = String(form.get("password") || "");
    const keys = ["ip:" + ip, "email:" + email];
    if (keys.some(blocked)) return send(res, 429, loginPage("Too many attempts. Try again in 15 minutes."), { "Content-Type": "text/html; charset=utf-8" });
    const users = await readUsers();
    if (!(await checkPassword(Object.hasOwn(users, email) ? users[email] : null, password))) {
      keys.forEach(fail);
      return send(res, 401, loginPage("Incorrect email or password."), { "Content-Type": "text/html; charset=utf-8" });
    }
    return send(res, 303, "", { Location: "/", "Set-Cookie": "ls=" + makeSession(email) + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800" + (secureCookie ? "; Secure" : "") });
  }
  if (path === "/logout" && req.method === "POST") return send(res, 303, "", { Location: "/login", "Set-Cookie": "ls=; HttpOnly; Path=/; Max-Age=0" });

  const bearer = Boolean(req.headers.authorization) && req.headers.authorization === "Bearer " + runToken;
  const users = await readUsers();
  const email = sessionEmail(req).toLowerCase();
  const signedIn = Boolean(email) && Object.hasOwn(users, email);
  const service = bearer && (path === "/api/scheduled" || path === "/mcp");
  if (!signedIn && !service) {
    if (path.startsWith("/api/") || path === "/mcp") return send(res, 401, JSON.stringify({ error: "Sign-in required." }), { "Content-Type": "application/json" });
    return send(res, 303, "", { Location: "/login" });
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (["host", "connection", "content-length", "transfer-encoding", "cookie", "oai-authenticated-user-email"].includes(name) || Array.isArray(value)) continue;
    headers.set(name, value);
  }
  if (signedIn) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      const origin = req.headers.origin;
      if (!origin || new URL(origin).host !== req.headers.host) return send(res, 403, JSON.stringify({ error: "Cross-site request blocked." }), { "Content-Type": "application/json" });
    }
    headers.set("oai-authenticated-user-email", email);
  }
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
  const response = await worker.fetch(new Request(new URL(req.url, "http://localhost"), { method: req.method, headers, body }), env);
  const out = {}; response.headers.forEach((v, k) => { out[k] = v; });
  if (out["content-type"]?.startsWith("text/html")) {
    const page = (await response.text()).replace('<div class="spacer"></div>', '<div class="spacer"></div><form method="post" action="/logout" style="margin:0 10px 10px"><button class="btn outline sm" style="width:100%">Sign out</button></form>');
    delete out["content-length"];
    return send(res, response.status, page, out);
  }
  res.writeHead(response.status, { ...security, ...out });
  if (!response.body) return res.end();
  Readable.fromWeb(response.body).pipe(res);
}
http.createServer((req, res) => handler(req, res).catch(error => {
  if (!res.headersSent) send(res, error.status || 500, JSON.stringify({ error: error.status ? error.message : "Server error." }), { "Content-Type": "application/json" });
  else res.end();
  if (!error.status) console.error(error);
})).listen(port, e.HOST || "127.0.0.1", () => console.log("LiteraSift listening on " + (e.HOST || "127.0.0.1") + ":" + port));

// In-process scheduler (replaces the cron-driven run-watchlists.mjs used with Sites).
async function runScheduled() {
  const results = []; let last;
  for (let call = 0; call < 300; call++) {
    const response = await worker.fetch(new Request("http://localhost/api/scheduled", { method: "POST", headers: { Authorization: "Bearer " + runToken }, body: "{}" }), env);
    last = await response.json();
    if (!response.ok || !Array.isArray(last.results)) throw new Error(last?.error || "Scheduler call failed.");
    results.push(...last.results);
    const progressed = last.results.some(r => !r.error) || last.evidence?.processed > 0;
    if ((!last.remaining && !last.evidence?.unattempted) || !progressed) break;
  }
  console.log(JSON.stringify({ time: new Date().toISOString(), batches: results.length, failed: results.filter(r => r.error).length, remaining: last?.remaining || 0, evidence: last?.evidence }));
}
const everyMs = Math.max(5, Number(e.SCHEDULE_MINUTES || 60)) * 60000;
let running = false;
const tick = () => { if (running) return; running = true; runScheduled().catch(err => console.error("Scheduler:", err.message)).finally(() => { running = false; }); };
setTimeout(tick, 120000); setInterval(tick, everyMs);
