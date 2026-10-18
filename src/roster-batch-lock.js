// Alliance-scoped Durable Object lease: prevents overlapping manual R2 batches.
// Only random lease IDs and deadlines are stored, never tokens or roster data.
const headers={"Cache-Control":"no-store"};
const answer=(data,status=200)=>Response.json(data,{status,headers});
const LEASE_MS=8*60_000;
const FP=/^[0-9a-f]{64}$/;
const HOLDER=/^[0-9a-f-]{36}$/;

export class RosterBatchLock {
  constructor(ctx){this.ctx=ctx;this.queue=Promise.resolve();}
  async fetch(request){
    if(request.method!=="POST")return answer({status:"invalid"},405);
    let value;
    try{value=await request.json();}catch{return answer({status:"invalid"},400);}
    if(!FP.test(value?.fingerprint)||!HOLDER.test(value?.holder)||
       !["acquire","release"].includes(value.action))
      return answer({status:"invalid"},400);
    const task=()=>this.dispatch(value);
    const current=this.queue.then(task,task);
    this.queue=current.then(()=>undefined,()=>undefined);
    return current.catch(()=>answer({status:"unavailable"},503));
  }
  async dispatch({action,fingerprint,holder}){
    const now=Date.now(),storage=this.ctx.storage;
    const current=await storage.get("lease");
    if(action==="release"){
      if(current?.holder===holder&&current?.fingerprint===fingerprint)
        await storage.delete("lease");
      return answer({status:"released"});
    }
    if(current&&current.expiresAt>now)
      return answer({status:"busy"},409);
    await storage.put("lease",{fingerprint,holder,expiresAt:now+LEASE_MS});
    return answer({status:"acquired"});
  }
}
