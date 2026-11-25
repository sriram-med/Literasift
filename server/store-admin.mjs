#!/usr/bin/env node
// Administration of the transactional store. Usage: node server/store-admin.mjs <command> [arguments]
//   migrate [--dry-run]     copy state, audit chain and reference data from the file store into SQLite (files stay where they are), then verify
//   check                   integrity check and counts
//   backup [file]           consistent backup with checksum (default: <data>/backups/state-<date>.db)
//   restore <file>          restore a backup (the current database is kept beside it)
//   versions                list the saved versions of the state document
//   rollback <version>      write an earlier state version back as the newest one
//   export-files            write the SQLite objects back to the file store (to return to the file store with current data)
import { join } from "node:path";
import { SqliteBucket, migrateFileStore, restoreBackup, exportToFileStore } from "./sqlitestore.mjs";

const dataDir = process.env.DATA_DIR || "/var/lib/literasift", dbPath = join(dataDir, "state.db"), filesDir = join(dataDir, "objects");
const [command, arg] = process.argv.slice(2);
const print = value => console.log(JSON.stringify(value, null, 2));
try {
  if (command === "migrate") print(await migrateFileStore(filesDir, dbPath, { dryRun: process.argv.includes("--dry-run") }));
  else if (command === "check") { const s = new SqliteBucket(dbPath, filesDir); print(s.check()); s.close(); }
  else if (command === "backup") { const s = new SqliteBucket(dbPath, filesDir); print(s.backup(arg || join(dataDir, "backups", "state-" + new Date().toISOString().slice(0, 10) + ".db"))); s.close(); }
  else if (command === "restore") { if (!arg) throw new Error("Give the backup file."); print(restoreBackup(arg, dbPath)); }
  else if (command === "versions") { const s = new SqliteBucket(dbPath, filesDir); print(s.versions()); s.close(); }
  else if (command === "rollback") { const s = new SqliteBucket(dbPath, filesDir); print(await s.rollbackState(arg)); s.close(); }
  else if (command === "export-files") print(await exportToFileStore(dbPath, filesDir));
  else { console.error("Unknown command. See the comment at the top of this file."); process.exit(2); }
} catch (error) { console.error("Error: " + error.message); process.exit(1); }
