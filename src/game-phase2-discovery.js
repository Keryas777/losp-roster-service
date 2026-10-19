// Scopely OpenAPI beta 0.2.1: GET-only relationships and finite parameters.
// Produces tasks, never makes requests, and never consumes player information.
export const EPISODIC_TYPES=Object.freeze([
  "campaign","eventCampaign","challenge","flashEvent","unlockEvent","otherEvent"
]);
const BASE="/game/v1/";
const ID=/^[A-Za-z0-9:_-]{1,200}$/;
const valid=v=>(typeof v==="string"||typeof v==="number")&&ID.test(String(v))
  ?encodeURIComponent(String(v)):null;
const detail=(path,root="phase2")=>({path,root,mode:"detail"});
const listing=path=>({path,root:"phase2",mode:"list",page:1,perPage:100});
export const phase2RootTasks=()=>EPISODIC_TYPES.map(type=>
  listing(BASE+"episodics/"+type));
// Only documented URL shapes. All dynamic segments must come from actual
// provider data, not from guessing numerical ranges of unrelated resources.
export function discoverGamePhase2(sourcePath,body){
  if(!sourcePath.startsWith(BASE)||!body||typeof body!=="object")return [];
  const path=sourcePath.split("?")[0],result=new Map();
  const add=task=>{if(task.path.length<1000)result.set(task.path,task);};
  const episode=path.match(/^\/game\/v1\/episodics\/(campaign|eventCampaign|challenge|flashEvent|unlockEvent|otherEvent)(?:\/([A-Za-z0-9:_-]+))?(?:\/(\d+))?(?:\/(\d+))?$/);
  const data=body.data;
  // An episodic collection is a real paginated list, each id is an episodic.
  if(episode&&!episode[2]&&Array.isArray(data))
    for(const row of data){
      const id=valid(row?.id);
      if(id)add(detail(BASE+"episodics/"+episode[1]+"/"+id));
    }
  if(episode&&episode[2]&&episode[3]===undefined&&
     Number.isSafeInteger(data?.numChapters)&&data.numChapters>0){
    for(let chapter=1;chapter<=data.numChapters;chapter++)
      add(detail(path+"/"+chapter));
  }
  if(episode&&episode[3]&&episode[4]===undefined){
    // ChapterInfo is exposed in EpisodicInfo.chapters, indexed by chapter.
    const chapter=data?.chapters?.[episode[3]]||
      data?.chapters?.[Number(episode[3])-1]||data?.chapter;
    const tiers=chapter?.numTiers;
    if(Number.isSafeInteger(tiers)&&tiers>0)
      for(let tier=1;tier<=tiers;tier++)add(detail(path+"/"+tier));
  }
  // Character details already default to full abilities/costumes, but crafting
  // costs are omitted by default. Ask for full values explicitly.
  if(/^\/game\/v1\/characters\/[^/]+$/.test(path)&&
     !sourcePath.includes("?"))
    add(detail(path+"?abilityKits=full&costumes=full&gearTiers=full"+
      "&pieceInfo=full&pieceDirectCost=full&pieceFlatCost=full"));
  if(/^\/game\/v1\/raids\/[^/]+$/.test(path)&&
     !sourcePath.includes("?"))
    add(detail(path+"?raidMap=full&raidRewards=full&raidDiffs=full"));
  const stack=[data],seen=new WeakSet();
  while(stack.length){
    const node=stack.pop();
    if(!node||typeof node!=="object"||seen.has(node))continue;
    seen.add(node);
    if(Array.isArray(node)){for(const value of node)if(value&&typeof value==="object")stack.push(value);continue;}
    const combat=valid(node.combatId);
    if(combat)add(detail(BASE+"nodeCombats/"+combat));
    if(node.itemId!==undefined){
      const id=valid(node.itemId);
      if(id)add(detail(BASE+"items/"+id));
    }
    // "item" is the documented Item subobject within costs/rewards.
    // An unrelated entity's "id" must never be treated as an item ID.
    for(const key of ["item","energy"]){
      const item=node[key];
      const id=valid(item?.id);
      if(id){
        add(detail(BASE+"items/"+id));
        if(item.isOrb===true)add(detail(BASE+"orbRewards/"+id));
      }
    }
    if(path.startsWith(BASE+"items/")&&node===data){
      const id=valid(data?.id);
      if(id){
        if(data.isOrb===true)add(detail(BASE+"orbRewards/"+id));
        if(!path.endsWith("/characters"))
          add(listing(BASE+"items/"+id+"/characters?charInfo=full"));
      }
    }
    // EventInfo.episodic has a documented type and id/ids relationship.
    if(node.episodic&&typeof node.episodic==="object"){
      const event=node.episodic,kind=event.type;
      if(EPISODIC_TYPES.includes(kind)){
        const ids=[...(Array.isArray(event.ids)?event.ids:[]),event.id];
        for(const raw of ids){
          const id=valid(raw);
          if(id)add(detail(BASE+"episodics/"+kind+"/"+id));
        }
      }
    }
    for(const v of Object.values(node))if(v&&typeof v==="object")stack.push(v);
  }
  return [...result.values()];
}
