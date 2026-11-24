// Invite / password-reset tokens (stored hashed, single use) and account helpers for the VPS host.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkPassword, hashPassword, readUsers, saveUsers } from "./users.mjs";

const dir = () => process.env.DATA_DIR || "/var/lib/literasift";
const tokenFile = () => join(dir(), "tokens.json");
let lock = Promise.resolve();
const serial = fn => { const run = lock.then(fn, fn); lock = run.catch(() => {}); return run; };
const digest = raw => createHash("sha256").update(raw).digest("hex");
async function readTokens() { try { return JSON.parse(await readFile(tokenFile(), "utf8")); } catch { return {}; } }
async function saveTokens(tokens) {
  await mkdir(dir(), { recursive: true });
  await writeFile(tokenFile() + ".tmp", JSON.stringify(tokens), { mode: 0o600 });
  await rename(tokenFile() + ".tmp", tokenFile());
}
export const ttl = { invite: 7 * 86400000, reset: 3600000 };
export const validEmail = email => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && email.length <= 200;
export const strongEnough = (password, email) => typeof password === "string" && password.length >= 12 && password.length <= 200 && password.toLowerCase() !== String(email).toLowerCase();

// Creating a token replaces any earlier one of the same kind for that email.
export const createToken = (email, type) => serial(async () => {
  const tokens = await readTokens(), now = Date.now(), raw = randomBytes(32).toString("base64url");
  for (const [key, t] of Object.entries(tokens)) if (t.exp < now || (t.email === email && t.type === type)) delete tokens[key];
  tokens[digest(raw)] = { email, type, exp: now + ttl[type] };
  await saveTokens(tokens);
  return raw;
});
export const peekToken = async raw => { const t = (await readTokens())[digest(String(raw))]; return t && t.exp > Date.now() ? t : null; };
export const consumeToken = raw => serial(async () => {
  const tokens = await readTokens(), key = digest(String(raw)), t = tokens[key];
  if (!t || t.exp < Date.now()) return null;
  delete tokens[key]; await saveTokens(tokens);
  return t;
});

export const setPassword = email => async password => serial(async () => {
  const users = await readUsers(), existing = users[email] || {};
  users[email] = { ...existing, pending: undefined, ...(await hashPassword(password)), v: (existing.v || 0) + 1 };
  await saveUsers(users);
});
export const addPendingUser = email => serial(async () => {
  const users = await readUsers();
  if (!users[email]) { users[email] = { pending: true, v: 0 }; await saveUsers(users); }
});
export const removeUser = email => serial(async () => {
  const users = await readUsers();
  if (users[email]) { delete users[email]; await saveUsers(users); }
});
export { checkPassword, readUsers };
