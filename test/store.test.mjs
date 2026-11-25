// Tests for the transactional store: migration from the file store, compare-and-swap, append-only audit, versions and rollback, backup and restore.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBucket } from "../server/storage.mjs";
import { SqliteBucket, migrateFileStore, restoreBackup, exportToFileStore } from "../server/sqlitestore.mjs";

const text = async object => object && await object.text();
async function legacyStore() {
  const dir = await mkdtemp(join(tmpdir(), "ls-store-")), files = new FileBucket(dir + "/objects");
  await files.put("bench.json", JSON.stringify({ profiles: [{ email: "boss@example.org", name: "Boss", role: "manager", active: true }], runs: [], settings: {}, watches: [{ portfolio: "P", molecule: "aciclovir", query: "q" }], articles: { 1: { id: "1", title: "A" } }, assignments: [{ id: "a1", pmid: "1", portfolio: "P", reviewer: "x@y.org", status: "Complete", note: "kept" }] }), { httpMetadata: { contentType: "application/json" } });
  await files.put("audit2/2026-11.ndjson", '{"sequence":0}\n{"sequence":1}\n'); await files.put("audit2/head.json", '{"sequence":1}');
  await files.put("ime/current.json", '{"terms":[["1","Seizure","Nervous system disorders",0]]}'); await files.put("evidence/1/pubmed.png", "PNGDATA");
  return { dir, files };
}

test("migration copies state, audit and reference data into SQLite, verifies them, and leaves article files and the old store alone", async () => {
  const { dir, files } = await legacyStore();
  const dry = await migrateFileStore(dir + "/objects", dir + "/state.db", { dryRun: true });
  assert.equal(dry.wouldMigrate, 4); assert.ok(!existsSync(dir + "/state.db"), "a dry run writes nothing");
  const done = await migrateFileStore(dir + "/objects", dir + "/state.db");
  assert.equal(done.ok, true, JSON.stringify(done)); assert.equal(done.migrated, 4); assert.equal(done.skippedFiles, 1); assert.deepEqual(done.errors, []);
  const store = new SqliteBucket(dir + "/state.db", dir + "/objects");
  assert.equal(await text(await store.get("bench.json")), await text(await files.get("bench.json")));
  assert.equal(await text(await store.get("evidence/1/pubmed.png")), "PNGDATA", "article files are still read from the file store");
  assert.equal(JSON.parse(await text(await store.get("bench.json"))).assignments[0].note, "kept", "completed screening decisions survive migration");
  const again = await migrateFileStore(dir + "/objects", dir + "/state.db"); assert.equal(again.ok, true);   // idempotent
  assert.equal(store.check().ok, true); store.close();
  assert.ok(await files.get("bench.json"), "the file store is untouched, so going back is a configuration change");
});

test("SQLite compare-and-swap: two writers with the same etag cannot both win", async () => {
  const { dir } = await legacyStore(); await migrateFileStore(dir + "/objects", dir + "/state.db");
  const store = new SqliteBucket(dir + "/state.db", dir + "/objects"), current = await store.get("bench.json");
  const a = await store.put("bench.json", '{"v":"a"}', { onlyIf: { etagMatches: current.etag } }), b = await store.put("bench.json", '{"v":"b"}', { onlyIf: { etagMatches: current.etag } });
  assert.ok(a); assert.equal(b, null); assert.equal(await text(await store.get("bench.json")), '{"v":"a"}');
  assert.ok(await store.put("new.json", "1", { onlyIf: { etagDoesNotMatch: "*" } })); assert.equal(await store.put("new.json", "2", { onlyIf: { etagDoesNotMatch: "*" } }), null);
  store.close();
});

test("SQLite keeps the audit log append-only and cannot delete protected objects", async () => {
  const { dir } = await legacyStore(); await migrateFileStore(dir + "/objects", dir + "/state.db");
  const store = new SqliteBucket(dir + "/state.db", dir + "/objects");
  await store.put("audit2/2026-11.ndjson", '{"sequence":0}\n{"sequence":1}\n{"sequence":2}\n');
  await assert.rejects(() => store.put("audit2/2026-11.ndjson", '{"sequence":0}\n'), /append-only/);
  await assert.rejects(() => store.put("audit2/2026-11.ndjson", '{"sequence":9}\n{"sequence":1}\n{"sequence":2}\n'), /append-only/);
  await assert.rejects(() => store.put("audit2/head.json", '{"sequence":0}'), /backwards/);
  for (const key of ["bench.json", "audit2/head.json", "ime/current.json"]) await assert.rejects(() => store.delete(key), /cannot be deleted/);
  await store.put("tmp/x", "1"); await store.delete("tmp/x"); assert.equal(await store.get("tmp/x"), null);
  store.close();
});

