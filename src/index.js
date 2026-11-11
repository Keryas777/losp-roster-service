import { handleCallback, handleOAuthStatus } from "./oauth-callback.js";
import { getAllianceScopeProbe, allianceScopeRequest } from "./alliance-scope-probes.js";
import { CAPTAIN_SCOPES } from "./captain-scopes.js";
import { captainConfigReady } from "./captain-vault.js";
import { handleCaptainSession, handleCaptainLogout, handleCaptainLanding, handleCaptainRosters, handleCaptainCoverage, renewCaptainGrants } from "./captain-session-routes.js";
export { CaptainRefreshCoordinator } from "./captain-refresh-coordinator.js";
export { RosterBatchLock } from "./roster-batch-lock.js";
import { buildPrivateCoverage } from "./alliance-coverage.js";
import { handleAdmin } from "./admin-routes.js";
import { prunePrivateRosterPilots } from "./private-roster-pilot.js";
import { ROSTER_CRON, runRosterAutoTick } from "./automatic-roster-scheduler.js";
import {runRosterRecoveryTick} from "./roster-auto-recovery.js";
import {runGuestInitialSyncTick} from "./guest-initial-sync.js";
import {runMemberInfoAutoTick} from "./member-info-scheduler.js";
import {runRewardInfoAutoTick} from "./member-info-reward.js";
import {publicArenaHistory,publicArenaSnapshot,archiveArenaHistory,archiveArenaHistoryWhenReady} from "./public-arena-history.js";
import {secureGuestArenaHistory} from "./secure-guest-arena-history.js";
import {secureGuestInfos} from "./secure-guest-infos.js";
import {secureGuestRosters} from "./secure-guest-rosters.js";
import {handleSelfPlayerLinks} from "./player-identity-links.js";
import {secureGuestEvolution,archiveGuestEvolutionTick} from "./secure-guest-evolution.js";
import {securePermanentGuestEvolution,archivePermanentGuestEvolutionTick} from "./permanent-guest-evolution.js";
import {publicTrophyHistory,archiveTrophyHistory,recoverPreviousSaturdayGuestTrophies} from "./public-trophy-history.js";
import {publicGuestSeasonRanks} from "./public-guest-season-ranks.js";
import {GAME_ARCHIVE_CRON,runGameArchiveTick} from "./game-catalog-archive.js";
import {runGameArchiveSchemaAuditTick} from "./game-archive-schema-audit.js";
import {runGameMaterialAuditTick} from "./game-material-audit.js";
import {publicAwakenedMaterials} from "./awakened-material-catalog.js";
import {publicEvents} from "./public-events.js";
import {runGameOrphanAuditTick} from "./game-archive-orphan-audit.js";
import {runGameProvenanceReconcileTick} from "./game-archive-provenance-reconcile.js";
import {runPlayerCampaignTick} from "./player-campaign.js";
import {runGameDifferentialTick} from "./game-differential-sync.js";
import {runGameDailyEventsTick} from "./game-events-daily.js";
import {dispatchGameEventsToGithub} from "./game-events-github-dispatch.js";
import {runGameDifferentialFailureAuditTick} from "./game-differential-failure-audit.js";
import {runGameDifferentialComparisonAuditTick} from "./game-differential-comparison-audit.js";
import {handleAllianceSeasonRanks} from "./alliance-season-ranks.js";

const SCOPELY_AUTH_URL = "https://hydra-public.prod.m3.scopelypv.com/oauth2/auth";
const APP_ORIGIN = "https://losp-roster-service.deliriousfan7.workers.dev";
const REDIRECT_URI = APP_ORIGIN + "/oauth/callback";
const LOGIN_SCOPES = "openid m3p.f.pr.pro";
const LOGIN_COOKIE_AGE_SECONDS = 600;

