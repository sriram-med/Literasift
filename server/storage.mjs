// File-backed stand-in for the R2 bucket binding used by worker/index.js (get/put with conditional writes).
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Readable } from "node:stream";

export class FileBucket {
  #lock = Promise.resolve();
  constructor(dir) { this.dir = dir; }
  #name(key) {
    if (typeof key !== "string" || !key || key.length > 500) throw new Error("Invalid object key.");
    return createHash("sha256").update(key).digest("hex");
  }
  async #meta(name) {
    try { return JSON.parse(await readFile(join(this.dir, name + ".meta"), "utf8")); } catch { return null; }
  }
  async get(key) {
    const name = this.#name(key), meta = await this.#meta(name), file = join(this.dir, name);
    if (!meta) return null;
    return {
      key, etag: meta.etag, size: meta.size, httpMetadata: meta.httpMetadata || {},
      get body() { return Readable.toWeb(createReadStream(file)); },
      json: async () => JSON.parse(await readFile(file, "utf8")),
      text: () => readFile(file, "utf8"),
      arrayBuffer: async () => { const b = await readFile(file); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
      writeHttpMetadata(headers) { if (meta.httpMetadata?.contentType) headers.set("Content-Type", meta.httpMetadata.contentType); },
    };
  }
  put(key, value, options = {}) {
    const run = async () => {
      const name = this.#name(key), current = await this.#meta(name), cond = options.onlyIf;
      if (cond?.etagMatches && current?.etag !== cond.etagMatches) return null;
      if (cond?.etagDoesNotMatch === "*" && current) return null;
      if (cond?.etagDoesNotMatch && cond.etagDoesNotMatch !== "*" && current?.etag === cond.etagDoesNotMatch) return null;
      const data = typeof value === "string" ? Buffer.from(value)
        : Buffer.from(await new Response(value).arrayBuffer());
      // Storage-level append-only guard for the audit log (the counterpart of Argus's database trigger): whatever the application code does,
      // a month file may only grow by appending, and the head may only move forward.
      if (current && key.startsWith("audit2/") && key.endsWith(".ndjson")) {
        const old = await readFile(join(this.dir, name));
        if (data.length < old.length || !data.subarray(0, old.length).equals(old)) throw new Error("audit log is append-only");
      }
      if (current && key === "audit2/head.json") {
        const before = JSON.parse(await readFile(join(this.dir, name), "utf8")), after = JSON.parse(data.toString());
        if (!(after.sequence >= before.sequence)) throw new Error("audit head cannot move backwards");
      }
      const etag = createHash("sha256").update(data).digest("hex").slice(0, 32);
      await mkdir(this.dir, { recursive: true });
      const tmp = join(this.dir, name + ".tmp-" + process.pid);
      await writeFile(tmp, data);
      await rename(tmp, join(this.dir, name));
      await writeFile(tmp + ".m", JSON.stringify({ key, etag, size: data.length, httpMetadata: options.httpMetadata || {} }));
      await rename(tmp + ".m", join(this.dir, name + ".meta"));
      return { key, etag };
    };
    // Writes are serialised so the worker's compare-and-swap on bench.json is safe within this process.
    const result = this.#lock.then(run, run);
    this.#lock = result.catch(() => {});
    return result;
  }
}
