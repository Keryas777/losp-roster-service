const DAY=/^\d{4}-\d{2}-\d{2}$/;
const validDay=value=>DAY.test(value||"")&&
  Number.isFinite(Date.parse(value+"T00:00:00Z"))&&
  new Date(value+"T00:00:00Z").toISOString().slice(0,10)===value;
const dispatchKey=day=>"automation/arena-github-dispatch/"+day+".json";
const workflowUrl="https://api.github.com/repos/Keryas777/msf/actions/workflows/snapshot-arena.yml/dispatches";
const archiveUrl=day=>"https://api.github.com/repos/Keryas777/msf/contents/docs/data/arena-history/snapshots/"+day+".json?ref=main";
const headers=token=>({"Accept":"application/vnd.github+json",
  "X-GitHub-Api-Version":"2022-11-28","User-Agent":"LoSP-Roster-Service",
  "Authorization":"Bearer "+token,"Content-Type":"application/json"});
async function save(bucket,day,status,now){
  await bucket.put(dispatchKey(day),JSON.stringify({version:1,date:day,
    campaign:day+"-reward",status,updatedAt:new Date(now).toISOString()}),{
      httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
    });
}
export async function dispatchArenaPublication(env,day,fetchImpl=fetch,now=Date.now()){
  if(!validDay(day)||!Number.isFinite(now))return {status:"invalid-campaign"};
  const bucket=env?.CAPTAIN_BUCKET,token=env?.ROSTER_GITHUB_DISPATCH_TOKEN;
  if(!bucket?.get||!bucket?.put||typeof token!=="string"||!token)
    return {status:"unavailable"};
  try{
    const key=dispatchKey(day),object=await bucket.get(key);
    let prior=null;
    if(object){
      prior=JSON.parse(await object.text());
      if(prior?.version!==1||prior.date!==day||prior.campaign!==day+"-reward")
        prior=null;
      if(prior?.status==="published")return {status:"published"};
      const dispatched=Date.parse(prior?.updatedAt);
      if(prior?.status==="dispatched"&&Number.isFinite(dispatched)&&
         now-dispatched<10*60000)return {status:"already-dispatched"};
      if(prior?.status==="dispatched"){
        const published=await fetchImpl(archiveUrl(day),{
          method:"GET",headers:headers(token)
        });
        if(published.status===200){
          await save(bucket,day,"published",now);
          return {status:"published"};
        }
        if(published.status!==404)return {status:"retry-pending",
          httpStatus:published.status};
      }
    }
    const response=await fetchImpl(workflowUrl,{
      method:"POST",headers:headers(token),
      body:JSON.stringify({ref:"main",inputs:{source_date:day}})
    });
    if(response.status!==204)return {status:"retry-pending",httpStatus:response.status};
    await save(bucket,day,"dispatched",now);
    return {status:"dispatched"};
  }catch{
    return {status:"retry-pending"};
  }
}
