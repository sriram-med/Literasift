// Keeps a readable folder tree on disk: <DATA_DIR>/library/<Molecule>/<from>_to_<to>/ with each article's stored files and an _index.csv.
// Files in the object store are never moved; this only copies missing ones, so it is safe to run repeatedly.
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const exists = async path => { try { await stat(path); return true; } catch { return false; } };
const csv = rows => rows.map(r => r.map(v => '"' + String(v ?? "").replace(/^[=+@\-]/, "'$&").replaceAll('"', '""') + '"').join(",")).join("\r\n");

export async function mirrorLibrary(worker, env, root) {
  const bench = await env.BUCKET.get("bench.json");
  if (!bench) return 0;
  const state = await bench.json(), folders = new Map();
  for (const entry of worker.libraryLayout(state)) (folders.get(entry.folder) || folders.set(entry.folder, []).get(entry.folder)).push(entry.pmid);
  let written = 0;
  for (const [folder, ids] of folders) {
    const dir = join(root, ...folder.split("/"));
    await mkdir(dir, { recursive: true });
    const rows = [["Source", "PMID", "Title", "DOI", "Full text", "Full-text source", "Licence", "Access", "Retraction check"]];
    for (const id of ids) {
      const a = state.articles[id];
      if (!a) continue;
      const ext = /\.(\w+)$/.exec(a.fullTextKey || "")?.[1] || "bin";
      for (const [key, name] of [[a.fullTextKey, `PMID_${id}.${ext}`], [a.fullTextTextKey, `PMID_${id}_text.txt`], [a.screenshotKey, `PMID_${id}_record.png`]]) {
        if (!key) continue;
        const target = join(dir, name);
        if (await exists(target)) continue;
        const object = await env.BUCKET.get(key);
        if (!object) continue;
        await writeFile(target, Buffer.from(await object.arrayBuffer()));
        written++;
      }
      rows.push([a.source || "PubMed", id, a.title, a.doi, a.fullTextStatus || "", a.fullTextOrigin || "", a.fullTextLicense || "", a.oaStatus || "", a.retractionStatus || ""]);
    }
    await writeFile(join(dir, "_index.csv"), csv(rows));
  }
  return written;
}
