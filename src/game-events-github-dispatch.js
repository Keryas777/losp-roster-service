// GitHub Pages publishing signal for the already verified public events R2.
// GitHub Actions imports the public projection and commits only the canonical
// docs/data/evenements-snapshot.json file; the Worker never writes GitHub JSON.
import {GAME_ARCHIVE_ROOT} from "./game-catalog-archive.js";
import {DAILY_EVENTS_KEY} from "./public-events.js";

const ROOT=GAME_ARCHIVE_ROOT+"events-daily/";
const STATE=ROOT+"state.json";
const DISPATCHED=ROOT+"github-dispatched.json";
const API="https://api.github.com/repos/Keryas777/msf/actions/workflows/publish-events-r2.yml/dispatches";
const OPTIONS={httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}};
const read=async(b,key)=>{
  const obj=await b.get(key);
  return obj?JSON.parse(await obj.text()):null;
};
export async function dispatchGameEventsToGithub(env,fetchGithub=fetch,now=Date.now()){
  if(env?.GAME_EVENTS_GITHUB_DISPATCH_ENABLED==="false")return "disabled";
  const token=env?.ROSTER_GITHUB_DISPATCH_TOKEN;
  if(typeof token!=="string"||!token)return "not-configured";
  const bucket=env?.CAPTAIN_BUCKET;
  if(!bucket?.get||!bucket?.put)return "storage-unavailable";
  try{
    const state=await read(bucket,STATE);
    if(state?.status!=="completed"||!Number.isFinite(Date.parse(state.checkedAt||"")))
      return "not-ready";
    const previous=await read(bucket,DISPATCHED);
    if(previous?.checkedAt===state.checkedAt)return "already-dispatched";
    const content=await read(bucket,DAILY_EVENTS_KEY);
    if(content?.version!==1||content.catalog?.status!=="ok"||
       content.catalog?.source!=="verified-daily-game-events"||
       content.catalog.updatedAt!==state.checkedAt||
       content.catalog.events?.length!==state.count||
       now-Date.parse(state.checkedAt)>48*3600000||
       Date.parse(state.checkedAt)>now+300000)
      return "invalid-publication";
    const reason=state.trigger==="differential"?"differential":"daily";
    let response;
    try{
      response=await fetchGithub(API,{method:"POST",
        headers:{"Accept":"application/vnd.github+json",
          "X-GitHub-Api-Version":"2022-11-28",
          "User-Agent":"LoSP-Roster-Service",
          "Authorization":"Bearer "+token,
          "Content-Type":"application/json"},
        body:JSON.stringify({ref:"main",inputs:{reason}}),
        redirect:"manual",signal:AbortSignal.timeout(15000)});
    }catch{return "github-unavailable";}
    if(response.status!==204)return "github-unavailable";
    await bucket.put(DISPATCHED,JSON.stringify({
      version:1,checkedAt:state.checkedAt,
      dispatchedAt:new Date(now).toISOString(),reason
    }),OPTIONS);
    return "dispatched";
  }catch{return "unavailable";}
}