test("every state write is a version; the state can be rolled back and the rollback is itself a version", async () => {
  const { dir } = await legacyStore(); await migrateFileStore(dir + "/objects", dir + "/state.db");
  const store = new SqliteBucket(dir + "/state.db", dir + "/objects");
  const first = store.versions()[0].version;
  await store.put("bench.json", '{"edit":1}'); await store.put("bench.json", '{"edit":2}');
  assert.equal(store.versions().length, 3);
  await store.rollbackState(first);
  assert.equal(JSON.parse(await text(await store.get("bench.json"))).articles["1"].title, "A");
  assert.equal(store.versions().length, 4); assert.match(store.versions()[0].note, /rollback to version/);
  await assert.rejects(() => store.rollbackState(9999), /No such state version/);
  store.close();
});

test("backup is consistent and checksummed; restore works, rejects a damaged file, and keeps the previous database", async () => {
  const { dir } = await legacyStore(); await migrateFileStore(dir + "/objects", dir + "/state.db");
  const store = new SqliteBucket(dir + "/state.db", dir + "/objects"), saved = store.backup(dir + "/backups/b1.db");
  assert.match(saved.sha256, /^[0-9a-f]{64}$/);
  await store.put("bench.json", '{"after":"backup"}'); store.close();
  restoreBackup(dir + "/backups/b1.db", dir + "/state.db");
  const back = new SqliteBucket(dir + "/state.db", dir + "/objects");
  assert.equal(JSON.parse(await text(await back.get("bench.json"))).articles["1"].title, "A"); assert.equal(back.check().ok, true); back.close();
  const bytes = await readFile(dir + "/backups/b1.db"); bytes[200] ^= 0xff; await (await import("node:fs/promises")).writeFile(dir + "/backups/bad.db", bytes); await (await import("node:fs/promises")).copyFile(dir + "/backups/b1.db.sha256", dir + "/backups/bad.db.sha256");
  assert.throws(() => restoreBackup(dir + "/backups/bad.db", dir + "/state.db"), /checksum/);
});

test("export-files writes the SQLite data back to a file store so the migration can be reversed with current data", async () => {
  const { dir } = await legacyStore(); await migrateFileStore(dir + "/objects", dir + "/state.db");
  const store = new SqliteBucket(dir + "/state.db", dir + "/objects"); await store.put("bench.json", '{"newest":true}'); store.close();
  assert.ok((await exportToFileStore(dir + "/state.db", dir + "/objects")).written >= 4);
  assert.equal(await text(await new FileBucket(dir + "/objects").get("bench.json")), '{"newest":true}');
});

test("the worker runs unchanged on the SQLite store, including the audit chain", async () => {
  const { default: worker } = await import("../worker/index.js");
  const dir = await mkdtemp(join(tmpdir(), "ls-store-w-")), store = new SqliteBucket(dir + "/state.db", dir + "/objects"), env = { BUCKET: store, RUN_TOKEN: "x".repeat(40) };
  await store.put("bench.json", JSON.stringify({ profiles: [{ email: "boss@example.org", name: "Boss", role: "manager", active: true }], runs: [], settings: {}, watches: [], articles: { 1: { id: "1", title: "A" } }, assignments: [] }));
  const state = await (await worker.fetch(new Request("http://localhost/api/state", { headers: { "oai-authenticated-user-email": "boss@example.org" } }), env)).json();
  assert.equal(state.articles["1"].title, "A");
  await Promise.all([1, 2, 3, 4, 5].map(i => worker.audit(env, { by: "system", action: "pull.run", target: "t" + i })));
  const chain = await worker.verifyAuditChain(env); assert.equal(chain.ok, true); assert.equal(chain.entries_checked, 5);
  store.close();
});
