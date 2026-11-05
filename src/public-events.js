// Read-only public projection of verified /game/v1/events catalog pages.
// No Scopely fetch, R2 listing/writes, OAuth/player data, or new cron.
// The existing weekly game differential maintains the latest pointers.
const ROOT="game-archive/v1/";
const LATEST=ROOT+"diff/latest/";
const PATH="/game/v1/events";
// One atomic R2 object for the independently collected daily events catalogue.
export const DAILY_EVENTS_KEY=ROOT+"events-daily/current.json";
const DAILY_MAX_AGE=48*3600000;
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
async function verifiedPage(bucket,page,now,lang="en"){
  const path=PATH+"?page="+page+"&perPage="+PER_PAGE+
    (lang==="fr"?"&lang=fr":"");
  const pointerKey=LATEST+await sha256(path)+".json";
  const {document:pointer}=await read(bucket,pointerKey,5000);
  const objectMatch=OBJECT.exec(pointer?.objectKey||"");
  if(pointer?.version!==2||pointer.path!==path||
    !SHA.test(pointer?.sha256||"")||!objectMatch||
    objectMatch[1]!==pointer.sha256||!RECEIPT.test(pointer.receiptKey||"")||
    !/^[a-f0-9-]{36}$/.test(pointer.runId||"")||
    !pointer.receiptKey.startsWith(ROOT+"diff/runs/"+pointer.runId+"/checks/"))
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
    runId:pointer.runId,revision:meta.hashes.events,storedAt:pointer.storedAt,
    checkedAt:pointer.checkedAt||receipt.checkedAt};
}
// Overlay only public display strings. Keep canonical EN ids, dates,
// rewards, images and numeric scoring. An incomplete FR section falls back
// to its English counterpart, never silently replacing numeric mechanics.
function overlayMethods(original,translated){
  if(!Array.isArray(original)||!Array.isArray(translated)||
     original.length!==translated.length)return original;
  return original.map((method,index)=>{
    const candidate=translated[index];
    return candidate?.points===method.points&&candidate.description?
      {...method,description:candidate.description}:method;
  });
}
function overlayEvent(original,translated){
  const result={...original};
  for(const field of ["name","subName","details"])
    if(translated[field])result[field]=translated[field];
  if(original.milestone&&translated.milestone){
    const milestone={...original.milestone};
    if(translated.milestone.typeName)
      milestone.typeName=translated.milestone.typeName;
    const base=original.milestone.scoring,fr=translated.milestone.scoring;
    if(base&&fr){
      const scoring={...base};
      if(fr.description)scoring.description=fr.description;
      scoring.methods=overlayMethods(base.methods,fr.methods);
      if(Array.isArray(base.cappedScorings)&&
         Array.isArray(fr.cappedScorings)&&
         base.cappedScorings.length===fr.cappedScorings.length){
        scoring.cappedScorings=base.cappedScorings.map((entry,i)=>{
          const target=fr.cappedScorings[i];
          if(entry.cap!==target?.cap||
             (entry.rewardTier??null)!==(target.rewardTier??null))return entry;
          return {...entry,methods:overlayMethods(entry.methods,target.methods)};
        });
      }
      milestone.scoring=scoring;
    }
    result.milestone=milestone;
  }
  if(original.episodic&&translated.episodic?.typeName)
    result.episodic={...original.episodic,typeName:translated.episodic.typeName};
  if(original.pickYourPoison&&translated.pickYourPoison?.typeName)
    result.pickYourPoison={...original.pickYourPoison,
      typeName:translated.pickYourPoison.typeName};
  return result;
}
function countTranslationChanges(original,translated){
  let count=0;
  for(const field of ["name","subName","details"])
    if(original[field]!==translated[field]&&translated[field])count++;
  const a=original.milestone?.scoring,b=translated.milestone?.scoring;
  if(a&&b){
    if(a.description!==b.description&&b.description)count++;
    const methods=(left,right)=>{
      if(!Array.isArray(left)||!Array.isArray(right))return;
      for(let i=0;i<Math.min(left.length,right.length);i++)
        if(left[i]?.points===right[i]?.points&&left[i]?.description!==right[i]?.description)
          count++;
    };
    methods(a.methods,b.methods);
    for(let i=0;i<Math.min(a.cappedScorings?.length||0,b.cappedScorings?.length||0);i++)
      if(a.cappedScorings[i].cap===b.cappedScorings[i].cap)
        methods(a.cappedScorings[i].methods,b.cappedScorings[i].methods);
  }
  return count;
}
// Optional localization. English is always independently verified first;
// all French pages must be verified in the SAME weekly run and have exactly
// matching event IDs/times/types before any overlay is accepted.
async function frenchCatalog(bucket,englishPages,events,now){
  const first=englishPages[0],count=englishPages.length;
  const frenchPages=await Promise.all(Array.from({length:count},(_,i)=>
    verifiedPage(bucket,i+1,now,"fr")));
  const translated=new Map();
  for(let i=0;i<count;i++){
    const page=frenchPages[i],canonical=englishPages[i];
    if(page.total!==first.total||page.runId!==first.runId||
       page.data.length!==canonical.data.length)
      throw Error("incomplete-french-collection");
    for(const raw of page.data){
      const projected=project(raw);
      if(translated.has(projected.id))throw Error("duplicate-french-event");
      translated.set(projected.id,projected);
    }
  }
  if(translated.size!==events.length)throw Error("french-event-set-mismatch");
  let changed=0;
  const merged=events.map(base=>{
    const french=translated.get(base.id);
    if(!french||french.type!==base.type||
       french.startTime!==base.startTime||french.endTime!==base.endTime)
      throw Error("french-event-identity-mismatch");
    const localized=overlayEvent(base,french);
    changed+=countTranslationChanges(base,localized);
    return localized;
  });
  // Do not report a French translation when the provider supplied only
  // byte-equivalent English text, despite the lang=fr query being verified.
  if(changed===0)return {events,locale:"en",localizationStatus:"no-translated-text",
    localizedFields:0,localizedAt:null};
  const localizedAt=frenchPages.map(p=>p.checkedAt)
    .filter(x=>stamp(x,now)!==null).sort().at(-1)||null;
  return {events:merged,locale:"fr",localizationStatus:"verified",
    localizedFields:changed,localizedAt};
}
// Build a single, complete daily publication from exact official list pages.
// This function never fetches Scopely; the collector owns all provider GETs.
export function buildDailyPublicEvents(englishPages,frenchPages=null,now=Date.now()){
  if(!Array.isArray(englishPages)||englishPages.length<1||
     englishPages.length>MAX_PAGES)throw Error("invalid-daily-pages");
  const first=englishPages[0]?.meta;
  const total=first?.perTotal;
  if(!Number.isSafeInteger(total)||total<1||total>MAX_PAGES*PER_PAGE||
     englishPages.length!==Math.ceil(total/PER_PAGE))
    throw Error("invalid-daily-total");
  const seen=new Set(),events=[];
  let revision=first.hashes?.events||null;
  for(let i=0;i<englishPages.length;i++){
    const page=englishPages[i],meta=page?.meta;
    const expected=Math.min(PER_PAGE,total-i*PER_PAGE);
    if(meta?.page!==i+1||meta?.perPage!==PER_PAGE||
       meta?.perTotal!==total||!Array.isArray(page.data)||
       page.data.length!==expected||
       !/^[a-f0-9]{10,64}$/.test(meta.hashes?.events||""))
      throw Error("invalid-daily-page");
    if(meta.hashes.events!==revision)revision=null;
    for(const raw of page.data){
      const item=project(raw);
      if(seen.has(item.id))throw Error("duplicate-daily-event");
      seen.add(item.id);events.push(item);
    }
  }
  let localized=events,locale="en",localizedFields=0;
  let localizationStatus="awaiting-daily-french-collection";
  if(Array.isArray(frenchPages)&&frenchPages.length===englishPages.length){
    try{
      const translations=new Map();
      for(let i=0;i<frenchPages.length;i++){
        const page=frenchPages[i],meta=page?.meta;
        if(meta?.page!==i+1||meta?.perPage!==PER_PAGE||
           meta?.perTotal!==total||!Array.isArray(page.data)||
           page.data.length!==englishPages[i].data.length)
          throw Error("daily-french-page-mismatch");
        for(const raw of page.data){
          const item=project(raw);
          if(translations.has(item.id))throw Error("duplicate-daily-french-event");
          translations.set(item.id,item);
        }
      }
      if(translations.size!==events.length)
        throw Error("incomplete-daily-french-catalog");
      localized=events.map(base=>{
        const fr=translations.get(base.id);
        if(!fr||fr.type!==base.type||fr.startTime!==base.startTime||
           fr.endTime!==base.endTime)
          throw Error("daily-french-identity-mismatch");
        const translated=overlayEvent(base,fr);
        localizedFields+=countTranslationChanges(base,translated);
        return translated;
      });
      localizationStatus=localizedFields?"verified":"no-translated-text";
      if(localizedFields)locale="fr";
    }catch{
      localized=events;localizedFields=0;
      localizationStatus="awaiting-daily-french-collection";
    }
  }
  return {schemaVersion:1,status:"ok",source:"verified-daily-game-events",
    updatedAt:new Date(now).toISOString(),revision,total,count:events.length,
    pages:englishPages.length,events:localized,locale,localizationStatus,
    localizedFields,localizedAt:locale==="fr"?new Date(now).toISOString():null};
}

