import {webcrypto} from "node:crypto";

export const ACCESS_DOMAIN="planner-test.cloudflareaccess.com";
export const ACCESS_AUD="a".repeat(32);
export const ACCESS_OWNER="owner@example.test";
export const ACCESS_OTHER_ADMIN="other-admin@example.test";
const b64=value=>Buffer.from(typeof value==="string"?value:JSON.stringify(value)).toString("base64url");
let pair,jwk;
export async function accessJwt(email=ACCESS_OWNER){
  if(!pair){
    pair=await webcrypto.subtle.generateKey({name:"RSASSA-PKCS1-v1_5",modulusLength:2048,
      publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"},true,["sign","verify"]);
    jwk=await webcrypto.subtle.exportKey("jwk",pair.publicKey);
    jwk.kid="planner-test-key";jwk.alg="RS256";jwk.use="sig";
  }
  const header=b64({alg:"RS256",kid:jwk.kid,typ:"JWT"});
  const claims=b64({iss:"https://"+ACCESS_DOMAIN,aud:[ACCESS_AUD],email,
    iat:Math.floor(Date.now()/1000)-1,exp:Math.floor(Date.now()/1000)+300});
  const signature=await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5",pair.privateKey,
    new TextEncoder().encode(header+"."+claims));
  return header+"."+claims+"."+Buffer.from(signature).toString("base64url");
}
export function accessFetch(upstream=async()=>{throw Error("unexpected external request");}){
  return async(input,init)=>{
    const url=typeof input==="string"?input:input.url;
    if(url==="https://"+ACCESS_DOMAIN+"/cdn-cgi/access/certs"){
      if(!jwk)throw Error("create an Access JWT before requesting JWKS");
      return Response.json({keys:[jwk]});
    }
    return upstream(input,init);
  };
}
