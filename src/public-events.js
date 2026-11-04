// Read-only public projection of verified /game/v1/events catalog pages.
// No Scopely fetch, R2 listing/writes, OAuth/player data, or new cron.
// The existing weekly game differential maintains the latest pointers.
const ROOT="game-archive/v1/";
const LATEST=ROOT+"diff/latest/";
const PATH="/game/v1/events";
const PER_PAGE=100,MAX_PAGES=10,MAX_BYTES=1500000;
const MAX_AGE=30*86400000;
const SHA=/^[a-f0-9]{64}$/;
const RECEIPT=/^game-archive\/v1\/diff\/runs\/[a-f0-9-]{36}\/checks\/\d{8}\.json$/;
const OBJECT=/^game-archive\/v1\/(?:diff\/)?runs\/[a-f0-9-]{36}\/objects\/([a-f0-9]{64})\.json$/;
const ASSET=/^https:\/\/assets\.marvelstrikeforce\.com\/(?:key_art|imgs)\/[A-Za-z0-9_./%-]{1,260}\.(?:png|jpe?g|webp)$/i;
const ID=/^[a-f0-9]{24}$/;
const HEADERS={"Access-Control-Allow-Origin":"*",
  "X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer",
  "Cache-Control":"no-store"};
const response=(body,status=200,cache=false)=>Response.json(body,{
  status,headers:{...HEADERS,...(cache?{"Cache-Control":"public, max-age=300"}:{})}
});
const stamp=(value,now)=>{
  const time=typeof value==="string"?Date.parse(value):NaN;
  return Number.isFinite(time)&&time<=now+300000&&time>=0?time:null;
};
const clean=(value,max=300)=>typeof value==="string"&&value.length<=max?
  value.replace(/[\u0000-\u001f\u007f]/g,"").trim():"";
