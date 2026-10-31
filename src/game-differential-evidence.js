// R2-only evidence classification; never calls Scopely or reads /player.
// "No differential pointer" is unknown, NOT evidence that source data is absent.
import {GAME_ARCHIVE_ROOT} from "./game-catalog-archive.js";
const ROOT=GAME_ARCHIVE_ROOT,DIFF=ROOT+"diff/";
const SHA=/^[a-f0-9]{64}$/;
const ITEM_ASSOC=/^\/game\/v1\/items\/([A-Za-z0-9:_-]{1,200})\/characters(?:\?.*)?$/;
const CHARACTER=/^\/game\/v1\/characters\/([A-Za-z0-9:_-]{1,200})(?:\?.*)?$/;
const ITEM=/^\/game\/v1\/items\/([A-Za-z0-9:_-]{1,200})(?:\?.*)?$/;
const DAYS_30=30*86400000;
const hex=async value=>[...new Uint8Array(await crypto.subtle.digest(
  "SHA-256",new TextEncoder().encode(value)))]
  .map(x=>x.toString(16).padStart(2,"0")).join("");
async function small(b,key){
  const obj=await b.get(key);
  if(!obj)return null;
  if(Number.isFinite(obj.size)&&obj.size>10_000)throw Error("metadata-too-large");
  const txt=await obj.text();
  if(txt.length>10_000)throw Error("metadata-too-large");
  return JSON.parse(txt);
}
export function failureRoute(path){
  if(typeof path!=="string")return {type:"unknown",parent:null};
  const assoc=ITEM_ASSOC.exec(path);
  if(assoc)return {type:"item-character-association",
    parent:"/game/v1/items/"+assoc[1]};
  if(ITEM.test(path))return {type:"item-detail",parent:null};
  if(CHARACTER.test(path))return {
    type:path.includes("?")?"character-expanded":"character-detail",parent:null};
  if(/^\/game\/v1\/episodics\//.test(path))
    return {type:"episodic",parent:null};
  if(/^\/game\/v1\/events(?:\/|\?|$)/.test(path))
    return {type:"event",parent:null};
  if(/^\/game\/v1\/[^/]+(?:\?|$)/.test(path))
    return {type:"collection",parent:null};
  return {type:"other-game-route",parent:null};
}
// Checks the durable pointer, matching receipt and physical R2 HEAD; the
// source JSON bytes are NOT downloaded/re-hashed by this diagnostic.
export async function indexedEvidence(bucket,path,now){
  const pointer=await small(bucket,DIFF+"latest/"+await hex(path)+".json");
  if(!pointer)return "not-indexed"; // may exist in original receipts
  const h=pointer?.sha256,k=pointer?.objectKey,r=pointer?.receiptKey;
  if(pointer.path!==path||!SHA.test(h||"")||
     typeof k!=="string"||!k.endsWith("/objects/"+h+".json")||
     !(k.startsWith(ROOT+"runs/")||k.startsWith(DIFF+"runs/"))||
     typeof r!=="string"||
     !/^game-archive\/v1\/diff\/runs\/[a-f0-9-]{36}\/checks\/\d{8}\.json$/.test(r))
    return "invalid-pointer";
  const receipt=await small(bucket,r);
  if(!receipt||receipt.path!==path||receipt.objectKey!==k||
     receipt.sha256!==h||receipt.storedAt!==pointer.storedAt||
     !["changed","unchanged"].includes(receipt.status))
    return "invalid-receipt";
  if(!bucket.head)return "not-verified";
  const head=await bucket.head(k);
  if(!head)return "missing-blob";
  const date=Date.parse(receipt.storedAt||"");
  if(!Number.isFinite(date)||date>now+300000||now-date>=DAYS_30)
    return "stale-or-undated";
  return "indexed-object-present";
}
const SEGMENTS=["abilities","costumes","gear","direct-cost","flat-cost"];
export function characterSegment(path){
  if(!CHARACTER.test(path)||!path.includes("?"))return null;
  const u=new URL("https://msf.invalid"+path),q=u.searchParams;
  const yes=name=>q.get(name)==="full";
  if(yes("abilityKits")&&["costumes","gearTiers","pieceInfo",
    "pieceDirectCost","pieceFlatCost"].every(x=>q.get(x)==="none"))
    return "abilities";
  if(yes("costumes")&&q.get("abilityKits")==="none")return "costumes";
  if(yes("gearTiers")&&yes("pieceInfo")&&
     q.get("pieceDirectCost")==="none"&&q.get("pieceFlatCost")==="none")
    return "gear";
  if(yes("gearTiers")&&yes("pieceDirectCost")&&
     q.get("pieceFlatCost")==="none")return "direct-cost";
  if(yes("gearTiers")&&yes("pieceFlatCost")&&
     q.get("pieceDirectCost")==="none")return "flat-cost";
  if(["basic","special","ultimate","passive"].includes(q.get("abilityKits")))
    return "ability-"+q.get("abilityKits");
  return null;
}
export async function reviewFailure(bucket,row,now=Date.now()){
  const route=failureRoute(row.path),result={type:route.type};
  if(row.reason==="http-404"&&route.parent){
    result.itemEvidence=await indexedEvidence(bucket,route.parent,now);
  }
  if(row.reason==="http-472"){
    const parts=Array.isArray(row.recoveredParts)?
      [...new Set(row.recoveredParts.filter(x=>
        typeof x==="string"&&x.startsWith("/game/v1/")))].slice(0,16):[];
    const verified=new Set(),recorded=new Set();
    let unverified=0;
    for(const path of parts){
      const part=characterSegment(path);
      if(part)recorded.add(part);
      const state=await indexedEvidence(bucket,path,now);
      if(state==="indexed-object-present"){
        if(part)verified.add(part);
      }else unverified++;
    }
    const covered=new Set(verified);
    if(["basic","special","ultimate","passive"].every(s=>
      verified.has("ability-"+s)))covered.add("abilities");
    result.variants={recorded:parts.length,
      verified:parts.length-unverified,notVerified:unverified,
      completeSegments:SEGMENTS.filter(x=>covered.has(x)),
      recordedSegments:[...recorded],
      completeFive:SEGMENTS.every(x=>covered.has(x)),
      onlyRecorded:parts.length>0&&verified.size===0};
  }
  return result;
}
