// Read-only, bounded content lookup in the original /game/v1 R2 JSON blobs.
// Content-addressed bytes can be verified without a surviving historical receipt.
// A matching byte string does NOT prove the original provider URL.
import {GAME_ARCHIVE_ROOT} from "./game-catalog-archive.js";

const ROOT=GAME_ARCHIVE_ROOT,ACTIVE=ROOT+"active.json";
const HEADERS={"Cache-Control":"private, no-store","X-Robots-Tag":"noindex",
  "X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"};
const respond=(data,code=200)=>Response.json(data,{status:code,headers:HEADERS});
const RUN=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
const CURSOR=/^[A-Za-z0-9+/=_-]{1,800}$/;
const QUERY=/^[A-Za-z0-9_:-]{3,100}$/;
const PAGE=30,MAX_JSON=750_000,TTL=30*86400000;
const sha256=async value=>[...new Uint8Array(await crypto.subtle.digest(
  "SHA-256",new TextEncoder().encode(value)))]
  .map(x=>x.toString(16).padStart(2,"0")).join("");
const timestamp=value=>value instanceof Date?value.getTime():
  typeof value==="string"?Date.parse(value):NaN;
const fresh=(value,now)=>{
  const t=timestamp(value);
  return Number.isFinite(t)&&t>0&&t<=now+300000&&now-t<TTL;
};
const uploadedAt=value=>value instanceof Date?value.toISOString():
  typeof value==="string"?value:null;
const keyFor=(run,sha)=>ROOT+"runs/"+run+"/objects/"+sha+".json";
const meta=async(b,key)=>{
  const obj=await b.get(key);
  if(!obj||!Number.isFinite(obj.size)||obj.size>4096)return null;
  return JSON.parse(await obj.text());
};
async function readVerified(b,key,sha,now,listing=null){
  const uploaded=listing?.uploaded;
  const size=listing?.size;
  // Do not load large or expired objects, even if the archived bytes still exist.
  if(Number.isFinite(size)&&size>MAX_JSON)return {issue:"tooLarge"};
  if(uploaded!==undefined&&!fresh(uploaded,now))return {issue:"expired"};
  const obj=await b.get(key);
  if(!obj)return {issue:"missing"};
  if(!Number.isFinite(obj.size)||obj.size>MAX_JSON)return {issue:"tooLarge"};
  const date=obj.uploaded??uploaded;
  if(!fresh(date,now))return {issue:"expired"};
  const raw=await obj.text();
  if(new TextEncoder().encode(raw).byteLength!==obj.size||
     await sha256(raw)!==sha)return {issue:"unverified"};
  try{
    const payload=JSON.parse(raw);
    if(!payload||typeof payload!=="object"||Array.isArray(payload)||
       !Object.hasOwn(payload,"data"))return {issue:"unverified"};
    return {payload,raw,uploadedAt:uploadedAt(date)};
  }catch{return {issue:"unverified"};}
}
function excerpts(raw,needle){
  const lower=raw.toLowerCase(),found=[];
  let offset=0;
  while(found.length<3){
    const index=lower.indexOf(needle,offset);
    if(index<0)break;
    found.push(raw.slice(Math.max(0,index-70),
      Math.min(raw.length,index+needle.length+110)));
    offset=index+needle.length;
  }
  return found;
}
export async function handleGameArchiveContentSearch(request,env,now=Date.now()){
  if(request.method!=="GET")return respond({error:"method-not-allowed"},405);
  const q=new URL(request.url).searchParams;
  const query=q.get("q"),cursor=q.get("cursor"),digest=q.get("sha");
  const fetchOne=digest!==null;
  if(fetchOne?(q.size!==1||!SHA.test(digest||"")):
     (!QUERY.test(query||"")||q.size!==(cursor===null?1:2)||
      cursor!==null&&!CURSOR.test(cursor)))
    return respond({error:"invalid-search"},400);
  const b=env?.CAPTAIN_BUCKET;
  if(!b?.get||!b?.list)return respond({error:"storage-unavailable"},503);
  try{
    const active=await meta(b,ACTIVE);
    if(!RUN.test(active?.runId||""))return respond({error:"no-active-run"},404);
    const prefix=ROOT+"runs/"+active.runId+"/objects/";
    if(fetchOne){
      const result=await readVerified(b,keyFor(active.runId,digest),digest,now);
      if(!result.payload)return respond({status:"unavailable",reason:result.issue},404);
      return respond({status:"found",sha256:digest,uploadedAt:result.uploadedAt,
        provenance:"original-request-unverified",payload:result.payload});
    }
    const page=await b.list({prefix,limit:PAGE,...(cursor?{cursor}:{})});
    if(!Array.isArray(page?.objects)||page.objects.some(o=>
      typeof o?.key!=="string"||!o.key.startsWith(prefix))||
      page.truncated&&(!CURSOR.test(page.cursor||"")||page.cursor===cursor))
      return respond({error:"invalid-r2-page"},503);
    const term=query.toLowerCase();
    const matches=[],stats={listed:0,searched:0,tooLarge:0,expired:0,
      missing:0,unverified:0};
    for(const row of page.objects){
      stats.listed++;
      const name=row.key.slice(prefix.length);
      if(!/^[a-f0-9]{64}\.json$/.test(name)){
        stats.unverified++;continue;
      }
      const sha=name.slice(0,-5);
      let candidate;
      try{candidate=await readVerified(b,row.key,sha,now,row);}
      catch{candidate={issue:"unverified"};}
      if(!candidate.payload){
        stats[candidate.issue]??=0;stats[candidate.issue]++;continue;
      }
      stats.searched++;
      const sample=excerpts(candidate.raw,term);
      if(sample.length)matches.push({sha256:sha,
        uploadedAt:candidate.uploadedAt,excerpts:sample,
        provenance:"original-request-unverified"});
    }
    return respond({status:page.truncated?"searching":"complete",query,
      stats,matches,nextCursor:page.truncated?page.cursor:null,
      note:"Search of original game-archive objects only. SHA-256 verified; "+
        "an orphaned object's original /game URL cannot be inferred. "+
        "Oversized and expired objects are not searched."});
  }catch{return respond({error:"content-search-unavailable"},503);}
}
