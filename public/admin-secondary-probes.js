// Admin-only controls. Every request passes through the existing authorized
// allowlist; the UI sends only a literal ID, never a URL or a player token.
const secondarySelect=document.getElementById("msf-secondary-source");
const secondaryButton=document.getElementById("msf-secondary-probe");
const secondaryResult=document.getElementById("msf-secondary-result");
const secondaryBatch=document.getElementById("msf-secondary-batch");
const secondaryBatchStatus=document.getElementById("msf-secondary-batch-status");
const secondaryBatchResults=document.getElementById("msf-secondary-batch-results");
const secondaryAlreadyConfirmed=new Set(["get-character-list","get-localization-heroes"]);
let secondaryBusy=false;
function secondarySetBusy(value){
  secondaryBusy=value;
  secondaryButton.disabled=value;
  secondarySelect.disabled=value;
  if(secondaryBatch)secondaryBatch.disabled=value;
}
async function secondaryProbe(id){
  const response=await fetch("/admin/api/msf-secondary-probe",{
    method:"POST",credentials:"same-origin",cache:"no-store",
    headers:{"Content-Type":"application/json",Accept:"application/json"},
    body:JSON.stringify({id})
  });
  if(!response.ok)throw Error("worker-http-"+response.status);
  const result=await response.json();
  if(!result||typeof result.status!=="string")throw Error("invalid-result");
  return result;
}
function secondarySummary(id,result){
  const http=result.httpStatus==null?"inconnu":String(result.httpStatus);
  const bytes=Number.isSafeInteger(result.bytes)?
    result.bytes.toLocaleString("fr-FR"):"non archivé";
  const wait=Number.isFinite(result.retryAfterSeconds)?
    " Prochain test dans "+Math.ceil(result.retryAfterSeconds/60)+" min.":"";
  return id+" : "+result.status+". HTTP : "+http+". Octets : "+bytes+"."+wait;
}
if(secondarySelect&&secondaryButton&&secondaryResult){
  secondaryButton.addEventListener("click",async()=>{
    if(secondaryBusy)return;
    const id=secondarySelect.value;
    secondarySetBusy(true);
    secondaryResult.textContent="Lecture d’un service complémentaire, une seule requête…";
    try{
      const result=await secondaryProbe(id);
      secondaryResult.textContent=secondarySummary(id,result)+
        " Aucun jeton joueur transmis. Archives R2 privées uniquement.";
    }catch(err){
      secondaryResult.textContent="Échec du test : "+
        (err instanceof Error?err.message:"unavailable")+
        ". Consulter les journaux Cloudflare en cas de problème.";
    }finally{secondarySetBusy(false);}
  });
}
if(secondarySelect&&secondaryButton&&secondaryBatch&&
    secondaryBatchStatus&&secondaryBatchResults){
  secondaryBatch.addEventListener("click",async()=>{
    if(secondaryBusy)return;
    // Two endpoints have already returned HTTP 200 and are archived.
    // Other IDs are sourced only from the server-rendered allowlist.
    const ids=Array.from(secondarySelect.options,o=>o.value)
      .filter(id=>!secondaryAlreadyConfirmed.has(id));
    secondarySetBusy(true);
    secondaryBatchResults.replaceChildren();
    let done=0,archived=0,stopped=false;
    secondaryBatchStatus.textContent=
      "Audit de "+ids.length+" services : conserve cette page ouverte…";
    try{
      for(const id of ids){
        secondaryBatchStatus.textContent="Service "+(done+1)+"/"+ids.length+
          " : "+id+". Page à laisser ouverte.";
        let result;
        try{result=await secondaryProbe(id);}
        catch(err){
          const item=document.createElement("p");
          item.textContent=id+" : requête interrompue ("+
            (err instanceof Error?err.message:"network-error")+").";
          secondaryBatchResults.appendChild(item);
          stopped=true;
          break; // Don't continue on network / admin-session errors.
        }
        done++;
        if(result.status==="archived")archived++;
        const item=document.createElement("p");
        item.textContent=secondarySummary(id,result);
        secondaryBatchResults.appendChild(item);
        if(result.status==="rate-limited"||result.httpStatus===429){
          stopped=true;break; // Do not hammer Scopely after 429.
        }
      }
    }finally{
      secondarySetBusy(false);
      secondaryBatchStatus.textContent=
        "Audit : "+done+"/"+ids.length+" services examinés, "+
        archived+" archivés."+(stopped?
          " Arrêt anticipé (erreur ou limitation) ; relancer pour réessayer plus tard.":" Terminé.")+
        " Aucun jeton joueur transmis ; résultats dans R2 privé.";
    }
  });
}
