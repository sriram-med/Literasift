// Keeps a readable folder tree on disk: <DATA_DIR>/library/<Molecule>/<from>_to_<to>/ with each article's stored files and an _index.csv.
// Files in the object store are never moved; this only copies missing ones, so it is safe to run repeatedly.
import { mkdir, readdir, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const exists = async path => { try { await stat(path); return true; } catch { return false; } };
const csv = rows => rows.map(r => r.map(v => '"' + String(v ?? "").replace(/^[=+@\-]/, "'$&").replaceAll('"', '""') + '"').join(",")).join("\r\n");

export async function mirrorLibrary(worker, env, root) {
  const bench = await env.BUCKET.get("bench.json");
  if (!bench) return 0;
  const state = await bench.json(), folders = new Map();
  for (const entry of worker.libraryLayout(state)) (folders.get(entry.folder) || folders.set(entry.folder, []).get(entry.folder)).push(entry);
  let written = 0;
  const expected = new Set();
  for (const [folder, entries] of folders) {
    const dir = join(root, ...folder.split("/"));
    expected.add(dir);
    await mkdir(dir, { recursive: true });
    const rows = [["No.", "Source", "PMID", "Title", "DOI", "Full text", "Full-text source", "Licence", "Access", "Retraction check"]];
    for (const entry of entries) {
      const id = entry.pmid, tag = String(entry.n).padStart(entry.width, "0") + "_", a = state.articles[id];
      if (!a) continue;
      const ext = /\.(\w+)$/.exec(a.fullTextKey || "")?.[1] || "bin";
      for (const [key, name] of [[a.fullTextKey, `${tag}PMID_${id}.${ext}`], [a.fullTextTextKey, `${tag}PMID_${id}_text.txt`], [a.screenshotKey, `${tag}PMID_${id}_record.png`]]) {
        if (!key) continue;
        const target = join(dir, name), older = join(dir, name.slice(tag.length));
        // A record card is written again when the stored snapshot is newer than the copy on disk (the card layout changed, or it was re-taken).
        if (await exists(target)) { if (key !== a.screenshotKey || !a.screenshotAt || (await stat(target)).mtimeMs >= Date.parse(a.screenshotAt)) continue; const fresh = await env.BUCKET.get(key); if (fresh) { await writeFile(target, Buffer.from(await fresh.arrayBuffer())); written++; } continue; }
        if (await exists(older)) { await rename(older, target); continue; } // files from before numbering are renamed, not duplicated
        const object = await env.BUCKET.get(key);
        if (!object) continue;
        await writeFile(target, Buffer.from(await object.arrayBuffer()));
        written++;
      }
      rows.push([tag.slice(0, -1), a.source || "PubMed", id, a.title, a.doi, a.fullTextStatus || "", a.fullTextOrigin || "", a.fullTextLicense || "", a.oaStatus || "", a.retractionStatus || ""]);
    }
    await writeFile(join(dir, "_index.csv"), csv(rows));
  }
  // Articles deleted from the library are removed from the folder tree too.
  const walk = async (dir, depth) => {
    let names; try { names = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of names) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && depth < 4) {
        await walk(full, depth + 1);
        // A folder left holding only its index, whose articles are all gone, is removed.
        const rest = await readdir(full).catch(() => ["x"]);
        if (!expected.has(full) && rest.every(n => n === "_index.csv")) { await unlink(join(full, "_index.csv")).catch(() => {}); }
        await rmdir(full).catch(() => {});
      }
      else if (entry.isFile()) { const m = /PMID_([A-Za-z0-9-]+?)(?:_text|_record)?\.[A-Za-z]+$/.exec(entry.name); if (m && !state.articles[m[1]]) await unlink(full).catch(() => {}); }
    }
  };
  await walk(root, 0);
  return written;
}
