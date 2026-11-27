// Optional PDF text extraction with pdf.js (Apache-2.0, Mozilla). See deploy/enable-pdf-text.sh.
// Returns null when pdfjs-dist is not installed, so PDF full texts then stay stored without searchable text.
const candidates = [process.env.PDFJS_MODULE, "/opt/literasift-pdf/node_modules/pdfjs-dist/legacy/build/pdf.mjs", "pdfjs-dist/legacy/build/pdf.mjs"].filter(Boolean);

export async function makePdfTextFn() {
  let pdfjs = null;
  for (const spec of candidates) { try { pdfjs = await import(spec.startsWith("/") ? "file://" + spec : spec); break; } catch { /* try the next location */ } }
  if (!pdfjs) return null;
  return async function pdfText(bytes, { maxPages = 60 } = {}) {
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, isEvalSupported: false, disableFontFace: true, verbosity: 0 }), doc = await task.promise;
    try {
      const pages = [];
      for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
        const content = await (await doc.getPage(n)).getTextContent();
        // Lines are rebuilt from the text items: a new line starts when an item reports an end-of-line or its baseline moves.
        let line = "", y = null; const lines = [];
        for (const item of content.items) {
          if (!("str" in item)) continue;
          const itemY = item.transform?.[5];
          if (y !== null && itemY !== undefined && Math.abs(itemY - y) > 2 && line) { lines.push(line.trim()); line = ""; }
          line += item.str + (item.hasEOL ? "\n" : "");
          y = itemY ?? y;
          if (item.hasEOL) { lines.push(line.trim()); line = ""; }
        }
        if (line.trim()) lines.push(line.trim());
        pages.push(lines.filter(Boolean).join("\n"));
      }
      return pages.join("\n\n");
    } finally { await task.destroy(); }
  };
}
