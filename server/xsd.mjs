// Structural validation of E2B(R3) XML against the ICH ICSR schema, with the xmllint program (libxml2). The schema files are not part of this repository:
// download the ICH E2B(R3) ICSR schema package and point ICH_SCHEMA_DIR at its folder that holds MCCI_IN200100UV01.xsd (see deploy/enable-xsd.sh).
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export async function makeXsdValidator() {
  const dir = process.env.ICH_SCHEMA_DIR || "/opt/literasift-schemas/multicacheschemas", schema = join(dir, "MCCI_IN200100UV01.xsd");
  try { await access(schema); await run("xmllint", ["--version"], { timeout: 10000 }); } catch { return null; }
  return async function validate(xml) {
    const tmp = await mkdtemp(join(tmpdir(), "ls-xsd-"));
    try {
      await writeFile(join(tmp, "case.xml"), xml);
      // Pretty-printed so that line numbers point at one element each.
      let formatted = xml; try { formatted = (await run("xmllint", ["--format", join(tmp, "case.xml")], { maxBuffer: 20_000_000 })).stdout; } catch { /* a malformed file is reported below */ }
      await writeFile(join(tmp, "formatted.xml"), formatted);
      try { await run("xmllint", ["--noout", "--schema", schema, join(tmp, "formatted.xml")], { timeout: 60000, maxBuffer: 20_000_000 }); return []; }
      catch (error) {
        return String(error.stderr || error.message).split("\n").filter(l => /Schemas validity error|parser error/.test(l)).slice(0, 50).map(l => {
          const m = /:(\d+): element (\S+): Schemas validity error : (.*)$/.exec(l) || /:(\d+): (.*)$/.exec(l);
          return { line: Number(m?.[1] || 0), element: m?.[3] ? m[2] : "", message: String(m?.[3] || m?.[2] || l).replace(/\{urn:hl7-org:v3\}/g, "").slice(0, 400) };
        });
      }
    } finally { await rm(tmp, { recursive: true, force: true }); }
  };
}
