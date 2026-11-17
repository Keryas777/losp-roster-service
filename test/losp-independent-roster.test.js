import test from "node:test";
import assert from "node:assert/strict";
import {guestRosterDispatchReceiptValid} from "../src/guest-roster-github-dispatch.js";

const fp="a".repeat(64),slot={date:"2026-11-17",campaign:"2026-11-17-am",tick:0};
const now=Date.parse("2026-11-17T03:00:00Z");
const receipt={
  version:1,campaign:slot.campaign,
  progress:{fingerprint:fp,campaign:slot.campaign,selfCompleted:true,
    completed:22,totalEligible:22,runId:"run",membershipDigest:"digest"},
  manifest:{fingerprint:fp,runId:"run",membershipDigest:"digest",
    coMembers:22,total:23,includesPersonal:true,
    capturedAt:"2026-11-17T02:45:00Z",expiresAt:"2026-11-18T02:45:00Z"}
};
test("23-person alliance with all eligible members captured is complete",()=>{
  assert.equal(guestRosterDispatchReceiptValid(receipt,fp,slot,now),true);
});
test("incomplete member collection cannot be published",()=>{
  assert.equal(guestRosterDispatchReceiptValid({
    ...receipt,progress:{...receipt.progress,completed:21}
  },fp,slot,now),false);
});
test("a stale or mismatched receipt cannot be published",()=>{
  assert.equal(guestRosterDispatchReceiptValid({
    ...receipt,campaign:"2026-11-16-pm"
  },fp,slot,now),false);
});
