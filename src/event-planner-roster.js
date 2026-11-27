// Resolve only the connected captain's own latest scheduled R2 roster.
// No Scopely request, new collection, or persistent write occurs here.
import {CAPTAIN_PREFIX,validCaptainKey} from "./captain-vault.js";
import {readCollectibleApprovals} from "./guest-alliance-approvals.js";
import {projectPersonalRoster} from "./secure-guest-rosters.js";

const INDEX_PREFIX="roster-batches/v1/connected-alliances/sessions/";
const HINT_PREFIX="roster-session-hint/v1/";
const HEX=/^[a-f0-9]{64}$/;
const MAX_LINK_BYTES=1024;

async function readJson(bucket,key,max=MAX_LINK_BYTES){
  const object=await bucket.get(key);
  if(!object)return null;
  if(Number.isSafeInteger(object.size)&&object.size>max)throw Error("oversized");
  const raw=await object.text();
  if(raw.length>max)throw Error("oversized");
  return JSON.parse(raw);
}

export async function readEventPlannerRoster(env,sessionKey,now=Date.now()){
  const bucket=env?.CAPTAIN_BUCKET;
  if(!validCaptainKey(sessionKey))return {status:"unavailable",stage:"session-key"};
  if(!bucket?.get)return {status:"unavailable",stage:"storage"};
  const sessionHash=sessionKey.slice(CAPTAIN_PREFIX.length);
  let link;
  try{link=await readJson(bucket,INDEX_PREFIX+sessionHash);}
  catch{return {status:"unavailable",stage:"session-alliance-index"};}
  if(!link)return {status:"unavailable",stage:"session-alliance-index"};
  if(link.version!==1||!HEX.test(link.fingerprint||"")||
     typeof link.name!=="string"||link.name.length>90||
     !Number.isFinite(Date.parse(link.observedAt))||Date.parse(link.observedAt)>now)
    return {status:"unavailable",stage:"session-alliance-index"};

  let approvals;
  try{approvals=await readCollectibleApprovals(env);}
  catch{return {status:"unavailable",stage:"approval-registry"};}
  if(approvals.status==="invalid-registry")
    return {status:"unavailable",stage:"approval-registry"};
  if(!approvals.alliances.some(item=>item.fingerprint===link.fingerprint))
    return {status:"unavailable",stage:"alliance-not-approved"};

  let hint;
  try{hint=await readJson(bucket,HINT_PREFIX+link.fingerprint+".json");}
  catch{return {status:"unavailable",stage:"account-link"};}
  // The scheduled collector's hint identifies the exact captain key whose
  // OAuth grant supplied member-self.json. Never infer identity from a name,
  // alliance membership, or another member's volatile Scopely ID.
  if(hint?.version!==1||hint.key!==sessionKey)
    return {status:"unavailable",stage:"account-link"};

  const snapshot=await projectPersonalRoster(bucket,link.fingerprint,now);
  if(snapshot.status!=="ok")return {status:"unavailable",stage:snapshot.status};
  return {...snapshot,allianceObservedAt:link.observedAt};
}
