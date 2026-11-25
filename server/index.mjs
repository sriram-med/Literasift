// Node host for worker/index.js: file storage, accounts (invite / sign-in / password reset), and an in-process scheduler.
import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import worker from "../worker/index.js";
import { FileBucket } from "./storage.mjs";
import { addPendingUser, checkPassword, consumeToken, createToken, peekToken, readUsers, removeUser, setPassword, strongEnough, validEmail } from "./accounts.mjs";
import { mailConfigured, sendMail } from "./mail.mjs";
import { makeScreenshotFn } from "./screenshots.mjs";
import { makePdfTextFn } from "./pdftext.mjs";
import { makeOcrFn, looksScanned } from "./ocr.mjs";
import { makeXsdValidator } from "./xsd.mjs";
import { mirrorLibrary } from "./library.mjs";

const e = process.env;
const port = Number(e.PORT || 8787), dataDir = e.DATA_DIR || "/var/lib/literasift";
const secret = e.SESSION_SECRET || "", runToken = e.RUN_TOKEN || "";
if (secret.length < 32 || runToken.length < 32) { console.error("SESSION_SECRET and RUN_TOKEN must each be at least 32 characters."); process.exit(1); }
const secureCookie = e.COOKIE_SECURE !== "false";
const publicUrl = String(e.PUBLIC_URL || "").replace(/\/+$/, "");
// The operational store is SQLite once `node server/store-admin.mjs migrate` has been run; before that the file store is used as before. Article files always stay in the file store.
import { existsSync } from "node:fs";
import { SqliteBucket } from "./sqlitestore.mjs";
const useSqlite = existsSync(dataDir + "/state.db") && e.STORE !== "file";
const bucket = useSqlite ? new SqliteBucket(dataDir + "/state.db", dataDir + "/objects") : new FileBucket(dataDir + "/objects");
console.log("Operational store: " + (useSqlite ? "SQLite (transactional, versioned)" : "file store (run server/store-admin.mjs migrate to move to SQLite)"));
const env = { BUCKET: bucket, RUN_TOKEN: runToken, UNPAYWALL_EMAIL: e.UNPAYWALL_EMAIL, CROSSREF_EMAIL: e.CROSSREF_EMAIL,
  SCREENSHOT_ENDPOINT: e.SCREENSHOT_ENDPOINT, SCREENSHOT_TOKEN: e.SCREENSHOT_TOKEN, HOST_ACCOUNTS: true, AUDIT_ANCHOR_KEY: e.AUDIT_ANCHOR_KEY || createHmac("sha256", secret).update("literasift-audit-anchor").digest("hex"), LIBRARY_PATH: dataDir + "/library" };

const pdfTextFn = await makePdfTextFn(), ocrFn = await makeOcrFn();
// The reader says how it got the text (text layer or OCR) so the evidence record can show it: OCR is used only when the text layer is unusable.
if (pdfTextFn || ocrFn) env.PDF_TEXT_FN = async (bytes, info = {}) => {
  const text = pdfTextFn ? await pdfTextFn(bytes).catch(() => "") : "";
  info.parser = pdfTextFn ? "pdfjs-dist" : "none";
  if (!looksScanned(text)) { info.method = "pdf-text-layer"; info.textLayerUsable = true; return text; }
  if (ocrFn) { const ocr = await ocrFn(bytes).catch(() => ""); if (ocr) { info.method = "ocr"; info.parser = "tesseract + pdftoppm"; info.textLayerUsable = false; return ocr; } }
  info.method = text ? "pdf-text-layer" : "none"; info.textLayerUsable = false;
  return text;
};
console.log(pdfTextFn ? "PDF text: on" : "PDF text: off (run deploy/enable-pdf-text.sh to read PDF full texts)", "|", ocrFn ? "OCR: on" : "OCR: off (run deploy/enable-ocr.sh to read scanned PDFs)");
const xsdValidator = await makeXsdValidator();
if (xsdValidator) env.XSD_VALIDATE = xsdValidator;
console.log(xsdValidator ? "E2B schema validation: on" : "E2B schema validation: off (run deploy/enable-xsd.sh)");
const screenshotFn = await makeScreenshotFn();
if (screenshotFn) env.SCREENSHOT_FN = screenshotFn;
console.log(screenshotFn ? "Local screenshots: on" : "Local screenshots: off (run deploy/enable-screenshots.sh to turn on)");
console.log(mailConfigured(e) ? "Email: on" : "Email: off (invite and reset links are shown to managers instead)", publicUrl ? "" : "| PUBLIC_URL not set: forgot-password emails are disabled");

