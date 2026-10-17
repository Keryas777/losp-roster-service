// Separate, encrypted long-lived captain grants. Legacy 24h session-vault.js
// remains untouched. Only opaque, SHA-256 derived R2 keys are used.
export const CAPTAIN_PREFIX = "oauth-captains/v1/";
const encoder = new TextEncoder(), decoder = new TextDecoder();
const ID = /^[A-Za-z0-9_-]{43}$/;
const KEY = /^oauth-captains\/v1\/[a-f0-9]{64}$/;
export const CAPTAIN_MAX_AGE = 365 * 86400000;
export const CAPTAIN_COOKIE_AGE = 180 * 86400;
const TOKEN = value => typeof value === "string" && value.length > 0 && value.length <= 16384;
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
function fromB64(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]+$/.test(s)) throw Error("Invalid envelope");
  const raw=atob(s.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-s.length%4)%4));
  return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
function hexBytes(value) {
  if(typeof value!=="string" || !/^[a-fA-F0-9]{64}$/.test(value)) throw Error("Missing encryption key");
  return Uint8Array.from(value.match(/../g),chunk=>parseInt(chunk,16));
}
async function aes(hex) {
  return crypto.subtle.importKey("raw",hexBytes(hex),"AES-GCM",false,["encrypt","decrypt"]);
}
export function newCaptainSessionId() {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}
export async function captainSessionKey(id) {
  if(!ID.test(id || "")) throw Error("Invalid session id");
  const hash=new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(id)));
  return CAPTAIN_PREFIX + Array.from(hash,b=>b.toString(16).padStart(2,"0")).join("");
}
export function validCaptainKey(key) { return KEY.test(key || ""); }
export function captainConfigReady(env) {
  return env?.CAPTAIN_SESSIONS_ENABLED==="true" &&
    typeof env.CAPTAIN_ENCRYPTION_KEY_HEX==="string" &&
    /^[a-fA-F0-9]{64}$/.test(env.CAPTAIN_ENCRYPTION_KEY_HEX) &&
    !!env.CAPTAIN_BUCKET?.put && !!env.CAPTAIN_BUCKET?.get &&
    !!env.CAPTAIN_BUCKET?.delete && !!env.CAPTAIN_REFRESH_COORDINATOR?.idFromName;
}
export function validateCaptainRecord(record, now=Date.now()) {
  if(!record || record.version!==2 || !Number.isSafeInteger(record.createdAt) ||
    !Number.isSafeInteger(record.expiresAt) || record.expiresAt<=record.createdAt ||
    record.expiresAt-record.createdAt>CAPTAIN_MAX_AGE+1000 ||
    !Number.isSafeInteger(record.accessExpiresAt) ||
    !TOKEN(record.accessToken) || !TOKEN(record.refreshToken) ||
    typeof record.scope!=="string" || record.scope.length>2000 ||
    !record.scope.split(/\s+/).includes("offline") ||
    !record.scope.split(/\s+/).includes("m3p.f.ar.ros")) throw Error("Invalid captain record");
  return record.expiresAt > now;
}
export async function putCaptainRecord(bucket,secret,key,record) {
  if(!validCaptainKey(key) || !bucket?.put) throw Error("Invalid captain storage");
  if(!validateCaptainRecord(record)) throw Error("Expired captain record");
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=new Uint8Array(await crypto.subtle.encrypt({
    name:"AES-GCM",iv,additionalData:encoder.encode(key)
  },await aes(secret),encoder.encode(JSON.stringify(record))));
  await bucket.put(key,JSON.stringify({version:2,iv:b64(iv),data:b64(encrypted)}));
}
export async function getCaptainRecord(bucket,secret,key,now=Date.now()) {
  if(!validCaptainKey(key) || !bucket?.get) throw Error("Invalid captain storage");
  const object=await bucket.get(key);
  if(!object)return null;
  try{
    const env=JSON.parse(await object.text());
    if(env.version!==2)throw Error("Invalid version");
    const iv=fromB64(env.iv),data=fromB64(env.data);
    if(iv.length!==12 || data.length<17 || data.length>150000)throw Error("Invalid envelope");
    const plain=await crypto.subtle.decrypt({
      name:"AES-GCM",iv,additionalData:encoder.encode(key)
    },await aes(secret),data);
    const record=JSON.parse(decoder.decode(plain));
    if(!validateCaptainRecord(record,now))return null;
    return record;
  }catch{
    // Never delete potentially valid data on wrong key or corruption.
    return null;
  }
}
export async function deleteCaptainRecord(bucket,key) {
  if(!validCaptainKey(key) || !bucket?.delete)throw Error("Invalid captain storage");
  await bucket.delete(key);
}
