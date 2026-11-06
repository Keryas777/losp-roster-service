// Aggregate timing metrics in the EXISTING /game differential checkpoint.
// No additional R2 objects, no provider calls, no player data.
const stamp=n=>new Date(n).toISOString();
const ms=(a,b)=>{
  const start=Date.parse(a||""),end=Date.parse(b||"");
  return Number.isFinite(start)&&Number.isFinite(end)?Math.max(0,end-start):null;
};
const nonnegative=n=>Number.isFinite(n)&&n>=0?n:0;
const waiting=()=>({events:0,elapsedMs:0,startedAt:null,until:null});
export function ensureGamePerf(s,now){
  if(s.performance?.version===1)return s.performance;
  const at=stamp(now),scan=s.status==="scanning";
  return s.performance={version:1,measuredFrom:at,
    coverage:scan&&s.startedAt===at?"full":"partial",
    scan:{startedAt:scan?at:null,finishedAt:null,ticks:0,entries:0,activeMs:0},
    checking:{startedAt:scan?null:at,finishedAt:null,ticks:0},
    provider:{gets:0,fetchMs:0,bodyMs:0,http429:0,networkErrors:0},
    waiting:{rateLimit:waiting(),dailyBudget:waiting(),budgetBlockedTicks:0},
    budget:{used:null,limit:9000,at:null},recent:[]};
}
export function scanPerf(s,now,entries,elapsed,finished=false){
  const p=ensureGamePerf(s,now);
  p.scan.ticks++;p.scan.entries+=nonnegative(entries);
  p.scan.activeMs+=nonnegative(elapsed);
  if(finished){p.scan.finishedAt=stamp(now);p.checking.startedAt=stamp(now);}
}
export function providerFetchPerf(s,now,elapsed,status,networkError=false){
  const p=ensureGamePerf(s,now).provider;
  p.gets++;p.fetchMs+=nonnegative(elapsed);
  if(status===429)p.http429++;
  if(networkError)p.networkErrors++;
}
export function providerBodyPerf(s,now,elapsed){
  ensureGamePerf(s,now).provider.bodyMs+=nonnegative(elapsed);
}
function closeWait(w,now){
  if(!w.startedAt)return;
  const until=Date.parse(w.until||"");
  const end=Number.isFinite(until)?Math.min(now,until):now;
  w.elapsedMs+=ms(w.startedAt,stamp(end))||0;
  w.startedAt=null;w.until=null;
}
export function start429Perf(s,now,until){
  const w=ensureGamePerf(s,now).waiting.rateLimit;
  if(!w.startedAt)w.events++;
  w.startedAt=stamp(now);w.until=stamp(until);
}
export function resume429Perf(s,now){
  closeWait(ensureGamePerf(s,now).waiting.rateLimit,now);
}
export function noteBudgetPerf(s,now,used,limit){
  ensureGamePerf(s,now).budget={used,limit,at:stamp(now)};
}
export function blockedBudgetPerf(s,now){
  const p=ensureGamePerf(s,now),w=p.waiting.dailyBudget;
  if(!w.startedAt){w.events++;w.startedAt=stamp(now);}
  p.waiting.budgetBlockedTicks++;
}
export function resumeBudgetPerf(s,now){
  closeWait(ensureGamePerf(s,now).waiting.dailyBudget,now);
}
export function checkTickPerf(s,now,gets,checked){
  const p=ensureGamePerf(s,now);
  p.checking.ticks++;
  const list=p.recent.filter(x=>Date.parse(x.at)>now-15*60000);
  list.push({at:stamp(now),gets:nonnegative(gets),checked:nonnegative(checked)});
  p.recent=list.slice(-20);
}
export function finishGamePerf(s,now){
  const p=ensureGamePerf(s,now);
  resume429Perf(s,now);resumeBudgetPerf(s,now);
  p.checking.finishedAt=stamp(now);
}
export function viewGamePerf(s,now=Date.now()){
  const p=s?.performance;
  if(p?.version!==1)return {status:"not-instrumented"};
  const end=stamp(now),scan=p.scan,check=p.checking;
  const waitTime=w=>nonnegative(w.elapsedMs)+(w.startedAt?
    (ms(w.startedAt,stamp(w.until?
      Math.min(now,Date.parse(w.until)):now))||0):0);
  const recent=p.recent.filter(x=>Date.parse(x.at)>now-15*60000);
  const gets=recent.reduce((n,x)=>n+nonnegative(x.gets),0);
  const checked=recent.reduce((n,x)=>n+nonnegative(x.checked),0);
  const windowMinutes=Math.min(15,
    Math.max(1,(now-Date.parse(p.measuredFrom))/60000));
  return {status:"recorded",measuredFrom:p.measuredFrom,coverage:p.coverage,
    scan:{...scan,wallMs:scan.startedAt?
      ms(scan.startedAt,scan.finishedAt||end):null},
    checking:{...check,wallMs:check.startedAt?
      ms(check.startedAt,check.finishedAt||end):null},
    provider:{...p.provider,meanFetchMs:p.provider.gets?
      Math.round(p.provider.fetchMs/p.provider.gets):null},
    rateLimit:{events:p.waiting.rateLimit.events,
      waitMs:waitTime(p.waiting.rateLimit),
      activeUntil:p.waiting.rateLimit.startedAt?
        p.waiting.rateLimit.until:null},
    dailyBudget:{events:p.waiting.dailyBudget.events,
      waitMs:waitTime(p.waiting.dailyBudget),
      blockedTicks:p.waiting.budgetBlockedTicks,
      lastUsed:p.budget.used,lastLimit:p.budget.limit,observedAt:p.budget.at},
    last15Minutes:{gets,checked,
      getsPerMinute:Number((gets/windowMinutes).toFixed(2))},
    note:"Measured only from measuredFrom. Scan wall time includes Cron gaps; scan activeMs covers R2 index/queue processing. HTTP fetchMs ends at response headers; bodyMs covers response reading/large-body storage. Quota usage is the last observed snapshot."};
}
