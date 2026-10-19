// Admin-only controls; never inject untrusted provider text as HTML.
const secondarySelect=document.getElementById("msf-secondary-source");
const secondaryButton=document.getElementById("msf-secondary-probe");
const secondaryResult=document.getElementById("msf-secondary-result");
if(secondarySelect&&secondaryButton&&secondaryResult){
  secondaryButton.addEventListener("click",async()=>{
    const id=secondarySelect.value;
    secondaryButton.disabled=true;
    secondaryResult.textContent="Lecture d’un service complémentaire, une seule requête…";
    try{
      const response=await fetch("/admin/api/msf-secondary-probe",{
        method:"POST",credentials:"same-origin",cache:"no-store",
        headers:{"Content-Type":"application/json",Accept:"application/json"},
        body:JSON.stringify({id})
      });
      const result=await response.json();
      if(!response.ok)throw Error(result.status||"http-error");
      const status=typeof result.status==="string"?result.status:"unavailable";
      const http=result.httpStatus==null?"inconnu":String(result.httpStatus);
      const bytes=Number.isSafeInteger(result.bytes)?result.bytes.toLocaleString("fr-FR"):"non archivé";
      const wait=Number.isFinite(result.retryAfterSeconds)?
        " Prochain test dans "+Math.ceil(result.retryAfterSeconds/60)+" min.":"";
      secondaryResult.textContent=id+" : "+status+
        ". HTTP : "+http+". Octets : "+bytes+"."+wait+
        " Aucun jeton joueur transmis. Archives R2 privées uniquement.";
    }catch(err){
      secondaryResult.textContent="Échec du test : "+
        (err instanceof Error?err.message:"unavailable")+
        ". Consulter les journaux Cloudflare en cas de problème.";
    }finally{secondaryButton.disabled=false;}
  });
}
