// Best-effort wake-up for the WebApp's read-only static Evolution publisher.
// No R2 payload, player data, fingerprint or Discord credential is sent to GitHub.
const API="https://api.github.com/repos/Keryas777/msf/actions/workflows/publish-guest-evolution.yml/dispatches";
export async function dispatchGuestEvolutionPublication(env,fetchGithub=fetch){
  const token=env?.ROSTER_GITHUB_DISPATCH_TOKEN;
  if(typeof token!=="string"||!token)return {status:"not-configured"};
  try{
    const response=await fetchGithub(API,{method:"POST",headers:{
      "Accept":"application/vnd.github+json",
      "X-GitHub-Api-Version":"2022-11-28",
      "User-Agent":"LoSP-Roster-Service",
      "Authorization":"Bearer "+token,
      "Content-Type":"application/json"
    },body:JSON.stringify({ref:"main"})});
    return response.status===204?{status:"dispatched"}:{status:"failed"};
  }catch{return {status:"failed"};}
}
