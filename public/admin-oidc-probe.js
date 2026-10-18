// Read-only, one-click OIDC subject investigation for the connected MSF account.
// No tokens or opaque subject values are exposed, and no PID is sent upstream.
const oidcEl=id=>document.getElementById(id);
async function checkOidcIdentity(){
  const button=oidcEl("oidc-probe"),status=oidcEl("oidc-status"),
    target=oidcEl("oidc-result");
  target.replaceChildren();
  const selected=oidcEl("session")?.value;
  if(!selected||!/^[a-f0-9]{64}$/.test(selected)){
    status.textContent="Sélectionne d'abord un compte OAuth dans Explorer.";
    return;
  }
  const selectedLabel=oidcEl("session")?.selectedOptions?.[0]?.textContent||"compte sélectionné";
  button.disabled=true;
  status.textContent="Vérification ponctuelle de l'identité OAuth…";
  try{
    const response=await fetch("/admin/api/oidc-identity?session="+
      encodeURIComponent(selected),{
        credentials:"same-origin",cache:"no-store",headers:{Accept:"application/json"}
      });
    const report=await response.json();
    if(!response.ok)throw Error("Le diagnostic OAuth n'est pas disponible.");
    if(selected!==oidcEl("session")?.value){
      status.textContent="Compte modifié pendant la requête ; recommence.";
      return;
    }
    const p=document.createElement("p");
    if(report.status==="ok"&&report.subjectType==="numeric-candidate"){
      p.textContent="Sujet OAuth numérique candidat : "+report.numericCandidate+
        ". Compare-le uniquement avec le PID EN JEU du compte OAuth "+
        "sélectionné, et non celui d'un coéquipier. La correspondance "+
        "éventuelle reste à confirmer sur un second compte.";
    }else if(report.status==="ok"&&report.subjectType==="opaque"){
      p.textContent="Le sujet OAuth est opaque/non numérique. Sa valeur "+
        "n'est pas divulguée ; aucune correspondance PID ne peut être "+
        "établie depuis cette réponse.";
    }else if(report.status==="not-supported"){
      p.textContent="Le fournisseur ne propose pas la route OIDC /userinfo "+
        "à cette adresse. Cela ne prouve pas que le PID soit inaccessible ailleurs.";
    }else{
      p.textContent="Résultat OIDC : "+(report.status||"indisponible")+
        ". Ce test n'établit aucune correspondance PID.";
    }
    target.appendChild(p);
    status.textContent="Compte vérifié : "+selectedLabel+
      ". Aucun jeton, PID saisi ni réponse OAuth brute n'a été enregistré.";
  }catch{
    status.textContent="Diagnostic OIDC indisponible, sans conséquence sur la session.";
  }finally{button.disabled=false;}
}
oidcEl("oidc-probe").addEventListener("click",checkOidcIdentity);
