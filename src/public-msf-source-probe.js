// Explicit READ-ONLY probes of secondary MSF web-site services.
// This is NOT the OAuth developer API. No player token/cookie is forwarded,
// no guessed path is accepted, and no automatic cron is installed.
const ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
const SOURCE="https://api-prod.marvelstrikeforce.com";
export const PUBLIC_SOURCE_ROOT="msf-secondary-sources/v1/";
export const PUBLIC_SOURCE_COOLDOWN_MS=10*60_000;
// Threshold for in-memory inspection, NOT a source-size limit.
export const PUBLIC_SOURCE_MAX_BYTES=8_000_000;
const HEADERS={"Cache-Control":"private, no-store",
  "X-Content-Type-Options":"nosniff","X-Robots-Tag":"noindex"};
const response=(body,status=200)=>Response.json(body,{status,headers:HEADERS});
export const PUBLIC_SOURCE_ROUTES=Object.freeze([
  {id:"get-character-list",path:"/services/api/getCharacterList?lang=fr"},
  {id:"get-character-abilities",path:"/services/api/getCharacterAbilities"},
  {id:"get-character-ability-caps",path:"/services/api/getCharacterAbilityCaps"},
  {id:"get-character-instance-caps",path:"/services/api/getCharacterInstanceCaps"},
  {id:"get-character-max-stat-caps",path:"/services/api/getCharacterMaxStatCaps"},
  {id:"get-traits",path:"/services/api/getTraits"},
  {id:"get-traits-by-category",path:"/services/api/getTraitsByCategory"},
  {id:"get-iso8-abilities",path:"/services/api/getIso8Abilities"},
  {id:"get-gear",path:"/services/api/getGear"},
  {id:"get-upgrade-tokens",path:"/services/api/getUpgradeTokens"},
  {id:"get-localization-heroes",path:"/services/api/getLocalization?tableId=heroes&lang=fr&format=json"}
]);
const byId=new Map(PUBLIC_SOURCE_ROUTES.map(x=>[x.id,x]));
async function sourceBytes(upstream,bucket,prefix){
  if(!upstream.body)return {status:"invalid-body"};
  const reader=upstream.body.getReader(),chunks=[];
  let length=0,done=false;
  try{
    while(length<=PUBLIC_SOURCE_MAX_BYTES){
      const next=await reader.read();
      if(next.done){done=true;break;}
      length+=next.value.byteLength;chunks.push(next.value);
    }
  }catch{return {status:"unavailable"};}
  if(!done){
    // Unknown-length responses require R2 multipart uploads. Preserve
    // every byte; no artificial 8 MB rejection or unsupported R2.put(stream).
    const key=prefix+"raw/"+crypto.randomUUID()+".json";
    const upload=await bucket.createMultipartUpload(key,{
      httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
    });
    const partSize=6*1024*1024,parts=[];
    let buffer=new Uint8Array(partSize),used=0,num=1;
    async function append(chunk){
      let offset=0;
      while(offset<chunk.byteLength){
        const take=Math.min(partSize-used,chunk.byteLength-offset);
        buffer.set(chunk.subarray(offset,offset+take),used);
        used+=take;offset+=take;
        if(used===partSize){
          parts.push(await upload.uploadPart(num++,buffer));
          buffer=new Uint8Array(partSize);used=0;
        }
      }
    }
    try{
      for(const c of chunks)await append(c);
      for(;;){
        const next=await reader.read();
        if(next.done)break;
        length+=next.value.byteLength;
        await append(next.value);
      }
      if(used)parts.push(await upload.uploadPart(num++,buffer.subarray(0,used)));
      await upload.complete(parts);
    }catch{
      await upload.abort().catch(()=>{});
      return {status:"unavailable"};
    }
    return {status:"archived-unindexed",key,bytes:length};
  }
  const bytes=new Uint8Array(length);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return {status:"ok",bytes};
}
const fingerprint=async bytes=>[...new Uint8Array(
  await crypto.subtle.digest("SHA-256",bytes)
)].map(x=>x.toString(16).padStart(2,"0")).join("");
async function recordStatus(bucket,key,state){
  await bucket.put(key,JSON.stringify(state),{
    httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
  });
}
export async function handlePublicSourceProbe(request,env,fetchImpl=fetch,now=Date.now()){
  if(request.method!=="POST")return response({status:"method-not-allowed"},405);
  const url=new URL(request.url);
  if(url.origin!==ORIGIN||request.headers.get("Origin")!==ORIGIN||
     !(request.headers.get("Content-Type")||"").toLowerCase().startsWith("application/json"))
    return response({status:"forbidden"},403);
  if(!env?.CAPTAIN_BUCKET?.get||!env?.CAPTAIN_BUCKET?.put)
    return response({status:"storage-unavailable"},503);
  let id;
  try{
    const body=await request.text();
    if(body.length>100)throw Error("payload too long");
    const parsed=JSON.parse(body);
    if(!parsed||typeof parsed!=="object"||Array.isArray(parsed)||
       Object.keys(parsed).length!==1||typeof parsed.id!=="string")
      throw Error("invalid payload");
    id=parsed.id;
  }catch{return response({status:"invalid-payload"},400);}
  const config=byId.get(id);
  if(!config)return response({status:"unrecognized-source"},400);
  const prefix=PUBLIC_SOURCE_ROOT+config.id+"/";
  const checkKey=prefix+"last-check.json";
  let last;
  try{
    const item=await env.CAPTAIN_BUCKET.get(checkKey);
    last=item?JSON.parse(await item.text()):null;
  }catch{return response({status:"storage-unavailable"},503);}
  if(last&&Number.isFinite(last.checkedAtMs)&&
     now-last.checkedAtMs>=0&&now-last.checkedAtMs<PUBLIC_SOURCE_COOLDOWN_MS)
    return response({status:"cooldown",source:id,
      retryAfterSeconds:Math.ceil((PUBLIC_SOURCE_COOLDOWN_MS-(now-last.checkedAtMs))/1000)});
  const uri=SOURCE+config.path;
  let outcome={status:"unavailable",source:id,httpStatus:null},raw=null;
  try{
    const upstream=await fetchImpl(uri,{
      method:"GET",redirect:"manual",cache:"no-store",
      signal:AbortSignal.timeout(12000),
      headers:{"Accept":"application/json","User-Agent":"APIClient/1.0 (Server)"}
    });
    if(!upstream.ok){
      outcome={status:upstream.status===429?"rate-limited":"http-error",
        source:id,httpStatus:upstream.status};
    }else{
      const bounded=await sourceBytes(upstream,env.CAPTAIN_BUCKET,prefix);
      if(bounded.status==="archived-unindexed"){
        // JSON validation/indexing remains outstanding; never claim a
        // raw multipart archive is a fully interpreted JSON snapshot.
        await recordStatus(env.CAPTAIN_BUCKET,prefix+"latest.json",{
          version:1,source:id,path:config.path,sha256:null,key:bounded.key,
          bytes:bounded.bytes,indexed:false,receivedAt:new Date(now).toISOString()
        });
        outcome={status:"archived-unindexed",source:id,httpStatus:upstream.status,
          bytes:bounded.bytes};
      }else if(bounded.status!=="ok")
        outcome={status:bounded.status,source:id,httpStatus:upstream.status};
      else{
        const bytes=bounded.bytes;
        let parsed;
        try{parsed=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes))}
        catch{parsed=null;}
        if(!parsed||typeof parsed!=="object")
          outcome={status:"invalid-json",source:id,httpStatus:upstream.status};
        else{
          const sha256=await fingerprint(bytes);
          const key=prefix+"sha256-"+sha256+".json";
          // Preserve upstream bytes (including optional fields and whitespace).
          // This is a PUBLIC game-data service, not an account/roster endpoint.
          if(!await env.CAPTAIN_BUCKET.get(key))
            await env.CAPTAIN_BUCKET.put(key,bytes,{
              httpMetadata:{contentType:"application/json",cacheControl:"private, no-store"}
            });
          await recordStatus(env.CAPTAIN_BUCKET,prefix+"latest.json",{
            version:1,source:id,path:config.path,sha256,key,
            bytes:bytes.byteLength,receivedAt:new Date(now).toISOString()
          });
          outcome={status:"archived",source:id,httpStatus:upstream.status,
            bytes:bytes.byteLength,sha256};
        }
      }
    }
  }catch{
    outcome={status:"unavailable",source:id,httpStatus:null};
  }
  // Never log or expose the upstream payload, cookies, tokens or opaque keys.
  try{
    await recordStatus(env.CAPTAIN_BUCKET,checkKey,{
      version:1,source:id,checkedAtMs:now,checkedAt:new Date(now).toISOString(),
      status:outcome.status,httpStatus:outcome.httpStatus
    });
  }catch{return response({status:"storage-unavailable"},503);}
  return response(outcome);
}
