import { isSelfHosted } from "@/lib/selfhost-auth";
import { validWriteOrigin } from "@/lib/request-security";
import { getChatGPTUser } from "../../chatgpt-auth";
import { z } from "zod";
import { agentReply, blockers, deriveStatus, done, event, freshSteps, waitingOn } from "@/lib/model";
import type { Case } from "@/lib/model";
import { bootstrap, getCase, getSettings, insertCase, listCases, saveCase, saveSettings } from "@/lib/store";
import { assertLive, assertReportingAccess, connection, discover, searchUsers, testConnection } from "@/lib/graph";
import { handOverOneDrive, reconcile, recordEvidence, runNext, runStep } from "@/lib/agent";
import { reviewAccess } from "@/lib/access-review";
import { approveRemoval, runRemoval } from "@/lib/removals";
export const dynamic="force-dynamic";
const reply=(data:unknown,status=200)=>Response.json(data,{status,headers:{"Cache-Control":"no-store"}});
const checksSchema=z.object({investigation:z.enum(["unknown","yes","no"]),legalHold:z.enum(["unknown","yes","no"]),retention:z.enum(["unknown","yes","no"]),managerMailbox:z.boolean(),oneDriveTransfer:z.boolean(),sharedResources:z.boolean()});
const email=z.string().trim().email().max(254).transform(v=>v.toLowerCase());
async function approvePlan(c:Case,actor:string,confirmEmail:unknown){
  if(c.steps.some(s=>s.status!=="pending")||c.approvedAt)throw new Error("This plan is already approved or running.");if(blockers(c).length)throw new Error(blockers(c).join(" "));
  await assertLive(actor,c.email);if(String(confirmEmail??"").trim().toLowerCase()!==c.email.toLowerCase())throw new Error("Type the exact target sign-in name to approve live execution.");if(Date.now()-Date.parse(c.inventory!.discoveredAt)>3600000)throw new Error("Discovery is older than one hour. Refresh discovery and review before approval.");
  c.approvedAt=new Date().toISOString();c.approvedBy=actor;event(c,actor,"approved",`Plan approved for ${c.email}, target ${c.inventory!.id} Each role, group membership and license removal requires its own additional approval. Licenses remain subject to preservation gates.`);
}
async function snapshot(owner:string,email:string,name:string){const [cases,settings]=await Promise.all([listCases(owner),getSettings(owner)]);return {cases,settings,connection:await connection(email),user:{email,name},selfHosted:isSelfHosted()};}
export async function GET() {const user=await getChatGPTUser();if(!user)return reply({error:"Sign in with ChatGPT to open your private workspace."},401);try{return reply(await snapshot(user.userId,user.email,user.displayName));}catch{return reply({error:"The workspace could not be loaded. Refresh to try again."},500);}}
export async function POST(request:Request) {
  const user=await getChatGPTUser();if(!user)return reply({error:"Sign in to continue."},401);
  if(!validWriteOrigin(request))return reply({error:"Invalid request origin."},403);
  try {
    const raw=await request.text();if(raw.length>24000)return reply({error:"Request is too large."},413);
    const b=JSON.parse(raw);const action=z.string().parse(b.action);const owner=user.userId;const actor=user.email;
    if(action==="bootstrap"){await bootstrap(owner,actor);return reply(await snapshot(owner,actor,user.displayName));}
    if(action==="settings") {const s=z.object({retentionDays:z.number().int().min(1).max(3650),defaultDepartment:z.string().trim().min(1).max(80)}).parse(b.settings);await saveSettings(owner,s);return reply({settings:s});}
    if(action==="suggest_users"){const q=z.string().trim().min(2).max(100).parse(b.query);await assertReportingAccess(actor);return reply({users:await searchUsers(q)});}
    if(action==="connection_test"){await assertReportingAccess(actor);return reply({message:await testConnection()});}
    if(action==="create") {
      const data=z.object({name:z.string().trim().min(2).max(100),email,department:z.string().trim().min(1).max(80),manager:z.union([email,z.literal("")]),ticket:z.string().trim().min(2).max(80),effectiveAt:z.string().datetime(),checks:checksSchema}).parse(b.case);
      await assertLive(actor,data.email);const now=new Date().toISOString();const c:Case={...data,mode:"live",id:crypto.randomUUID(),status:"draft",inventory:null,steps:freshSteps(),createdAt:now,updatedAt:now,audit:[],revision:0};
      event(c,actor,"created",`Case created for ${c.email}. Ticket: ${c.ticket}.`);await insertCase(owner,c);return reply({case:c});
    }
    const c=await getCase(owner,z.string().parse(b.caseId));if(b.revision!==c.revision)return reply({error:"This case changed. Refresh and review the latest version before continuing."},409);
    if(action==="chat")return reply({message:agentReply(c,z.string().max(2000).parse(b.question))});
    if(action==="checks") {
      if(c.steps.some(s=>s.status!=="pending"))throw new Error("Execution has started. The approved scope is locked; create a new case for changed requirements.");c.checks=checksSchema.parse(b.checks);c.manager=z.union([email,z.literal("")]).parse(b.manager);delete c.approvedAt;delete c.approvedBy;event(c,actor,"scope_updated","Decision checklist updated; any previous approval invalidated.");await saveCase(owner,c);
    } else if(action==="discover") {
      if(c.steps.some(s=>s.status!=="pending"))throw new Error("The discovery snapshot is locked after execution starts.");await assertLive(actor,c.email);c.inventory=await discover(c.email);delete c.approvedAt;delete c.approvedBy;event(c,"Policy agent","discovered",`Microsoft discovery: ${c.inventory.groups.length} groups, ${c.inventory.roles.length} direct active roles, ${c.inventory.licenses.length} licenses. Legal and retention checks require administrator review.`);await saveCase(owner,c);
    } else if(action==="approve") {
      await approvePlan(c,actor,b.confirmEmail);await saveCase(owner,c);
    } else if(action==="approve_removal") {
      if(b.attest!==true)throw new Error("Confirm the individual removal decision before continuing.");
      const decision=z.enum(["remove","retain"]).parse(b.decision);const removalId=z.string().parse(b.removalId);
      await approveRemoval(owner,actor,c,removalId,decision,z.string().parse(b.confirmEmail),z.string().max(2000).parse(b.reason||""));
      // One click: the single-item approval is consumed immediately by this removal, in the step that owns the item.
      if(decision==="remove"&&b.execute===true)await runRemoval(owner,actor,c,c.steps.find(s=>s.removals?.some(r=>r.id===removalId))!);
    } else if(action==="run") {await runNext(owner,actor,c);
    } else if(action==="do_step") {
      // The operator's click approves the plan (first click) and performs that one step. Only real prerequisites are enforced.
      const next=c.steps.find(s=>s.id===z.string().parse(b.stepId));if(!next||done(next))throw new Error("This step is already done. Refresh the case.");
      const waits=waitingOn(c,next);if(waits.length)throw new Error(`${next.title} waits for: ${waits.map(s=>s.title).join(", ")}.`);
      const newOwner=next.id==="onedrive"&&b.newOwner!==undefined?email.parse(b.newOwner):null;
      // Mailbox and manual OneDrive handovers are one-click confirmations; the audit trail records who confirmed them and when.
      const oneClick=(next.id==="mailbox"||next.id==="onedrive")&&!newOwner&&!b.evidence;
      const evidence=oneClick?`${next.title} marked as done by ${actor}.`:next.kind==="manual"&&!newOwner?z.string().max(3000).parse(b.evidence||""):"";
      if(next.kind==="manual"&&!newOwner&&!oneClick&&!(next.id==="review"&&!b.evidence)&&(b.attest!==true||evidence.trim().length<20))throw new Error("Record the evidence reference (at least 20 characters) and confirm completion.");
      // Clicking a step means "do it now": a case never waits for a scheduled effective time.
      if(Date.parse(c.effectiveAt)>Date.now()){event(c,actor,"scope_updated",`Effective time ${c.effectiveAt} replaced by the operator's click at ${new Date().toISOString()}.`);c.effectiveAt=new Date().toISOString();}
      if(!c.approvedAt)await approvePlan(c,actor,b.confirmEmail);
      if(newOwner)await handOverOneDrive(owner,actor,c,next,newOwner);
      else if(next.id==="review"&&!b.evidence)await reviewAccess(owner,actor,c,next);
      else if(next.kind==="manual")await recordEvidence(owner,actor,c,next.id,evidence);
      else await runStep(owner,actor,c,next);
    } else if(action==="evidence") {if(b.attest!==true)throw new Error("Confirm completion before recording evidence.");await recordEvidence(owner,actor,c,z.string().parse(b.stepId),z.string().max(3000).parse(b.evidence));
    } else if(action==="reconcile") {await reconcile(owner,actor,c,z.string().max(3000).parse(b.evidence));
    } else if(action==="note") {const note=z.string().trim().min(2).max(2000).parse(b.note);if(c.steps.some(s=>s.status==="running"))throw new Error("Wait for the current action before adding a note.");event(c,actor,"note",note);await saveCase(owner,c);
    } else {return reply({error:"Unknown workspace action."},400);}
    c.status=deriveStatus(c);return reply({case:c});
  } catch(error) {const message=error instanceof z.ZodError?"Check the required fields, email addresses and effective date.":error instanceof Error?error.message:"The action could not be completed.";return reply({error:message},400);}
}
