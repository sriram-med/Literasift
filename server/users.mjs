// Password store for the VPS deployment. Usage: node server/users.mjs set|remove|list [email]
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const dataDir = () => process.env.DATA_DIR || "/var/lib/literasift";
const file = () => join(dataDir(), "users.json");
const kdf = (password, salt) => new Promise((ok, fail) => scrypt(password, salt, 64, { N: 16384 }, (e, key) => e ? fail(e) : ok(key)));
export async function readUsers() { try { return JSON.parse(await readFile(file(), "utf8")); } catch { return {}; } }
export async function saveUsers(users) {
  await mkdir(dataDir(), { recursive: true });
  await writeFile(file() + ".tmp", JSON.stringify(users), { mode: 0o600 });
  await rename(file() + ".tmp", file());
}
export async function hashPassword(password) {
  const salt = randomBytes(16);
  return { salt: salt.toString("hex"), hash: (await kdf(password, salt)).toString("hex") };
}
export async function checkPassword(user, password) {
  if (!user?.hash) user = null;
  const salt = user ? Buffer.from(user.salt, "hex") : Buffer.alloc(16);
  const expected = Buffer.from(user?.hash || "0".repeat(128), "hex");
  const actual = await kdf(password, salt);
  return Boolean(user) && actual.length === expected.length && timingSafeEqual(actual, expected);
}
if (process.argv[1]?.endsWith("users.mjs")) {
  const [command, rawEmail] = process.argv.slice(2);
  const email = String(rawEmail || "").trim().toLowerCase();
  const users = await readUsers();
  if (command === "list") console.log(Object.keys(users).join("\n") || "(no users)");
  else if (command === "remove" && users[email]) { delete users[email]; await saveUsers(users); console.log("Removed " + email); }
  else if (command === "set" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    let password = process.env.LITERASIFT_PASSWORD;
    if (!password) { const rl = createInterface({ input: process.stdin, output: process.stdout }); password = await rl.question("Password for " + email + " (min 12 chars): "); rl.close(); }
    if (password.length < 12) { console.error("Password must be at least 12 characters."); process.exit(1); }
    users[email] = { ...users[email], pending: undefined, ...(await hashPassword(password)), v: (users[email]?.v || 0) + 1 }; await saveUsers(users); console.log("Saved " + email);
  } else { console.error("Usage: users.mjs set <email> | remove <email> | list"); process.exit(1); }
}
