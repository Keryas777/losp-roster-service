// Scopely OpenAPI beta 0.2.1, GET /game/v1/characters/{characterId}.
// Only split a genuine character detail refused with HTTP 472.
// Distinct archived responses remain raw, not stitched into a fake "full" JSON.
const DETAIL=/^\/game\/v1\/characters\/([A-Za-z0-9:_-]{1,200})(?:\?.*)?$/;
const FIELDS=["abilityKits","costumes","gearTiers","pieceInfo",
  "pieceDirectCost","pieceFlatCost"];
const standard={abilityKits:"none",costumes:"none",gearTiers:"none",
  pieceInfo:"none",pieceDirectCost:"none",pieceFlatCost:"none"};
const query=overrides=>new URLSearchParams(
  Object.entries({...standard,...overrides})).toString();
const task=(base,source,part,overrides)=>({
  path:base+"?"+query(overrides),root:"phase2",mode:"detail",
  recoveryOf:source,recoveryPart:part
});
export function characterRecoveryTasks(sourcePath){
  if(typeof sourcePath!=="string"||sourcePath.length>900)return [];
  const match=DETAIL.exec(sourcePath);
  if(!match||sourcePath.includes("%")||sourcePath.includes("#"))return [];
  const base="/game/v1/characters/"+match[1],out=[];
  // If the default detail itself was refused, also try a minimal identity
  // response; if the refusal was for an expanded variant, base is already
  // archived by the phase-two discovery process.
  if(!sourcePath.includes("?"))out.push(task(base,sourcePath,"identity",{}));
  out.push(task(base,sourcePath,"abilities",{abilityKits:"full"}));
  out.push(task(base,sourcePath,"costumes",{costumes:"full"}));
  out.push(task(base,sourcePath,"gear",{gearTiers:"full",pieceInfo:"full"}));
  out.push(task(base,sourcePath,"direct-cost",{
    gearTiers:"full",pieceDirectCost:"full"
  }));
  out.push(task(base,sourcePath,"flat-cost",{
    gearTiers:"full",pieceFlatCost:"full"
  }));
  return out;
}
export function splitFailedAbilities(taskInfo){
  if(taskInfo?.recoveryPart!=="abilities"||
     !DETAIL.test(taskInfo.path)||!taskInfo.recoveryOf)return [];
  const base=taskInfo.path.split("?")[0];
  // Each value is enumerated by Scopely for abilityKits.
  return ["basic","special","ultimate","passive"].map(part=>
    task(base,taskInfo.recoveryOf,"ability-"+part,{abilityKits:part}));
}
export const isItemCharacterAssociation=path=>
  typeof path==="string"&&
  /^\/game\/v1\/items\/[A-Za-z0-9:_-]{1,200}\/characters(?:\?|$)/.test(path);