const image=value=>typeof value==="string"&&ASSET.test(value)?value:undefined;
const finite=(value,max=1e12)=>Number.isFinite(value)&&value>=0&&value<=max?value:undefined;
async function sha256(value){
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
async function read(bucket,key,limit){
  const object=await bucket.get(key);
  if(!object)throw Error("missing");
  if(Number.isFinite(object.size)&&object.size>limit)throw Error("oversized");
  const raw=await object.text();
  if(new TextEncoder().encode(raw).byteLength>limit)throw Error("oversized");
  return {raw,document:JSON.parse(raw)};
}
function method(m){
  const description=clean(m?.description,600),points=finite(m?.points);
  return description&&points!==undefined?{description,points}:null;
}
function scored(s){
  if(!s||typeof s!=="object")return undefined;
  const methods=Array.isArray(s.methods)?
    s.methods.slice(0,60).map(method).filter(Boolean):[];
  const cappedScorings=Array.isArray(s.cappedScorings)?
    s.cappedScorings.slice(0,60).map(c=>{
      const cap=finite(c?.cap),m=Array.isArray(c?.methods)?
        c.methods.slice(0,30).map(method).filter(Boolean):[];
      if(cap===undefined||!m.length)return null;
      return {cap,methods:m,...(Number.isSafeInteger(c.rewardTier)&&
        c.rewardTier>=0?{rewardTier:c.rewardTier}:{})};
    }).filter(Boolean):[];
  return {description:clean(s.description,700),methods,cappedScorings};
}
function brackets(v){
  return Array.isArray(v)?v.slice(0,16).map(b=>({
    id:clean(b?.id,60),
    ...(Number.isSafeInteger(b?.firstPremiumMilestone)?
      {firstPremiumMilestone:b.firstPremiumMilestone}:{})
  })).filter(b=>b.id):[];
}
function project(e){
  if(!ID.test(e?.id||"")||!Number.isSafeInteger(e?.startTime)||
    !Number.isSafeInteger(e?.endTime)||e.endTime<=e.startTime||
    !clean(e.type,50))throw Error("invalid-event");
  const event={id:e.id,type:clean(e.type,50),
    startTime:e.startTime,endTime:e.endTime};
  for(const field of ["name","subName","details"]){
    const value=clean(e[field],field==="details"?5000:600);
    if(value)event[field]=value;
  }
  for(const field of ["cardArt","popupArt","icon"]){
    const value=image(e[field]);if(value)event[field]=value;
  }
  if(Array.isArray(e.hubArt))event.hubArt=e.hubArt.slice(0,5).map(image).filter(Boolean);
  if(Array.isArray(e.locationHints))
    event.locationHints=e.locationHints.slice(0,12).map(x=>clean(x,80)).filter(Boolean);
  if(e.milestone&&typeof e.milestone==="object")
    event.milestone={type:clean(e.milestone.type,40),
      typeName:clean(e.milestone.typeName,60),
      scoring:scored(e.milestone.scoring),
      brackets:brackets(e.milestone.brackets)};
  if(e.episodic&&typeof e.episodic==="object")
    event.episodic={type:clean(e.episodic.type,60),
      typeName:clean(e.episodic.typeName,70),
      id:clean(e.episodic.id,150),
      ids:Array.isArray(e.episodic.ids)?
        e.episodic.ids.slice(0,40).map(x=>clean(x,150)).filter(Boolean):[]};
  if(e.pickYourPoison&&typeof e.pickYourPoison==="object")
    event.pickYourPoison={typeName:clean(e.pickYourPoison.typeName,70),
      brackets:brackets(e.pickYourPoison.brackets)};
  return event;
}
async function verifiedPage(bucket,page,now){
  const path=PATH+"?page="+page+"&perPage="+PER_PAGE;
  const pointerKey=LATEST+await sha256(path)+".json";
  const {document:pointer}=await read(bucket,pointerKey,5000);
  const objectMatch=OBJECT.exec(pointer?.objectKey||"");
  if(pointer?.version!==2||pointer.path!==path||
    !SHA.test(pointer?.sha256||"")||!objectMatch||
    objectMatch[1]!==pointer.sha256||!RECEIPT.test(pointer.receiptKey||""))
    throw Error("invalid-pointer");
  const at=stamp(pointer.storedAt,now);
  if(at===null||now-at>=MAX_AGE)throw Error("expired-source");
  const {document:receipt}=await read(bucket,pointer.receiptKey,8000);
  if(!["changed","unchanged"].includes(receipt?.status)||
    receipt.path!==path||receipt.sha256!==pointer.sha256||
    receipt.objectKey!==pointer.objectKey||receipt.storedAt!==pointer.storedAt)
    throw Error("invalid-receipt");
  const {raw,document}=await read(bucket,pointer.objectKey,MAX_BYTES);
  if(await sha256(raw)!==pointer.sha256)throw Error("invalid-sha");
  const meta=document?.meta;
  if(!Array.isArray(document?.data)||meta?.page!==page||
    meta.perPage!==PER_PAGE||!Number.isSafeInteger(meta.perTotal)||
    meta.perTotal<1||meta.perTotal>PER_PAGE*MAX_PAGES||
    !/^[a-f0-9]{10,64}$/.test(meta.hashes?.events||""))
    throw Error("invalid-page");
  return {data:document.data,total:meta.perTotal,
    revision:meta.hashes.events,storedAt:pointer.storedAt,
    checkedAt:pointer.checkedAt||receipt.checkedAt};
}
export async function buildPublicEvents(env,now=Date.now()){
  const bucket=env?.CAPTAIN_BUCKET;
  if(!bucket?.get)throw Error("storage-unavailable");
  const first=await verifiedPage(bucket,1,now);
  const pages=Math.ceil(first.total/PER_PAGE);
  if(pages<1||pages>MAX_PAGES)throw Error("invalid-page-count");
  const all=[first],ids=new Set(),events=[];
  for(let p=2;p<=pages;p++)all.push(await verifiedPage(bucket,p,now));
  for(let i=0;i<all.length;i++){
    const page=all[i],expected=Math.min(PER_PAGE,first.total-i*PER_PAGE);
    if(page.total!==first.total||page.revision!==first.revision||
      page.data.length!==expected)throw Error("inconsistent-catalog");
    for(const raw of page.data){
      const event=project(raw);
      if(ids.has(event.id))throw Error("duplicate-event");
      ids.add(event.id);events.push(event);
    }
  }
  if(events.length!==first.total)throw Error("incomplete-catalog");
  const updatedAt=all.map(x=>x.checkedAt).filter(x=>stamp(x,now)!==null)
    .sort().at(-1)||null;
  return {schemaVersion:1,status:"ok",source:"verified-weekly-game-archive",
    updatedAt,revision: first.revision,total:first.total,count:events.length,
    pages,events};
}
export async function publicEvents(request,env,now=Date.now()){
  if(request.method!=="GET")return response({status:"method-not-allowed"},405);
  try{return response(await buildPublicEvents(env,now),200,true);}
  catch{return response({status:"unavailable",events:[]},503);}
}
