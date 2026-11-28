const site = new URL(process.env.BENCH_URL || "https://literature-bench.sriram03.chatgpt.site");
const { SITES_ACCESS_TOKEN, RUN_TOKEN } = process.env;
if (site.protocol !== "https:" || site.username || site.password || !SITES_ACCESS_TOKEN || !RUN_TOKEN) {
  console.error("Set BENCH_URL to an HTTPS site and provide SITES_ACCESS_TOKEN and RUN_TOKEN.");
  process.exit(1);
}
const lanes=["discovery","reconciliation","evidence","alerts"];
async function run(lane){
  try{
    const response=await fetch(new URL("/api/scheduled",site),{
      method:"POST",redirect:"error",headers:{
        "OAI-Sites-Authorization":"Bearer "+SITES_ACCESS_TOKEN,
        Authorization:"Bearer "+RUN_TOKEN,"Content-Type":"application/json"
      },body:JSON.stringify({lane}),signal:AbortSignal.timeout(180000)
    });
    if(!response.ok)throw Error("HTTP "+response.status);
    const result=await response.json();
    if(!Array.isArray(result.results))throw Error("Unexpected scheduler response");
    const failed=result.results.filter(r=>r.error).length;
    const alertFailures=result.alerts?.failed||0;
    console.log(JSON.stringify({time:new Date().toISOString(),lane,completed:result.results.length-failed,failed,alertFailures,evidence:result.evidence,alerts:result.alerts,busy:result.lanes?.[0]?.busy||false}));
    if(failed||alertFailures)process.exitCode=1;
  }catch(error){console.error(JSON.stringify({time:new Date().toISOString(),lane,error:error.message}));process.exitCode=1;}
}
// Run each lane in a separate scheduler process for true failure isolation.
// The default remains one all-lanes request for older installations.
const requested=process.argv[2]||"all";
if(!["all",...lanes].includes(requested)){console.error("Invalid scheduler lane");process.exit(1);}
await run(requested);