function randomBase64Url(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return btoa(String.fromCharCode(...value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function sha256Base64Url(value) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function startLogin(request, env, url) {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET", "Cache-Control": "no-store" }
    });
  }

  // The OAuth callback is registered for this production hostname only.
  // Do not initiate production OAuth from preview URLs or forwarded hosts.
  if (url.origin !== APP_ORIGIN) {
    return new Response("Not Found", { status: 404 });
  }

  if (url.pathname === "/login/captain" && env?.CAPTAIN_SESSIONS_ENABLED === "true" &&
      !captainConfigReady(env)) {
    return new Response("Captain session storage is not configured", {
      status: 503, headers: { "Cache-Control": "no-store" }
    });
  }
  const clientId = env?.SCOPELY_CLIENT_ID;
  if (typeof clientId !== "string" || !clientId.trim()) {
    return new Response("OAuth is not configured", {
      status: 503,
      headers: { "Cache-Control": "no-store" }
    });
  }

  if (url.pathname === "/login/captain" && captainConfigReady(env)) {
    // A returning captain must not be sent through the emailed-code OAuth flow.
    const status=await handleCaptainSession(request,env);
    if(status.ok) {
      const previous=await status.json();
      if(previous.status==="connected"){
        const redirect=Response.redirect(APP_ORIGIN+"/captain",302);
        // Extend the sliding browser lease only when the Worker confirmed
        // the opaque session. No token is ever sent to the browser.
        const headers=new Headers(redirect.headers);
        for(const cookie of status.headers.getSetCookie())headers.append("Set-Cookie",cookie);
        headers.set("Cache-Control","no-store");
        return new Response(null,{status:302,headers});
      }
      if(previous.status==="temporarily-unavailable")
        return new Response("Connexion temporairement indisponible : réessayer plus tard",{
          status:503,headers:{"Cache-Control":"no-store"}
        });
    } else {
      return new Response("Vérification de session indisponible : réessayer plus tard",{
        status:503,headers:{"Cache-Control":"no-store"}
      });
    }
  }

  const state = randomBase64Url();
  const codeVerifier = randomBase64Url();
  const codeChallenge = await sha256Base64Url(codeVerifier);

  const authorize = new URL(SCOPELY_AUTH_URL);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId.trim());
  authorize.searchParams.set("redirect_uri", REDIRECT_URI);
  const profilesProbe = url.pathname === "/login/profiles-test";
  const coverageProbe = url.pathname === "/login/coverage-test";
  const cardTypesProbe = url.pathname === "/login/card-types-test";
  const metricsProbe = url.pathname === "/login/metrics-test";
  const isoIconsProbe = url.pathname === "/login/iso-icons-test";
  const inventoryProbe = url.pathname === "/login/inventory-test";
  const rosterScopeProbe = url.pathname === "/login/roster-scope-test";
  const allianceScopeProbe = url.pathname === "/login/alliance-scope-test";
  const collectionProbe = url.pathname === "/login/alliance-collection-test";
  const rosterViewerMode = url.pathname === "/login/rosters";
  const captainMode = url.pathname === "/login/captain";
  const scopeProbe = getAllianceScopeProbe(url.pathname);
  const allianceProbe = url.pathname === "/login/alliance-test" || rosterScopeProbe;
  const scopes = allianceProbe || allianceScopeProbe || collectionProbe || rosterViewerMode || profilesProbe || coverageProbe || cardTypesProbe || metricsProbe
    ? LOGIN_SCOPES + " m3p.f.ar.pro" : LOGIN_SCOPES;
  authorize.searchParams.set("scope", captainMode ? CAPTAIN_SCOPES :
    scopeProbe ? allianceScopeRequest(scopeProbe) :
    inventoryProbe ? LOGIN_SCOPES + " m3p.f.pr.inv" :
    (allianceScopeProbe || collectionProbe || rosterViewerMode) ? scopes + " m3p.f.ar.ros" :
    rosterScopeProbe ? scopes + " m3p.f.pr.ros" : scopes);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", codeChallenge);
  authorize.searchParams.set("code_challenge_method", "S256");

  // Short-lived, host-only cookies for the future callback's validation.
  // They are not OAuth access tokens and contain no client secret.
  const headers = new Headers({
    Location: authorize.toString(),
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex"
  });
  const attributes = "Max-Age=" + LOGIN_COOKIE_AGE_SECONDS +
    "; Path=/; Secure; HttpOnly; SameSite=Lax";
  headers.append("Set-Cookie", "__Host-losp_oauth_state=" + state + "; " + attributes);
  headers.append("Set-Cookie", "__Host-losp_oauth_verifier=" + codeVerifier + "; " + attributes);
  if (allianceProbe) headers.append("Set-Cookie", "__Host-losp_oauth_alliance_test=" + state + "; " + attributes);
  if (rosterScopeProbe) headers.append("Set-Cookie", "__Host-losp_oauth_roster_scope_test=" + state + "; " + attributes);
  if (allianceScopeProbe) headers.append("Set-Cookie", "__Host-losp_oauth_alliance_scope_test=" + state + "; " + attributes);
  if (collectionProbe) headers.append("Set-Cookie", "__Host-losp_oauth_collection_test=" + state + "; " + attributes);
  if (rosterViewerMode) headers.append("Set-Cookie", "__Host-losp_oauth_roster_viewer=" + state + "; " + attributes);
  if (captainMode) headers.append("Set-Cookie", "__Host-losp_oauth_captain=" + state + "; " + attributes);
  if (scopeProbe) headers.append("Set-Cookie", scopeProbe.cookie + "=" + state + "; " + attributes);
  if (inventoryProbe) headers.append("Set-Cookie", "__Host-losp_oauth_inventory_test=" + state + "; " + attributes);
  if (profilesProbe) headers.append("Set-Cookie", "__Host-losp_oauth_profiles_test=" + state + "; " + attributes);
  if (coverageProbe) headers.append("Set-Cookie", "__Host-losp_oauth_coverage_test=" + state + "; " + attributes);
  if (cardTypesProbe) headers.append("Set-Cookie", "__Host-losp_oauth_card_types_test=" + state + "; " + attributes);
  if (metricsProbe) headers.append("Set-Cookie", "__Host-losp_oauth_metrics_test=" + state + "; " + attributes);
  if (isoIconsProbe) headers.append("Set-Cookie", "__Host-losp_oauth_iso_icons_test=" + state + "; " + attributes);
  return new Response(null, { status: 302, headers });
}

