const site = new URL(process.env.BENCH_URL || "https://literature-bench.sriram03.chatgpt.site");
const { SITES_ACCESS_TOKEN, RUN_TOKEN } = process.env;
if (site.protocol !== "https:" || site.username || site.password || !SITES_ACCESS_TOKEN || !RUN_TOKEN) {
  console.error("Set BENCH_URL to an HTTPS site and provide SITES_ACCESS_TOKEN and RUN_TOKEN.");
  process.exit(1);
}

try {
  // Each call imports a limited number of watchlists, so repeat until none remain (or a call makes no progress).
  const results = [];
  let result, evidence;
  for (let call = 0; call < 100; call++) {
    const response = await fetch(new URL("/api/scheduled", site), {
      method: "POST",
      redirect: "error",
      headers: {
        "OAI-Sites-Authorization": "Bearer " + SITES_ACCESS_TOKEN,
        Authorization: "Bearer " + RUN_TOKEN,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw new Error("Literature Bench returned HTTP " + response.status);
    result = await response.json();
    if (!Array.isArray(result.results)) throw new Error("Unexpected response from Literature Bench.");
    results.push(...result.results);
    evidence = result.evidence;
    if (!result.remaining || !result.results.some(run => !run.error)) break;
  }
  const failed = results.filter(run => run.error).length;
  console.log(JSON.stringify({
    time: new Date().toISOString(),
    completedBatches: results.length - failed,
    failedBatches: failed,
    remainingWatchlists: result.remaining || 0,
    evidence,
  }));
  if (failed) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