// The full catalogue is replaced in ONE R2 PUT; a failed daily fetch does not
// expose half an update. SHA and age are checked at every public read.
async function dailyCatalog(bucket,now){
  const entry=await bucket.get(DAILY_EVENTS_KEY);
  if(!entry)return null; // Safe migration from the pre-daily R2 pipeline.
  if(Number.isFinite(entry.size)&&entry.size>MAX_BYTES*MAX_PAGES)
    throw Error("oversized-daily-catalog");
  const raw=await entry.text();
  if(new TextEncoder().encode(raw).byteLength>MAX_BYTES*MAX_PAGES)
    throw Error("oversized-daily-catalog");
  const envelope=JSON.parse(raw),catalog=envelope?.catalog;
  if(envelope?.version!==1||!SHA.test(envelope?.sha256||"")||
     await sha256(JSON.stringify(catalog))!==envelope.sha256||
     catalog?.status!=="ok"||catalog?.schemaVersion!==1||
     catalog?.source!=="verified-daily-game-events"||
     !Array.isArray(catalog.events)||!catalog.events.length||
     catalog.events.length!==catalog.count||catalog.total!==catalog.count||
     new Set(catalog.events.map(x=>x.id)).size!==catalog.count)
    throw Error("invalid-daily-catalog");
  const time=stamp(catalog.updatedAt,now);
  if(time===null||now-time>=DAILY_MAX_AGE)throw Error("stale-daily-catalog");
  return catalog;
}