export default {
  async scheduled(controller, env) {
    // Reuse the existing every-minute Cloudflare trigger; no extra cron.
    // Paris local 00:10, 03:10, ..., 21:10, including DST changes.
    if(controller?.cron==="* * * * *"){
      // Independent member-card collection, not part of the roster's GET budget.
      const info=await runMemberInfoAutoTick(env,controller.scheduledTime);
      if(!["disabled","outside-window","complete"].includes(info.status))
        console.info("member-info-cron",JSON.stringify({
          status:info.status,requests:info.requests||0,
          ...(info.members?{members:info.members}:{})
        }));
      // Separate, reward-time only: existing AM/PM Info runs unchanged.
      const reward=await runRewardInfoAutoTick(env,controller.scheduledTime);
      if(!["disabled","outside-window","complete"].includes(reward.status))
        console.info("member-info-reward-cron",JSON.stringify({
          status:reward.status,requests:reward.requests||0,
          ...(reward.members?{members:reward.members}:{})
        }));
      const scheduled=controller.scheduledTime;
      const slot=new Date(scheduled);
      const parts=Object.fromEntries(new Intl.DateTimeFormat("en-GB",{
        timeZone:"Europe/Paris",hour:"2-digit",minute:"2-digit",hourCycle:"h23"
      }).formatToParts(slot).filter(p=>p.type==="hour"||p.type==="minute")
        .map(p=>[p.type,Number(p.value)]));
      // When the existing 17:01 collector is quiet, persist genuine R2
      // receipts immediately. After its 17:30 window, retry R2-only every
      // five minutes (including after a late deploy) until the fallback.
      // Never stack archive reads on a tick that just used Scopely GETs.
      const quietReward=reward.status==="complete"&&!(reward.requests>0);
      const utcHour=slot.getUTCHours(),utcMinute=slot.getUTCMinutes();
      const afterWindow=reward.status==="outside-window"&&utcHour>=16&&
        (utcHour>16||utcMinute>=31)&&utcMinute%5===0;
      if(quietReward||afterWindow){
        try{
          const ready=await archiveArenaHistoryWhenReady(env,scheduled);
          if(["updated","unavailable","awaiting-receipts"].includes(ready.status)||
             ["updated","unavailable","awaiting-receipts"].includes(ready.guestStatus))
            console.info("arena-history-ready",JSON.stringify(ready));
          const scopesReady=["updated","unchanged"].includes(ready.status)&&
            (!ready.guestStatus||["updated","unchanged"].includes(ready.guestStatus));
          if(scopesReady){
            const day=slot.toISOString().slice(0,10);
            const key="automation/arena-github-dispatch/"+day+".json";
            try{
              const bucket=env?.CAPTAIN_BUCKET,token=env?.ROSTER_GITHUB_DISPATCH_TOKEN;
              if(!bucket?.get||!bucket?.put||typeof token!=="string"||!token)
                throw Error("dispatch-not-configured");
              if(!await bucket.get(key)){
                const response=await fetch(
                  "https://api.github.com/repos/Keryas777/msf/actions/workflows/snapshot-arena.yml/dispatches",{
                    method:"POST",
                    headers:{"Accept":"application/vnd.github+json",
                      "X-GitHub-Api-Version":"2022-11-28",
                      "User-Agent":"LoSP-Roster-Service",
                      "Authorization":"Bearer "+token,
                      "Content-Type":"application/json"},
                    body:JSON.stringify({ref:"main",inputs:{source_date:day}})
                  });
                if(response.status!==204)throw Error("github-http-"+response.status);
                await bucket.put(key,JSON.stringify({version:1,date:day,
                  campaign:day+"-reward",dispatchedAt:new Date().toISOString(),
                  status:"dispatched"}),{httpMetadata:{contentType:"application/json",
                    cacheControl:"private, no-store"}});
                console.info("arena-github-dispatch",JSON.stringify({status:"dispatched",date:day}));
              }
            }catch(error){
              console.warn("arena-github-dispatch",JSON.stringify({status:"retry-pending",
                date:day,reason:String(error?.message||"unavailable")}));
            }
          }
        }catch{
          console.warn("arena-history-ready",JSON.stringify({
            status:"unavailable"}));
        }
      }
      if(parts.minute===10&&parts.hour%3===0){
        try{
          const token=env?.ROSTER_GITHUB_DISPATCH_TOKEN;
          if(typeof token!=="string"||!token)throw Error("token-not-configured");
          const response=await fetch("https://api.github.com/repos/Keryas777/msf/actions/workflows/fetch-characters.yml/dispatches",{
            method:"POST",
            headers:{"Accept":"application/vnd.github+json",
              "X-GitHub-Api-Version":"2022-11-28",
              "User-Agent":"LoSP-Roster-Service",
              "Authorization":"Bearer "+token,
              "Content-Type":"application/json"},
            body:JSON.stringify({ref:"main"})
          });
          console.info("msf-characters-dispatch",JSON.stringify({
            status:response.status===204?"dispatched":"github-unavailable",
            httpStatus:response.status
          }));
        }catch{
          console.warn("msf-characters-dispatch",JSON.stringify({status:"unavailable"}));
        }
      }
      // Weekly LoSP Evolution: dispatch the existing GitHub snapshot workflow.
      // Paris Sunday 23:00, with a bounded 15-minute retry window.
      // Persist the successful dispatch in private R2; never call Scopely.
      if(parts.hour===23 && parts.minute<15 &&
         new Intl.DateTimeFormat("en-US",{timeZone:"Europe/Paris",weekday:"short"}).format(slot)==="Sun"){
        const dateParts=Object.fromEntries(new Intl.DateTimeFormat("en-GB",{
          timeZone:"Europe/Paris",year:"numeric",month:"2-digit",day:"2-digit"
        }).formatToParts(slot).filter(p=>["year","month","day"].includes(p.type))
          .map(p=>[p.type,p.value]));
        const checkpoint=dateParts.year+"-"+dateParts.month+"-"+dateParts.day;
        const key="automation/evolution-weekly-dispatch/"+checkpoint+".json";
        try{
          if(!env?.CAPTAIN_BUCKET?.get||!env?.CAPTAIN_BUCKET?.put)
            throw Error("private-storage-unavailable");
          if(!await env.CAPTAIN_BUCKET.get(key)){
            const token=env?.ROSTER_GITHUB_DISPATCH_TOKEN;
            if(typeof token!=="string"||!token)throw Error("github-token-unavailable");
            const response=await fetch(
              "https://api.github.com/repos/Keryas777/msf/actions/workflows/snapshot-rosters.yml/dispatches",{
                method:"POST",
                headers:{"Accept":"application/vnd.github+json",
                  "X-GitHub-Api-Version":"2022-11-28",
                  "User-Agent":"LoSP-Roster-Service",
                  "Authorization":"Bearer "+token,
                  "Content-Type":"application/json"},
                body:JSON.stringify({ref:"main",inputs:{checkpoint}})
              });
            if(response.status!==204)throw Error("github-http-"+response.status);
            await env.CAPTAIN_BUCKET.put(key,JSON.stringify({
              checkpoint,dispatchedAt:new Date().toISOString(),status:"dispatched"
            }));
            console.info("evolution-weekly-dispatch",JSON.stringify({
              status:"dispatched",checkpoint,scheduledAt:slot.toISOString()
            }));
          }
        }catch(error){
          console.warn("evolution-weekly-dispatch",JSON.stringify({
            status:"retry-pending",checkpoint,reason:String(error?.message||"unavailable")
          }));
        }
      }
      // Guest Evolution uses only existing PRIVATE R2 receipts.
      // One approved tenant per minute; Sunday snapshots and daily TTL rotation.
      // Never delays LoSP roster publication or sends another Scopely GET.
      const guestEvolution=await archiveGuestEvolutionTick(env,scheduled);
      if(!["outside-window","idle","disabled"].includes(guestEvolution.status))
        console.info("guest-evolution-cron",JSON.stringify(guestEvolution));
      // Cumulative WebApp history, separate from temporary R2 receipts.
      // Enabled in wrangler.jsonc: immutable Sunday files + recoverable index.
      // Never queries Scopely; current alliance membership gates API reads.
      if(env?.GUEST_EVOLUTION_LONG_TERM_AUTHORIZED==="true"){
        const archive=await archivePermanentGuestEvolutionTick(env,scheduled);
        if(!["outside-window","unchanged","idle","disabled"].includes(archive.status))
          console.info("guest-evolution-history",JSON.stringify(archive));
      }
      // R2-only scheduled backup at 20:17/22:17 Paris.
      // Ready-to-publish snapshots are already handled after quiet ticks.
      const arenaHistory=await archiveArenaHistory(env,controller.scheduledTime);
      if(!["outside-window","unchanged"].includes(arenaHistory.status)||
         ["updated","unavailable"].includes(arenaHistory.guestStatus))
        console.info("arena-history-cron",JSON.stringify(arenaHistory));
      // Trophy projection is R2-only: use the existing minute Cron, never
      // depend on GitHub Action scheduling or make another Scopely GET.
      // Keep checking after the 02:00-04:00 UTC campaign for late arrivals.
      const utcDay=slot.toISOString().slice(0,10);
      const utcHour=slot.getUTCHours();
      const interval=utcHour<4?5:15;
      if([4,6].includes(slot.getUTCDay())&&utcHour>=2&&utcHour<14&&
         slot.getUTCMinutes()%interval===0){
        try{
          const trophy=await archiveTrophyHistory(env,
            {date:utcDay,campaign:utcDay+"-am"},scheduled);
          if(!["unchanged","awaiting-cards"].includes(trophy.status))
            console.info("trophy-history-cron",JSON.stringify(trophy));
        }catch{
          console.warn("trophy-history-cron",JSON.stringify({status:"unavailable"}));
        }
      }
      // Sunday R2-only repair: incorporate truly captured Saturday guest
      // AllianceCards missed by the early roster-based trophy marker.
      // Retains each source's real time (including late Saturday captures).
      if(slot.getUTCDay()===0&&slot.getUTCMinutes()%15===8){
        try{
          const recovered=await recoverPreviousSaturdayGuestTrophies(env,scheduled);
          if(!["unchanged","no-verified-saturday-captures",
                 "no-bound-guests"].includes(recovered.status))
            console.info("guest-trophies-recovery",JSON.stringify(recovered));
        }catch{
          console.warn("guest-trophies-recovery",
            JSON.stringify({status:"unavailable"}));
        }
      }
      // An approved R2 recovery queue can run while Safari is closed.
      // Skip slots already using Scopely for the independent Info collectors,
      // and the 20:17 / 22:17 Paris arena snapshots. One alliance per tick.
      let recoveryRequests=0;
      if(!(info.requests>0)&&!(reward.requests>0)&&
         !(parts.minute===17&&[20,22].includes(parts.hour))){
        const recovery=await runRosterRecoveryTick(env,controller.scheduledTime);
        recoveryRequests=recovery.requestsThisTick||0;
        if(!["idle","disabled"].includes(recovery.status))
          console.info("roster-recovery-cron",JSON.stringify({
            status:recovery.status,requests:recovery.requestsThisTick||0,
            ...(recovery.githubDispatch?
              {githubDispatch:recovery.githubDispatch}:{})
          }));
      }
      // Guest enrollment is an R2-backed queue, not a detached task.
      // Reuse the existing every-minute Cron after high-priority collectors.
      // Never stack provider GETs on an active Info/reward/recovery tick.
      if(!(info.requests>0)&&!(reward.requests>0)&&!recoveryRequests&&
         !(parts.minute===17&&[20,22].includes(parts.hour))){
        const initial=await runGuestInitialSyncTick(env,scheduled);
        if(!["idle","disabled","cooldown"].includes(initial.status))
          console.info("guest-initial-sync-cron",JSON.stringify({
            status:initial.status,phase:initial.phase||null,
            outcome:initial.lastOutcome||null,requests:initial.requests||0
          }));
      }
    }
    if(controller?.cron===GAME_ARCHIVE_CRON){
      const result=await runGameArchiveTick(env);
      console.info("game-archive-cron",JSON.stringify({
        status:result.status,processed:result.processed||0,
        completedTasks:result.completedTasks||0,
        requestsToday:result.requestsToday||0
      }));
      // The weekly /game differential reuses the primary collector lock and
      // budget, and starts only after the initial archive has completed.
      const differential=await runGameDifferentialTick(env);
      if(!["disabled","up-to-date","awaiting-initial-archive",
        "awaiting-initial-completion","awaiting-phase2"].includes(differential.status))
        console.info("game-differential-cron",JSON.stringify({
          status:differential.status,changed:differential.changed||0,
          unchanged:differential.unchanged||0,failed:differential.failed||0
        }));
      // Daily events: 21:05 UTC (22:05 winter in France), shared lock/budget.
      const dailyEvents=await runGameDailyEventsTick(env);
      if(!["disabled","not-due","up-to-date","cooldown","busy"].includes(dailyEvents.status))
        console.info("game-events-daily-cron",JSON.stringify({
          status:dailyEvents.status,count:dailyEvents.count||0,
          reason:dailyEvents.reason||null
        }));
      // Notify the existing GitHub Actions publisher after a fully committed
      // daily/differential R2 refresh. Retry a missed dispatch every 10 minutes.
      if(dailyEvents.status==="completed"||
         new Date(controller?.scheduledTime||Date.now()).getUTCMinutes()%10===0){
        const published=await dispatchGameEventsToGithub(env);
        if(["dispatched","github-unavailable"].includes(published))
          console.info("game-events-github-dispatch",JSON.stringify({
            status:published
          }));
      }
      // Three /player actions (<= 30 provider GETs) + <= 12 /game GETs
      // fit the SAME Free Worker invocation (< 50 external subrequests).
      // Preserve the existing four cron triggers for the whole account.
      // Each action has its own lock and provider-429 pause.
      for(let action=0;action<3;action++){
        const player=await runPlayerCampaignTick(env);
        if(player.status!=="idle"&&player.status!=="disabled")console.info(
          "player-campaign-cron",JSON.stringify({status:player.status}));
        if(["idle","disabled","up-to-date","awaiting-oauth","cooldown",
          "busy","storage-unavailable","invalid-state","tick-unavailable",
          "complete","partial"].includes(player.status))
          break;
      }
      // Independent R2-only analysis, after the provider collector has run.
      // No Scopely GET, no roster access and no writes to archive receipts.
      const audit=await runGameArchiveSchemaAuditTick(env);
      if(audit.status!=="not-started")console.info("game-schema-audit",JSON.stringify({
        status:audit.status,receiptsListed:audit.receiptsListed||0,
        samples:audit.samples||0
      }));
      // Resumable analysis of existing private R2 JSON, independent of provider GETs.
      const orphanAudit=await runGameOrphanAuditTick(env);
      if(orphanAudit.status!=="not-started")console.info("game-orphan-audit",JSON.stringify({
        status:orphanAudit.status,phase:orphanAudit.phase||null,
        objects:orphanAudit.objects||0,orphaned:orphanAudit.orphaned||0
      }));
      const materials=await runGameMaterialAuditTick(env);
      if(materials.status==="running"||materials.status==="snapshot-complete")
        console.info("game-material-audit-cron",JSON.stringify({
          status:materials.status,listed:materials.listed||0,
          matched:materials.matched||0,distinctIds:materials.distinctIds||0}));
      const provenance=await runGameProvenanceReconcileTick(env);
      if(provenance.status==="running"||provenance.status==="snapshot-complete")
        console.info("game-provenance-cron",JSON.stringify({
          status:provenance.status,phase:provenance.phase||null,
          matched:provenance.matched||0,unresolved:provenance.unresolved||0
        }));
      // R2-only, manually initiated failure audit; independent of /admin tab lifecycle.
      const failureAudit=await runGameDifferentialFailureAuditTick(env);
      if(failureAudit.status==="running"||failureAudit.status==="snapshot-complete")
        console.info("game-differential-failure-audit",JSON.stringify({
          status:failureAudit.status,scanned:failureAudit.scanned||0}));
      // Opt-in R2-only comparison sample; bounded, never calls Scopely.
      const comparison=await runGameDifferentialComparisonAuditTick(env);
      if(comparison.status==="running"||comparison.status==="snapshot-complete")
        console.info("game-diff-comparison-audit",JSON.stringify({
          status:comparison.status,scanned:comparison.scanned||0,
          sampled:comparison.sampled||0
        }));
      return;
    }
    if(controller?.cron===ROSTER_CRON){
      const report=await runRosterAutoTick(env,controller);
      // Aggregate status and request counts only; no roster data, tokens or IDs.
      console.info("roster-auto-cron",JSON.stringify({
        status:report.status,requestsThisTick:report.requestsThisTick||0,
        requestsToday:report.requestsToday||0,
        ...(report.githubDispatch?{githubDispatch:report.githubDispatch}:{})
      }));
      return;
    }
    // Scheduled refresh is disabled unless all private storage bindings exist.
    // No player or roster information is fetched or logged.
    try {
      const result=await renewCaptainGrants(env);
      // Global counts only: never log token values, player names, IDs or grants.
      const report={version:1,checkedAt:new Date().toISOString(),
        status:result.status,checked:result.checked,failed:result.failed||0,
        rotated:result.rotated||0};
      console.info("captain-refresh-cron",JSON.stringify(report));
      if(result.status!=="disabled" && env?.CAPTAIN_BUCKET?.put){
        // One private aggregate record, overwritten on every scheduled check.
        try {await env.CAPTAIN_BUCKET.put("oauth-monitoring/v1/last-refresh-check.json",
          JSON.stringify(report));} catch {}
      }
    } catch {
      console.warn("captain-refresh-cron",JSON.stringify({status:"unavailable"}));
    }
    // Twice daily (03:15 and 15:15 UTC), refresh the private war/raid
    // rankings for APPROVED LoSP alliances only. Uses the existing hourly
    // cron; no fifth Free-tier trigger and no roster/member GET.
    const at=new Date(controller?.scheduledTime||Date.now());
    if(controller?.cron==="15 * * * *"&&[3,15].includes(at.getUTCHours())){
      try{
        const rankRequest=new Request(APP_ORIGIN+"/admin/api/alliance-season-ranks",{
          method:"POST",headers:{Origin:APP_ORIGIN,
            "Content-Type":"application/json"},body:JSON.stringify({action:"capture"})
        });
        const outcome=await handleAllianceSeasonRanks(rankRequest,env,fetch,
          at.getTime());
        const state=await outcome.json();
        console.info("losp-season-ranks-cron",JSON.stringify({
          status:state.status||state.error||"unavailable",
          alliances:state.snapshot?.connectedAlliances||0
        }));
      }catch{
        console.warn("losp-season-ranks-cron",JSON.stringify({status:"unavailable"}));
      }
    }
    // Daily private pilot retention cleanup. No Scopely roster reads.
    if(controller?.cron==="15 3 * * *"){
      try{await prunePrivateRosterPilots(env);}catch{}
    }
    // Separate daily opt-in discovery; disabled by default. No roster sync.
    if (controller?.cron === "15 3 * * *" && env?.CAPTAIN_COVERAGE_ENABLED === "true") {
      try { await buildPrivateCoverage(env); } catch {}
    }
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if(url.pathname==="/api/public/events")
      return publicEvents(request,env);
    if(url.pathname==="/api/public/awakened-materials")
      return publicAwakenedMaterials(request,env);
    if(url.pathname==="/api/public/arena-history")
      return publicArenaHistory(request,env);
    if(url.pathname==="/api/public/arena-snapshot")
      return publicArenaSnapshot(request,env);
    if(url.pathname==="/api/secure/guest-arena-history")
      return secureGuestArenaHistory(request,env);
    if(url.pathname==="/api/secure/guest-infos")
      return secureGuestInfos(request,env);
    if(url.pathname==="/api/secure/player-links")
      return handleSelfPlayerLinks(request,env);
    if(url.pathname==="/api/secure/guest-rosters")
      return secureGuestRosters(request,env);
    if(url.pathname==="/api/secure/guest-evolution")
      return env?.GUEST_EVOLUTION_LONG_TERM_AUTHORIZED==="true"?
        securePermanentGuestEvolution(request,env):
        secureGuestEvolution(request,env);
    if(url.pathname==="/api/public/trophy-history")
      return publicTrophyHistory(request,env);
    if(url.pathname==="/api/public/guest-season-ranks")
      return publicGuestSeasonRanks(request,env);

    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return handleAdmin(request, env);
    }

    if (getAllianceScopeProbe(url.pathname) ||
        url.pathname === "/login" || url.pathname === "/login/alliance-test" ||
        url.pathname === "/login/roster-scope-test" ||
        url.pathname === "/login/alliance-scope-test" ||
        url.pathname === "/login/alliance-collection-test" ||
        url.pathname === "/login/rosters" ||
        url.pathname === "/login/captain" ||
        url.pathname === "/login/inventory-test" ||
        url.pathname === "/login/profiles-test" ||
        url.pathname === "/login/coverage-test" ||
        url.pathname === "/login/card-types-test" ||
        url.pathname === "/login/metrics-test" ||
        url.pathname === "/login/iso-icons-test") {
      return startLogin(request, env, url);
    }

    if (url.pathname === "/captain") {
      return handleCaptainLanding(request, env);
    }
    if (url.pathname === "/captain/rosters") {
      return handleCaptainRosters(request, env);
    }
    if (url.pathname === "/captain/coverage") {
      return handleCaptainCoverage(request, env);
    }
    if (url.pathname === "/session") {
      return handleCaptainSession(request, env);
    }
    if (url.pathname === "/logout") {
      return handleCaptainLogout(request, env);
    }

    if (url.pathname === "/oauth/callback") {
      return handleCallback(request, env);
    }

    if (url.pathname === "/oauth/status") {
      return handleOAuthStatus(request);
    }

    if (request.method === "GET" && url.pathname === "/") {
      return Response.redirect(new URL("/index.html", url), 302);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json(
        {
          status: "ok",
          service: "losp-roster-service",
          version: "0.1.2"
        },
        {
          headers: {
            "Cache-Control": "no-store"
          }
        }
      );
    }

    return new Response("Not Found", {
      status: 404
    });
  }
};