// The updater writes the deployed commit next to the app, so /healthz shows which version is running.
const deployedVersion = await readFile(new URL("../.version", import.meta.url), "utf8").then(v => v.trim().slice(0, 12), () => "dev");
const sign = value => createHmac("sha256", secret).update(value).digest("base64url");
const makeSession = (email, v) => { const body = Buffer.from(JSON.stringify({ e: email, v: v || 0, x: Date.now() + 7 * 86400000 })).toString("base64url"); return body + "." + sign(body); };
function readSession(req) {
  const raw = /(?:^|;\s*)ls=([^;]+)/.exec(req.headers.cookie || "")?.[1] || "";
  const [body, mac] = raw.split(".");
  if (!body || !mac || mac.length !== sign(body).length || !timingSafeEqual(Buffer.from(mac), Buffer.from(sign(body)))) return null;
  try { const s = JSON.parse(Buffer.from(body, "base64url").toString()); return s.x > Date.now() ? { email: String(s.e).toLowerCase(), v: s.v || 0 } : null; } catch { return null; }
}
const cookieFor = (email, v) => "ls=" + makeSession(email, v) + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800" + (secureCookie ? "; Secure" : "");
const security = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'" };
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const html = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };
const json = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const page = (title, inner) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · LiteraSift</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fafafa;color:#09090b;font:14px/1.5 ui-sans-serif,system-ui,sans-serif}
@media(prefers-color-scheme:dark){body{background:#09090b;color:#fafafa}form,.box{background:#111113!important;border-color:#27272a!important}input{background:#111113!important;border-color:#27272a!important;color:#fafafa}}
form,.box{width:min(380px,92vw);background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:28px;display:grid;gap:14px}h1{margin:0;font-size:20px;letter-spacing:-.02em}p{margin:0;color:#71717a}
label{display:grid;gap:5px;font-weight:500}input{padding:9px 10px;border:1px solid #e4e4e7;border-radius:8px;font:inherit}input:focus{outline:2px solid #0f766e55;border-color:#0f766e}
button{background:#0f766e;color:#fff;border:0;border-radius:8px;padding:10px;font:inherit;font-weight:600;cursor:pointer}.err{color:#dc2626}.ok{color:#15803d}a{color:#0f766e}small{color:#71717a}</style>${inner}</html>`;
const loginPage = (error = "", notice = "") => page("Sign in", `<form method="post" action="/login"><h1>LiteraSift</h1><p>Sign in to continue.</p>${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}${notice ? `<p class="ok" role="status">${esc(notice)}</p>` : ""}
<label>Email<input name="email" type="email" autocomplete="username" required autofocus></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button>Sign in</button><small><a href="/forgot">Forgot your password?</a></small></form>`);
const forgotPage = (message = "") => page("Reset password", `<form method="post" action="/forgot"><h1>Reset your password</h1><p>Enter your account email and we'll send a reset link.</p>${message ? `<p class="ok" role="status">${esc(message)}</p>` : ""}
<label>Email<input name="email" type="email" autocomplete="username" required autofocus></label><button>Send reset link</button><small><a href="/login">Back to sign in</a></small></form>`);
const resetPage = (token, invite, error = "") => page(invite ? "Set your password" : "Choose a new password", `<form method="post" action="/reset"><h1>${invite ? "Welcome to LiteraSift" : "Choose a new password"}</h1><p>${invite ? "Set a password to finish creating your account." : "Pick a new password for your account."} Use at least 12 characters.</p>${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<input type="hidden" name="token" value="${esc(token)}"><label>New password<input name="password" type="password" autocomplete="new-password" minlength="12" required autofocus></label><label>Confirm password<input name="confirm" type="password" autocomplete="new-password" minlength="12" required></label><button>${invite ? "Create account" : "Save password"}</button></form>`);
const invalidLink = () => page("Link expired", `<div class="box"><h1>This link has expired</h1><p>Request a new one with "Forgot your password?", or ask a manager to send you another.</p><a href="/forgot">Reset your password</a></div>`);

const failures = new Map();
const blocked = (key, limit = 8) => (failures.get(key) || []).filter(t => t > Date.now() - 900000).length >= limit;
const fail = key => failures.set(key, [...(failures.get(key) || []).filter(t => t > Date.now() - 900000), Date.now()]);
async function readBody(req, limit = 2_000_000) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error("Request too large."), { status: 413 }); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
const send = (res, status, body, headers = {}) => { res.writeHead(status, { ...security, ...headers }); res.end(body); };
const reply = (res, status, data) => send(res, status, JSON.stringify(data), json);
const record = (by, action, target = "", detail = "") => worker.audit(env, { by, action, target, detail }).catch(() => {});
const asWorker = (email, path, method = "GET", body) => worker.fetch(new Request("http://localhost" + path, { method, headers: { "oai-authenticated-user-email": email, "Content-Type": "application/json" }, body }), env);

async function sendAccountMail(kind, to, link, inviter) {
  const text = kind === "invite"
    ? `${inviter || "A LiteraSift manager"} invited you to LiteraSift, the literature screening workspace.\n\nSet your password and sign in:\n${link}\n\nThis link works once and expires in 7 days.\n`
    : `Someone asked to reset the password for this LiteraSift account.\n\nChoose a new password:\n${link}\n\nThis link works once and expires in 1 hour. If you didn't ask for it, you can ignore this email.\n`;
  await sendMail(e, { to, subject: kind === "invite" ? "You're invited to LiteraSift" : "Reset your LiteraSift password", text });
}

async function handler(req, res) {
  const url = new URL(req.url, "http://localhost"), path = url.pathname;
  if (path === "/healthz") return send(res, 200, "ok " + deployedVersion, { "Content-Type": "text/plain" });
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const form = async () => new URLSearchParams((await readBody(req, 10000)).toString());

  if (path === "/login" && req.method === "GET") return send(res, 200, loginPage("", url.searchParams.get("done") ? "Password saved. Sign in with your new password." : ""), html);
  if (path === "/login" && req.method === "POST") {
    const f = await form(), email = String(f.get("email") || "").trim().toLowerCase(), password = String(f.get("password") || "");
    const keys = ["ip:" + ip, "email:" + email];
    if (keys.some(k => blocked(k))) return send(res, 429, loginPage("Too many attempts. Try again in 15 minutes."), html);
    const users = await readUsers();
    if (!(await checkPassword(Object.hasOwn(users, email) ? users[email] : null, password))) { keys.forEach(fail); await record("anonymous", "login.failed", email.slice(0, 200), "ip " + ip); return send(res, 401, loginPage("Incorrect email or password."), html); }
    await record(email, "login", "", "ip " + ip);
    return send(res, 303, "", { Location: "/", "Set-Cookie": cookieFor(email, users[email].v) });
  }
  if (path === "/logout" && req.method === "POST") { const who = readSession(req)?.email; if (who) await record(who, "logout"); }
  if (path === "/logout" && req.method === "POST") return send(res, 303, "", { Location: "/login", "Set-Cookie": "ls=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" + (secureCookie ? "; Secure" : "") });

  // Password recovery: always answers the same way so it cannot be used to discover which emails have accounts.
  if (path === "/forgot" && req.method === "GET") return send(res, 200, forgotPage(), html);
  if (path === "/forgot" && req.method === "POST") {
    const email = String((await form()).get("email") || "").trim().toLowerCase();
    const keys = ["forgot-ip:" + ip, "forgot-email:" + email];
    const message = mailConfigured(e) && publicUrl ? "If that email has an account, a reset link is on its way. It expires in 1 hour."
      : "Email isn't set up on this server yet. Ask a manager to send you a reset link.";
    if (keys.some(k => blocked(k, 5)) || !validEmail(email)) return send(res, 200, forgotPage(message), html);
    keys.forEach(fail);
    const users = await readUsers();
    if (Object.hasOwn(users, email) && mailConfigured(e) && publicUrl) {
      await record("anonymous", "password.forgot", email, "ip " + ip);
      try { await sendAccountMail("reset", email, publicUrl + "/reset?token=" + await createToken(email, "reset")); } catch (error) { console.error("Reset email failed:", error.message); }
    }
    return send(res, 200, forgotPage(message), html);
  }
  if (path === "/reset" && req.method === "GET") {
    const token = url.searchParams.get("token") || "", t = await peekToken(token);
    return t ? send(res, 200, resetPage(token, t.type === "invite"), html) : send(res, 400, invalidLink(), html);
  }
  if (path === "/reset" && req.method === "POST") {
    const f = await form(), token = String(f.get("token") || ""), password = String(f.get("password") || "");
    if (blocked("reset-ip:" + ip, 20)) return send(res, 429, invalidLink(), html);
    fail("reset-ip:" + ip);
    const t = await peekToken(token);
    if (!t) return send(res, 400, invalidLink(), html);
    if (password !== String(f.get("confirm") || "")) return send(res, 400, resetPage(token, t.type === "invite", "The passwords don't match."), html);
    if (!strongEnough(password, t.email)) return send(res, 400, resetPage(token, t.type === "invite", "Use at least 12 characters, and not your email address."), html);
    const used = await consumeToken(token);
    if (!used) return send(res, 400, invalidLink(), html);
    await setPassword(used.email)(password);
    await record(used.email, used.type === "invite" ? "account.activate" : "password.reset", used.email, "ip " + ip);
    return send(res, 303, "", { Location: "/login?done=1" });
  }

  const bearer = Boolean(req.headers.authorization) && req.headers.authorization === "Bearer " + runToken;
  const users = await readUsers();
  const session = readSession(req);
  const signedIn = Boolean(session) && Object.hasOwn(users, session.email) && Boolean(users[session.email].hash) && (users[session.email].v || 0) === session.v;
  const email = signedIn ? session.email : "";
  const service = bearer && (path === "/api/scheduled" || path === "/mcp");
  if (!signedIn && !service) {
    if (path.startsWith("/api/") || path.startsWith("/host/") || path === "/mcp") return reply(res, 401, { error: "Sign-in required." });
    return send(res, 303, "", { Location: "/login" });
  }
  const sameOrigin = () => { const origin = req.headers.origin; return Boolean(origin) && new URL(origin).host === req.headers.host; };
  if (signedIn && req.method !== "GET" && req.method !== "HEAD" && !sameOrigin()) return reply(res, 403, { error: "Cross-site request blocked." });

  if (path.startsWith("/host/")) {
    if (!signedIn) return reply(res, 401, { error: "Sign-in required." });
    const body = req.method === "POST" ? JSON.parse((await readBody(req, 20000)).toString() || "{}") : {};
    if (path === "/host/change-password" && req.method === "POST") {
      if (blocked("pw-" + email, 5)) return reply(res, 429, { error: "Too many attempts. Try again later." });
      if (!(await checkPassword(users[email], String(body.current || "")))) { fail("pw-" + email); return reply(res, 400, { error: "Your current password is incorrect." }); }
      if (!strongEnough(body.next, email)) return reply(res, 400, { error: "Use at least 12 characters, and not your email address." });
      await setPassword(email)(String(body.next));
      await record(email, "password.change", email);
      return send(res, 200, JSON.stringify({ ok: true }), { ...json, "Set-Cookie": cookieFor(email, (await readUsers())[email].v) });
    }
    const state = await (await asWorker(email, "/api/state")).json();
    if (state.viewer?.role !== "manager") return reply(res, 403, { error: "Manager access required." });
    const origin = req.headers.origin || "", base = publicUrl || origin;
    const deliver = async (kind, to) => {
      const link = base + "/reset?token=" + await createToken(to, kind === "invite" ? "invite" : "reset");
      if (!mailConfigured(e)) return { emailed: false, link };
      try { await sendAccountMail(kind, to, link, state.viewer.name); return { emailed: true }; }
      catch (error) { console.error("Email failed:", error.message); return { emailed: false, link, mailError: "The email could not be sent." }; }
    };
    if (path === "/host/users" && req.method === "GET") {
      const out = {}; for (const [address, u] of Object.entries(users)) out[address] = u.hash ? "active" : "invited";
      return reply(res, 200, { users: out, mail: mailConfigured(e) });
    }
    if (path === "/host/run-tiles" && req.method === "GET") {
      // A PNG sheet of the article tiles for one pull, headed with its search query and date range.
      if (!env.SCREENSHOT_FN?.tiles) return reply(res, 503, { error: "Screenshots are not enabled on this server. Run deploy/enable-screenshots.sh." });
      const run = (state.runs || []).find(r => r.id === url.searchParams.get("run"));
      if (!run) return reply(res, 404, { error: "Pull not found." });
      const articles = (run.ids || []).map(id => state.articles[id]).filter(Boolean);
      const png = await env.SCREENSHOT_FN.tiles(run, articles);
      await record(email, "export.tiles", [run.portfolio, run.molecule].filter(Boolean).join(" · "), run.from + " to " + run.to + ", " + articles.length + " articles");
      return send(res, 200, png, { "Content-Type": "image/png", "Cache-Control": "private, no-store", "Content-Disposition": 'inline; filename="literasift-tiles-' + String(run.molecule || run.portfolio || "pull").replace(/[^A-Za-z0-9_-]+/g, "_") + "-" + run.from + "-to-" + run.to + '.png"' });
    }
    const target = String(body.email || "").trim().toLowerCase();
    if (path === "/host/invite" && req.method === "POST") {
      if (!validEmail(target)) return reply(res, 400, { error: "Enter a valid email address." });
      const profile = await asWorker(email, "/api/profile", "POST", JSON.stringify({ ...body, email: target }));
      if (!profile.ok) return reply(res, profile.status, await profile.json().catch(() => ({ error: "Could not save the profile." })));
      if (Object.hasOwn(users, target) && users[target].hash) return reply(res, 200, { ok: true, existing: true });
      await addPendingUser(target);
      await record(email, "account.invite", target, "role reviewer");
      return reply(res, 200, { ok: true, ...(await deliver("invite", target)) });
    }
    if (path === "/host/set-password" && req.method === "POST") {
      // The manager chooses a starting password; the person can change it afterwards under Account.
      const password = String(body.password || "");
      if (!validEmail(target) || target === email) return reply(res, 400, { error: "Choose another person's email address." });
      if (!(state.profiles || []).some(p => p.email === target)) return reply(res, 404, { error: "Add this person to the team first." });
      if (!strongEnough(password, target)) return reply(res, 400, { error: "Use at least 12 characters, and not the email address." });
      await setPassword(target)(password);
      await record(email, "account.password_set", target, "set by manager; the person can change it");
      return reply(res, 200, { ok: true });
    }
    if (path === "/host/reset-link" && req.method === "POST") {
      if (!Object.hasOwn(users, target) || target === email) return reply(res, 400, { error: "Choose another user's account." });
      await record(email, "account.reset-link", target);
      return reply(res, 200, { ok: true, ...(await deliver(users[target].hash ? "reset" : "invite", target)) });
    }
    if (path === "/host/revoke" && req.method === "POST") {
      if (!Object.hasOwn(users, target) || target === email) return reply(res, 400, { error: "Choose another user's account." });
      await removeUser(target);
      await record(email, "account.revoke", target);
      return reply(res, 200, { ok: true });
    }
    return reply(res, 404, { error: "Route unavailable." });
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (["host", "connection", "content-length", "transfer-encoding", "cookie", "oai-authenticated-user-email", "x-esign-reauth"].includes(name) || Array.isArray(value)) continue;
    headers.set(name, value);
  }
  if (signedIn) headers.set("oai-authenticated-user-email", email);
  let body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req, path === "/api/fulltext-upload" || path === "/api/ime-upload" ? 40_000_000 : 2_000_000);
  // Signing requires the password again. The host checks it, removes it from the request, and tells the app it was verified.
  if (path === "/api/sign" && signedIn && body) {
    let parsed = {}; try { parsed = JSON.parse(body.toString() || "{}"); } catch {}
    const password = String(parsed.password || ""); delete parsed.password;
    if (blocked("esign-" + email, 8)) return reply(res, 429, { error: "Too many attempts. Try again later." });
    if (password && await checkPassword(users[email], password)) headers.set("x-esign-reauth", "1");
    else { fail("esign-" + email); await record(email, "sign.reauth_failed", "", "ip " + ip); return reply(res, 401, { error: "Password incorrect. The record was not signed." }); }
    body = Buffer.from(JSON.stringify(parsed));
  }
  const response = await worker.fetch(new Request(new URL(req.url, "http://localhost"), { method: req.method, headers, body }), env);
  const out = {}; response.headers.forEach((v, k) => { out[k] = v; });
  if (out["content-type"]?.startsWith("text/html")) {
    // Sign out is offered twice: at the bottom of the sidebar, and in the top bar, which stays visible when the sidebar is long or collapsed on a phone.
    const signOut = '<form method="post" action="/logout" style="margin:0"><button class="btn outline sm" type="submit">Sign out</button></form>';
    const doc = (await response.text()).replace('<div class="spacer"></div>', '<div class="spacer"></div><form method="post" action="/logout" style="margin:0 10px 10px"><button class="btn outline sm" style="width:100%" type="submit">Sign out</button></form>')
      .replace('<button class="btn outline icon-btn" id="theme"', '<div style="display:flex;gap:8px;align-items:center">' + signOut + '<button class="btn outline icon-btn" id="theme"').replace('title="Toggle dark mode"></button>', 'title="Toggle dark mode"></button></div>');
    delete out["content-length"];
    return send(res, response.status, doc, out);
  }
  res.writeHead(response.status, { ...security, ...out });
  if (!response.body) return res.end();
  Readable.fromWeb(response.body).pipe(res);
}
http.createServer((req, res) => handler(req, res).catch(error => {
  if (!res.headersSent) send(res, error.status || 500, JSON.stringify({ error: error.status ? error.message : "Server error." }), json);
  else res.end();
  if (!error.status) console.error(error);
})).listen(port, e.HOST || "127.0.0.1", () => console.log("LiteraSift listening on " + (e.HOST || "127.0.0.1") + ":" + port));

// In-process scheduler (replaces the cron-driven run-watchlists.mjs used with Sites).
async function runScheduled() {
  const results = []; let last, previousQueued, stalled = 0;
  for (let call = 0; call < 300; call++) {
    const response = await worker.fetch(new Request("http://localhost/api/scheduled", { method: "POST", headers: { Authorization: "Bearer " + runToken }, body: "{}" }), env);
    last = await response.json();
    if (!response.ok || !Array.isArray(last.results)) throw new Error(last?.error || "Scheduler call failed.");
    results.push(...last.results);
    // Keep going while watchlists or evidence work remain, and stop if the evidence queue stops shrinking (e.g. repeated failures).
    const queued = last.evidence?.queued ?? 0;
    stalled = queued >= (previousQueued ?? Infinity) && !last.results.some(r => !r.error) ? stalled + 1 : 0;
    previousQueued = queued;
    if ((!last.remaining && !queued) || stalled >= 3) break;
  }
  console.log(JSON.stringify({ time: new Date().toISOString(), batches: results.length, failed: results.filter(r => r.error).length, remaining: last?.remaining || 0, evidence: last?.evidence }));
}
// Daily consistent backup of the SQLite store with an integrity check; the newest 14 are kept.
async function backupDaily() {
  if (!useSqlite) return;
  const { readdirSync, unlinkSync } = await import("node:fs");
  const check = bucket.check();
  if (!check.ok) { console.error("SQLITE INTEGRITY CHECK FAILED"); return; }
  const done = bucket.backup(dataDir + "/backups/state-" + new Date().toISOString().slice(0, 10) + ".db");
  const old = readdirSync(dataDir + "/backups").filter(n => /^state-.*\.db$/.test(n)).sort().slice(0, -14);
  for (const name of old) for (const f of [name, name + ".sha256"]) try { unlinkSync(dataDir + "/backups/" + f); } catch { /* already gone */ }
  console.log("Backup written: " + done.destination + " (" + done.bytes + " bytes, " + check.objects + " objects)");
}
setTimeout(() => backupDaily().catch(err => console.error("Backup:", err.message)), 90000);
setInterval(() => backupDaily().catch(err => console.error("Backup:", err.message)), 24 * 3600000);
// Verify the whole audit chain every day and record the result, so tampering is noticed without anyone having to look.
async function verifyChainDaily() {
  const chain = await worker.verifyAuditChain(env);
  await env.BUCKET.put("audit2/verification.json", JSON.stringify({ at: new Date().toISOString(), by: "system:literasift", ok: chain.ok, checked: chain.entries_checked, reason: chain.reason }), { httpMetadata: { contentType: "application/json" } });
  await worker.audit(env, { by: "system", action: chain.ok ? "audit.verified" : "audit.verification_failed", detail: { checked: chain.entries_checked, reason: chain.reason } });
  if (chain.ok) console.log("Audit chain verified: " + chain.entries_checked + " entries"); else console.error("AUDIT CHAIN BROKEN at entry " + chain.first_broken_sequence + ": " + chain.reason);
}
setTimeout(() => verifyChainDaily().catch(err => console.error("Audit verify:", err.message)), 60000);
setInterval(() => verifyChainDaily().catch(err => console.error("Audit verify:", err.message)), 24 * 3600000);
let mirroring = false;
const mirror = () => { if (mirroring) return; mirroring = true; mirrorLibrary(worker, env, dataDir + "/library").then(n => n && console.log("Library folders: copied " + n + " files")).catch(err => console.error("Library mirror:", err.message)).finally(() => { mirroring = false; }); };
setTimeout(mirror, 20000); setInterval(mirror, 15 * 60000);
const everyMs = Math.max(5, Number(e.SCHEDULE_MINUTES || 60)) * 60000;
let running = false;
const tick = () => { if (running) return; running = true; runScheduled().catch(err => console.error("Scheduler:", err.message)).finally(() => { running = false; mirror(); }); };
setTimeout(tick, 120000); setInterval(tick, everyMs);