export async function buildPublicEvents(env,now=Date.now()){
  const bucket=env?.CAPTAIN_BUCKET;
  if(!bucket?.get)throw Error("storage-unavailable");
  const current=await dailyCatalog(bucket,now);
  if(current)return current;
  // Migration only: legacy verified R2 pages, never a local browser snapshot.
  const first=await verifiedPage(bucket,1,now);
  const pages=Math.ceil(first.total/PER_PAGE);
  if(pages<1||pages>MAX_PAGES)throw Error("invalid-page-count");
  const all=[first],ids=new Set(),events=[];
  for(let p=2;p<=pages;p++)all.push(await verifiedPage(bucket,p,now));
  for(let i=0;i<all.length;i++){
    const page=all[i],expected=Math.min(PER_PAGE,first.total-i*PER_PAGE);
    // Compare the weekly verification run, NOT the historical meta.hashes:
    // semantically unchanged pages may reuse older raw bytes deliberately.
    if(page.total!==first.total||page.runId!==first.runId||
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
  if(!updatedAt||now-Date.parse(updatedAt)>=DAILY_MAX_AGE)
    throw Error("stale-legacy-catalog");
  let localized={events,locale:"en",
    localizationStatus:"awaiting-weekly-french-collection",
    localizedFields:0,localizedAt:null};
  try{localized=await frenchCatalog(bucket,all,events,now);}
  catch{
    // A missing/stale/partial French source never makes the verified
    // English catalog unavailable to the WebApp.
  }
  return {schemaVersion:1,status:"ok",source:"verified-weekly-game-archive",
    updatedAt,revision: all.every(p=>p.revision===first.revision)?
      first.revision:null,total:first.total,count:events.length,
    pages,...localized};
}
export async function publicEvents(request,env,now=Date.now()){
  if(request.method!=="GET")return response({status:"method-not-allowed"},405);
  try{return response(await buildPublicEvents(env,now),200,true);}
  catch{return response({status:"unavailable",events:[]},503);}
}
