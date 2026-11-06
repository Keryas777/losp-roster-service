// Aggregate /player campaign timings only. Lives in the existing private
// checkpoint; no tokens, account IDs, URLs, payloads or extra network calls.
const stamp=n=>new Date(n).toISOString();
const ms=(a,b)=>Math.max(0,(Date.parse(b)||0)-(Date.parse(a)||0));
const duration=(n)=>Number.isFinite(n)&&n>=0?n:0;
export function ensurePlayerPerf(s,now){
  if(s.performance?.version===1)return s.performance;
  const at=stamp(now);
  return s.performance={version:1,measuredFrom:at,
    coverage:s.startedAt===at?"full":"partial",
    provider:{gets:0,fetchMs:0,http429:0,networkErrors:0},
    archive:{calls:0,workMs:0},
    cooldown:{events:0,waitMs:0,startedAt:null,until:null},
    recent:[]};
}
export function playerFetchPerf(s,now,elapsed,status,networkError=false){
  const p=ensurePlayerPerf(s,now);
  p.provider.gets++;p.provider.fetchMs+=duration(elapsed);
  if(status===429)p.provider.http429++;
  if(networkError)p.provider.networkErrors++;
  p.recent=p.recent.filter(x=>Date.parse(x.at)>now-15*60000);
  const at=stamp(now),sample=p.recent.find(x=>x.at===at);
  if(sample)sample.gets++;else p.recent.push({at,gets:1});
  if(p.recent.length>20)p.recent=p.recent.slice(-20);
}
export function playerArchivePerf(s,now,elapsed){
  const p=ensurePlayerPerf(s,now);
  p.archive.calls++;p.archive.workMs+=duration(elapsed);
}
export function player429Perf(s,now,until){
  const w=ensurePlayerPerf(s,now).cooldown;
  if(!w.startedAt)w.events++;
  w.startedAt=stamp(now);w.until=stamp(until);
}
export function resumePlayer429Perf(s,now){
  const w=ensurePlayerPerf(s,now).cooldown;
  if(w.startedAt){
    w.waitMs+=ms(w.startedAt,stamp(Math.min(now,Date.parse(w.until))));
    w.startedAt=null;w.until=null;
  }
}
export function viewPlayerPerf(s,now=Date.now()){
  const p=s?.performance;
  if(p?.version!==1)return {status:"not-instrumented"};
  const nowIso=stamp(now),w=p.cooldown;
  const recent=p.recent.filter(x=>Date.parse(x.at)>now-15*60000);
  const gets=recent.reduce((n,x)=>n+x.gets,0);
  const minutes=Math.min(15,
    Math.max(1,(now-Date.parse(p.measuredFrom))/60000));
  return {status:"recorded",measuredFrom:p.measuredFrom,
    coverage:p.coverage,elapsedMs:ms(s.startedAt,s.completedAt||nowIso),
    provider:{...p.provider,meanFetchMs:p.provider.gets?
      Math.round(p.provider.fetchMs/p.provider.gets):null},
    archive:{...p.archive},
    rateLimit:{events:w.events,waitMs:w.waitMs+(w.startedAt?
      ms(w.startedAt,stamp(Math.min(now,Date.parse(w.until)))):0),
      activeUntil:w.startedAt?w.until:null},
    last15Minutes:{gets,getsPerMinute:Number((gets/minutes).toFixed(2))},
    note:"Only this automatic personal /player campaign, not separate alliance roster collection. Provider GETs count actual attempts; requestsToday is a pessimistic reservation, not a daily limit."};
}
