// Optional OCR for scanned PDFs: poppler's pdftoppm renders each page, Tesseract reads it (see deploy/enable-ocr.sh).
// Returns null when either tool is missing. Both are called as separate programs; nothing is linked into LiteraSift.
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const has = async cmd => run(cmd, ["--version"], { timeout: 10000 }).then(() => true, e => e.code !== "ENOENT");

export async function makeOcrFn() {
  if (!(await has("tesseract")) || !(await has("pdftoppm"))) return null;
  const language = process.env.OCR_LANG || "eng";
  return async function ocrPdf(bytes, { maxPages = 25 } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "ls-ocr-"));
    try {
      await writeFile(join(dir, "in.pdf"), Buffer.from(bytes));
      await run("pdftoppm", ["-r", "170", "-gray", "-png", "-l", String(maxPages), join(dir, "in.pdf"), join(dir, "p")], { timeout: 120000 });
      const pages = (await readdir(dir)).filter(f => /^p-\d+\.png$/.test(f)).sort();
      const out = [];
      for (const page of pages) {
        const { stdout } = await run("tesseract", [join(dir, page), "stdout", "-l", language, "--psm", "1"], { timeout: 90000, maxBuffer: 8_000_000 });
        out.push(stdout.trim());
      }
      return out.filter(Boolean).join("\n\n");
    } finally { await rm(dir, { recursive: true, force: true }); }
  };
}

// Text found by pdf.js is used when it looks like real text; a scan with (almost) no text layer is read with OCR instead.
export const looksScanned = (text, pages = 1) => String(text || "").replace(/\s+/g, "").length < 120 * Math.max(1, Math.min(pages, 5));
