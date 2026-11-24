import {verifiedAdminEmail} from "./admin-auth.js";

const PRIVATE_HEADERS={"Cache-Control":"private, no-store, max-age=0",
  "CDN-Cache-Control":"no-store","X-Robots-Tag":"noindex",
  "X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"};

export async function eventPlannerAccessStatus(request,env,fetchImpl=fetch,now=Date.now()){
  if(env?.EVENT_PLANNER_ENABLED!=="true"||env?.MSF_ADMIN_ENABLED!=="true")return "disabled";
  const owner=typeof env?.PERSONAL_EVENT_LAB_ADMIN_EMAIL==="string"
    ?env.PERSONAL_EVENT_LAB_ADMIN_EMAIL.trim().toLowerCase():"";
  if(!owner.includes("@"))return "disabled";
  const identity=await verifiedAdminEmail(request,env,fetchImpl,now);
  return identity===owner?"allowed":"denied";
}

export function eventPlannerAccessResponse(status){
  const disabled=status==="disabled";
  return new Response(disabled?"Not Found":"Forbidden",{
    status:disabled?404:403,headers:PRIVATE_HEADERS
  });
}
