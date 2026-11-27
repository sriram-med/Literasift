import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import webpush from "web-push";

const env = process.env;
if (!env.ALERT_GATEWAY_TOKEN || env.ALERT_GATEWAY_TOKEN.length < 24) throw Error("Configure a strong ALERT_GATEWAY_TOKEN");
const folder=env.ALERT_LEDGER_DIR||"/data";
await fs.mkdir(folder,{recursive:true});
const allowedMobile=JSON.parse(env.MOBILE_RECIPIENTS_JSON||"{}");
const active=new Set();
const pushHosts=["fcm.googleapis.com","updates.push.services.mozilla.com","push.services.mozilla.com","web.push.apple.com","notify.windows.com"];
const token=Buffer.from("Bearer "+env.ALERT_GATEWAY_TOKEN);
const allowedEmail=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const generic=(priority)=>priority?"A safety citation requires priority review.":"New literature is ready for review.";
const link="https://literasift.tech/";
function trustedSubscription(subscription){
  const url=new URL(subscription.endpoint);
  if(url.protocol!=="https:"||url.username||url.password||url.port||!pushHosts.some(h=>url.hostname===h||url.hostname.endsWith("."+h)))throw Error("Unsupported push service");
  if(!/^[A-Za-z0-9_-]+={0,2}$/.test(subscription.keys?.p256dh||"")||!/^[A-Za-z0-9_-]+={0,2}$/.test(subscription.keys?.auth||""))throw Error("Invalid subscription keys");
}
async function send(job,key){
  const body=generic(job.priority===true);
  if(job.channel==="push"){
    if(!env.VAPID_SUBJECT||!env.VAPID_PUBLIC_KEY||!env.VAPID_PRIVATE_KEY)throw Error("Push delivery not configured");
    trustedSubscription(job.subscription);
    webpush.setVapidDetails(env.VAPID_SUBJECT,env.VAPID_PUBLIC_KEY,env.VAPID_PRIVATE_KEY);
    await webpush.sendNotification(job.subscription,JSON.stringify({id:key,priority:job.priority===true}),{TTL:86400,timeout:8000});
    return;
  }
  if(job.channel==="email"){
    if(!env.RESEND_API_KEY||!env.ALERT_FROM_EMAIL||!allowedEmail.test(job.email))throw Error("Email delivery not configured or invalid recipient");
    const response=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:"Bearer "+env.RESEND_API_KEY,"Content-Type":"application/json","Idempotency-Key":key},body:JSON.stringify({from:env.ALERT_FROM_EMAIL,to:[job.email],subject:"LiteraSift literature alert",text:body+"\n"+link}),signal:AbortSignal.timeout(8000)});
    if(!response.ok)throw Error("Email provider rejected delivery: "+response.status);
    return;
  }
  if(job.channel==="mobile"){
    if(!env.TWILIO_ACCOUNT_SID||!env.TWILIO_AUTH_TOKEN||!env.TWILIO_FROM||allowedMobile[job.email]!==job.mobileDestination||!/^\+[1-9]\d{7,14}$/.test(job.mobileDestination))throw Error("Mobile delivery not configured or recipient not approved");
    const response=await fetch("https://api.twilio.com/2010-04-01/Accounts/"+encodeURIComponent(env.TWILIO_ACCOUNT_SID)+"/Messages.json",{method:"POST",headers:{Authorization:"Basic "+Buffer.from(env.TWILIO_ACCOUNT_SID+":"+env.TWILIO_AUTH_TOKEN).toString("base64"),"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({From:env.TWILIO_FROM,To:job.mobileDestination,Body:body+" "+link}),signal:AbortSignal.timeout(8000)});
    if(!response.ok)throw Error("Mobile provider rejected delivery: "+response.status);
    return;
  }
  throw Error("Unsupported channel");
}
function reply(res,status,body){res.writeHead(status,{"Content-Type":"application/json","Cache-Control":"no-store"});res.end(JSON.stringify(body));}
http.createServer(async(req,res)=>{
  if(req.method==="GET"&&req.url==="/health")return reply(res,200,{ok:true});
  if(req.method!=="POST"||req.url!=="/alerts")return reply(res,404,{error:"Not found"});
  const auth=Buffer.from(req.headers.authorization||"");
  if(auth.length!==token.length||!crypto.timingSafeEqual(auth,token))return reply(res,401,{error:"Unauthorized"});
  let hash="";
  try{
    let raw="";
    for await(const chunk of req){raw+=chunk;if(raw.length>32768)return reply(res,413,{error:"Request too large"});}
    const job=JSON.parse(raw);
    if(typeof job.id!=="string"||job.id.length>512||job.id!==req.headers["idempotency-key"])return reply(res,400,{error:"Invalid event identifier"});
    hash=crypto.createHash("sha256").update(job.id).digest("hex");
    const file=folder+"/"+hash;
    try{await fs.access(file);return reply(res,200,{accepted:true,duplicate:true});}catch(e){if(e.code!=="ENOENT")throw e;}
    if(active.has(hash))return reply(res,409,{error:"Delivery in progress"});
    active.add(hash);
    try{
      await send(job,hash);
      await fs.writeFile(file,new Date().toISOString(),{flag:"wx"});
      return reply(res,200,{accepted:true});
    }finally{active.delete(hash);}
  }catch(error){
    console.error("Alert delivery failed",error.message);
    return reply(res,503,{error:"Delivery not accepted"});
  }
}).listen(3001,"0.0.0.0",()=>console.log("LiteraSift alert gateway ready"));
