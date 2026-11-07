// Request a reviewable WebApp registry PR for a NEW guest alliance.
// This only dispatches GitHub Actions; it never approves collection or reads Scopely.
// Called exclusively through the existing Cloudflare Access admin route.
const ENDPOINT="https://api.github.com/repos/Keryas777/msf/actions/workflows/register-guest-alliance.yml/dispatches";
const ACTIONS="https://github.com/Keryas777/msf/actions/workflows/register-guest-alliance.yml";
const KEY=/^[a-z][a-z0-9-]{1,63}$/;
const ROLE=/^[0-9]{16,22}$/;
const NAME=/^[^\x00-\x1f\x7f<>]{1,120}$/;
const COLOR=/^#[a-fA-F0-9]{6}$/;
const HEADERS={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"};
const reply=(data,status=200)=>Response.json(data,{status,headers:HEADERS});

export async function handleGuestWebappOnboarding(request,env,fetchImpl=fetch){
  if(request.method!=="POST")return reply({status:"method-not-allowed"},405);
  const url=new URL(request.url);
  if(url.search||request.headers.get("Origin")!==url.origin||
     !/^application\/json(?:\s*;.*)?$/i.test(request.headers.get("Content-Type")||""))
    return reply({status:"forbidden"},403);
  let data;
  try{
    const raw=await request.text();
    if(raw.length>500)throw Error("oversized");
    data=JSON.parse(raw);
    if(data===null||typeof data!=="object"||Array.isArray(data)||
       Object.keys(data).sort().join(",")!=="color,key,name,roleId"||
       !KEY.test(data.key)||!NAME.test(data.name)||
       data.name.trim()!==data.name||!ROLE.test(data.roleId)||
       !COLOR.test(data.color))throw Error("invalid-data");
  }catch{return reply({status:"invalid-input"},400);}
  const token=env?.ROSTER_GITHUB_DISPATCH_TOKEN;
  if(typeof token!=="string"||!token)
    return reply({status:"github-dispatch-not-configured"},503);
  try{
    const response=await fetchImpl(ENDPOINT,{
      method:"POST",headers:{
        Accept:"application/vnd.github+json",
        "X-GitHub-Api-Version":"2022-11-28",
        "User-Agent":"LoSP-Roster-Service",
        Authorization:"Bearer "+token,
        "Content-Type":"application/json"
      },body:JSON.stringify({ref:"main",inputs:{
        alliance_key:data.key,alliance_name:data.name,
        discord_role_id:data.roleId,alliance_color:data.color.toUpperCase()
      }}),redirect:"manual"
    });
    if(response.status!==204)return reply({status:"github-dispatch-failed"},503);
    return reply({status:"queued",workflow:ACTIONS},202);
  }catch{return reply({status:"github-dispatch-failed"},503);}
}
