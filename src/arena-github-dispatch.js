const DAY=/^\d{4}-\d{2}-\d{2}$/;
const validDay=value=>DAY.test(value||"")&&
  Number.isFinite(Date.parse(value+"T00:00:00Z"))&&
  new Date(value+"T00:00:00Z").toISOString().slice(0,10)===value;
const dispatchKey=day=>"automation/arena-github-dispatch/"+day+".json";
export async function dispatchArenaPublication(env,day,fetchImpl=fetch,now=Date.now()){
  if(!validDay(day)||!Number.isFinite(now))return {status:"invalid-campaign"};
  const bucket=env?.CAPTAIN_BUCKET,token=env?.ROSTER_GITHUB_DISPATCH_TOKEN;
  if(!bucket?.get||!bucket?.put||typeof token!=="string"||!token)
    return {status:"unavailable"};
  try{
    const existing=await bucket.get(dispatchKey(day));
    if(existing){
      const prior=JSON.parse(await existing.text());
      if(prior?.version===1&&prior.date===day&&
         prior.campaign===day+"-reward"&&prior.status==="dispatched")
        return {status:"already-dispatched"};
    }
    const response=await fetchImpl(
      "https://api.github.com/repos/Keryas777/msf/actions/workflows/snapshot-arena.yml/dispatches",{
        method:"POST",
        headers:{"Accept":"application/vnd.github+json",
          "X-GitHub-Api-Version":"2022-11-28",
          "User-Agent":"LoSP-Roster-Service",
          "Authorization":"Bearer "+token,
          "Content-Type":"application/json"},
        body:JSON.stringify({ref:"main",inputs:{source_date:day}})
      });
    if(response.status!==204)return {status:"retry-pending",httpStatus:response.status};
    await bucket.put(dispatchKey(day),JSON.stringify({version:1,date:day,
      campaign:day+"-reward",dispatchedAt:new Date(now).toISOString(),
      status:"dispatched"}),{httpMetadata:{contentType:"application/json",
        cacheControl:"private, no-store"}});
    return {status:"dispatched"};
  }catch{
    return {status:"retry-pending"};
  }
}
