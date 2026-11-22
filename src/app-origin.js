export const PRODUCTION_ORIGIN="https://losp-roster-service.deliriousfan7.workers.dev";
export const PERSONAL_EVENT_LAB_ORIGIN="https://losp-personal-event-lab.deliriousfan7.workers.dev";

// Pin the temporary OAuth redirect to one reviewed hostname. Never derive an
// OAuth redirect from Host, forwarded headers, or an arbitrary environment URL.
export function appOrigin(env){
  if(env?.PERSONAL_EVENT_LAB_MODE==="true")
    return env.LOSP_APP_ORIGIN===PERSONAL_EVENT_LAB_ORIGIN?PERSONAL_EVENT_LAB_ORIGIN:null;
  return PRODUCTION_ORIGIN;
}
