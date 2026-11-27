// The whole UI is one script inside a template literal, so a stray quote or backslash only shows up in a browser. This catches it in CI.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { MANAGER, makeEnv } from "./helpers.mjs";
import worker from "../worker/index.js";

test("the page script parses", async () => {
  const { env } = await makeEnv();
  const html = await (await worker.fetch(new Request("http://localhost/", { headers: { "oai-authenticated-user-email": MANAGER } }), env)).text();
  const script = html.split("<script>")[1].split("</script>")[0];
  assert.ok(script.length > 50000);
  assert.doesNotThrow(() => new vm.Script(script, { filename: "page.js" }));
});

test("the off-canvas menu scrim is hidden by default, so the desktop grid is not pushed out of place", async () => {
  const { env } = await makeEnv();
  const html = await (await worker.fetch(new Request("http://localhost/", { headers: { "oai-authenticated-user-email": MANAGER } }), env)).text();
  assert.match(html, /\n\.navscrim\{display:none\}\n\.shell\{display:grid/, "a global rule hides the scrim outside the phone media query");
});
