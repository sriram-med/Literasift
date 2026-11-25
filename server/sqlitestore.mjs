// Transactional operational store for the Node host: SQLite (node:sqlite, write-ahead log) for state, audit chain, reference data and job records;
// article files (keys under evidence/) stay in the file-backed object store, the counterpart of the R2 bucket. Same get/put/delete interface as FileBucket,
// so worker/index.js is unchanged. Every write of the state document is also kept in a version history, so the state can be rolled back to an earlier version.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, renameSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { FileBucket } from "./storage.mjs";

const STATE_KEY = "bench.json", KEEP_VERSIONS = 200;
const sha = data => createHash("sha256").update(data).digest("hex");
const isFileKey = key => String(key).startsWith("evidence/");

export class SqliteBucket {
  constructor(dbPath, filesDir) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.path = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 10000;
      CREATE TABLE IF NOT EXISTS objects (key TEXT PRIMARY KEY, etag TEXT NOT NULL, size INTEGER NOT NULL, content_type TEXT, data BLOB NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state_history (version INTEGER PRIMARY KEY AUTOINCREMENT, etag TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL, at TEXT NOT NULL, note TEXT);
      CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT);`);
    this.files = filesDir ? new FileBucket(filesDir) : null;
  }
  close() { this.db.close(); }
  #row(key) { return this.db.prepare("SELECT key, etag, size, content_type, data FROM objects WHERE key = ?").get(key); }
  async get(key) {
    if (isFileKey(key) && this.files) return this.files.get(key);
    const row = this.#row(String(key));
    if (!row) return null;
    const data = Buffer.from(row.data), type = row.content_type;
    return { key, etag: row.etag, size: row.size, httpMetadata: type ? { contentType: type } : {},
      get body() { return Readable.toWeb(Readable.from([data])); },
      json: async () => JSON.parse(data.toString("utf8")), text: async () => data.toString("utf8"),
      arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      writeHttpMetadata(headers) { if (type) headers.set("Content-Type", type); } };
  }
  async put(key, value, options = {}) {
    if (isFileKey(key) && this.files) return this.files.put(key, value, options);
    const data = typeof value === "string" ? Buffer.from(value) : Buffer.from(await new Response(value).arrayBuffer());
    const db = this.db, cond = options.onlyIf;
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#row(String(key));
      if (cond?.etagMatches && current?.etag !== cond.etagMatches) { db.exec("ROLLBACK"); return null; }
      if (cond?.etagDoesNotMatch === "*" && current) { db.exec("ROLLBACK"); return null; }
      if (cond?.etagDoesNotMatch && cond.etagDoesNotMatch !== "*" && current?.etag === cond.etagDoesNotMatch) { db.exec("ROLLBACK"); return null; }
      // The audit log may only grow by appending and its head may only move forward, whatever the application code does.
      if (current && key.startsWith("audit2/") && key.endsWith(".ndjson")) {
        const old = Buffer.from(current.data);
        if (data.length < old.length || !data.subarray(0, old.length).equals(old)) throw new Error("audit log is append-only");
      }
      if (current && key === "audit2/head.json" && !(JSON.parse(data.toString()).sequence >= JSON.parse(Buffer.from(current.data).toString()).sequence)) throw new Error("audit head cannot move backwards");
      const etag = sha(data).slice(0, 32), at = new Date().toISOString();
      db.prepare("INSERT INTO objects (key, etag, size, content_type, data, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET etag = excluded.etag, size = excluded.size, content_type = excluded.content_type, data = excluded.data, updated_at = excluded.updated_at")
        .run(String(key), etag, data.length, options.httpMetadata?.contentType || null, data, at);
      if (key === STATE_KEY) {
        db.prepare("INSERT INTO state_history (etag, size, data, at, note) VALUES (?, ?, ?, ?, ?)").run(etag, data.length, data, at, options.note || null);
        db.prepare("DELETE FROM state_history WHERE version <= (SELECT MAX(version) FROM state_history) - ?").run(KEEP_VERSIONS);
      }
      db.exec("COMMIT");
      return { key, etag };
    } catch (error) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
  }
  // Removes one object. The audit log, the state document and reference data can never be deleted this way.
  async delete(key) {
    if (isFileKey(key) && this.files) return this.files.delete(key);
    if (/^(audit2?\/|bench\.json$|ime\/|users)/.test(String(key))) throw new Error("This object cannot be deleted.");
    this.db.prepare("DELETE FROM objects WHERE key = ?").run(String(key));
  }
  async list(prefix = "") { return this.db.prepare("SELECT key, etag, size FROM objects WHERE key LIKE ? ORDER BY key").all(prefix.replace(/[%_]/g, "\\$&") + "%").map(r => ({ key: r.key, etag: r.etag, size: r.size })); }
  versions() { return this.db.prepare("SELECT version, etag, size, at, note FROM state_history ORDER BY version DESC LIMIT 100").all(); }
  // Rolls the state document back to an earlier version. The rollback is itself a new version, so nothing is lost and it can be undone.
  async rollbackState(version, note = "rollback") {
    const row = this.db.prepare("SELECT data, etag FROM state_history WHERE version = ?").get(Number(version));
    if (!row) throw new Error("No such state version.");
    return this.put(STATE_KEY, Buffer.from(row.data), { httpMetadata: { contentType: "application/json" }, note: note + " to version " + version });
  }
  // Consistent online backup (VACUUM INTO) with a checksum next to it.
  backup(destination) {
    mkdirSync(dirname(destination), { recursive: true });
    if (existsSync(destination)) unlinkSync(destination);
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.prepare("VACUUM INTO ?").run(destination);
    const digest = sha(readFileSync(destination));
    writeFileSync(destination + ".sha256", digest + "\n");
    return { destination, sha256: digest, bytes: statSync(destination).size };
  }
  // Integrity check used by backups, migrations and the nightly job.
  check() {
    const quick = this.db.prepare("PRAGMA integrity_check").get();
    return { ok: Object.values(quick)[0] === "ok", objects: this.db.prepare("SELECT COUNT(*) AS n FROM objects").get().n, versions: this.db.prepare("SELECT COUNT(*) AS n FROM state_history").get().n };
  }
}

// Restores a backup file over a database path after checking its checksum. The previous database is kept beside it, so a restore can be undone.
export function restoreBackup(backupFile, dbPath) {
  const expected = existsSync(backupFile + ".sha256") ? readFileSync(backupFile + ".sha256", "utf8").trim() : "";
  if (expected && sha(readFileSync(backupFile)) !== expected) throw new Error("The backup does not match its checksum.");
  for (const suffix of ["-wal", "-shm"]) if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  if (existsSync(dbPath)) renameSync(dbPath, dbPath + ".before-restore-" + Date.now());
  copyFileSync(backupFile, dbPath);
  return { restored: dbPath };
}

// Copies every non-file object of a file-backed store (state, audit chain, reference data) into SQLite. The file store is left untouched, so going back is a configuration change.
export async function migrateFileStore(filesDir, dbPath, { dryRun = false } = {}) {
  const source = new FileBucket(filesDir), found = [], report = { migrated: 0, skippedFiles: 0, bytes: 0, errors: [] };
  const names = existsSync(filesDir) ? readdirSync(filesDir).filter(n => n.endsWith(".meta")) : [];
  for (const meta of names) {
    let info; try { info = JSON.parse(readFileSync(join(filesDir, meta), "utf8")); } catch { report.errors.push("unreadable " + meta); continue; }
    if (!info.key) continue;
    if (isFileKey(info.key)) { report.skippedFiles++; continue; }
    found.push(info);
  }
  if (dryRun) return { ...report, wouldMigrate: found.length, keys: found.map(i => i.key) };
  const target = new SqliteBucket(dbPath, null);
  // Audit month files are written before the head so the append-only guard sees a consistent chain.
  for (const info of found.sort((a, b) => a.key.localeCompare(b.key))) {
    const object = await source.get(info.key), bytes = Buffer.from(await object.arrayBuffer());
    const existing = await target.get(info.key);
    if (existing && existing.etag === sha(bytes).slice(0, 32)) { report.migrated++; continue; }
    await target.put(info.key, bytes, { httpMetadata: info.httpMetadata || {}, note: "migrated from the file store" });
    report.migrated++; report.bytes += bytes.length;
  }
  // Verify every object byte for byte before the migration is called done.
  for (const info of found) {
    const a = Buffer.from(await (await source.get(info.key)).arrayBuffer()), b = Buffer.from(await (await target.get(info.key)).arrayBuffer());
    if (!a.equals(b)) report.errors.push("mismatch in " + info.key);
  }
  const integrity = target.check(); target.close();
  return { ...report, integrity, ok: report.errors.length === 0 && integrity.ok };
}

// The reverse of the migration: writes the SQLite objects back as a file store (used to roll back to the file store with the newest data).
export async function exportToFileStore(dbPath, filesDir) {
  const from = new SqliteBucket(dbPath, null), to = new FileBucket(filesDir), keys = await from.list(""), written = [];
  for (const { key } of keys) {
    const object = await from.get(key), bytes = Buffer.from(await object.arrayBuffer()), current = await to.get(key);
    if (key.startsWith("audit2/") && current) { const old = Buffer.from(await current.arrayBuffer()); if (bytes.length < old.length) continue; }
    await to.put(key, bytes, { httpMetadata: object.httpMetadata }); written.push(key);
  }
  from.close();
  return { written: written.length };
}
