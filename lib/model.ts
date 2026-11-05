export type Decision = "unknown" | "yes" | "no";
export type StepId = "block" | "revoke" | "roles" | "mailbox" | "onedrive" | "groups" | "licenses" | "review" | "document";
export type StepStatus = "pending" | "running" | "completed" | "manual" | "approval" | "failed" | "retained";
export type Removal = {
  id: string; kind: "role" | "group" | "license"; resourceId: string; name: string; targetUserId: string;
  status: "pending" | "approved" | "running" | "removed" | "absent" | "retained" | "failed";
  requestedAt: string; approvedAt?: string; approvedBy?: string; completedAt?: string;
  result?: string; reason?: string;
};
export type Checks = {
  investigation: Decision; legalHold: Decision; retention: Decision;
  managerMailbox: boolean; oneDriveTransfer: boolean; sharedResources: boolean;
};
export type Inventory = {
  id: string; accountEnabled: boolean; synced: boolean; userType: string;
  groups: {id: string; name: string; dynamic: boolean; synced: boolean; privileged: boolean; licensed: boolean}[];
  roles: {id: string; name: string}[];
  licenses: {id: string; name: string; inherited: boolean}[];
  discoveredAt: string;
};
export type Step = {
  id: StepId; title: string; description: string; service: string;
  kind: "automated" | "manual"; status: StepStatus; detail?: string;
  evidence?: string; startedAt?: string; completedAt?: string; removals?: Removal[]; findings?: Finding[];
};
export type Finding = {check: string; status: "ok" | "attention" | "unchecked"; detail: string};
export type AuditEvent = {id: string; at: string; actor: string; type: string; message: string};
export type Case = {
  id: string; name: string; email: string; department: string; manager: string;
  ticket: string; effectiveAt: string; mode: "live";
  status: "draft" | "awaiting_approval" | "awaiting_removal_approval" | "ready" | "in_progress" | "needs_attention" | "completed";
  checks: Checks; inventory: Inventory | null; steps: Step[];
  approvedAt?: string; approvedBy?: string; createdAt: string; updatedAt: string;
  audit: AuditEvent[]; revision: number;
};
export type Settings = {retentionDays: number; defaultDepartment: string};
export type Connection = {configured: boolean; enabled: boolean; authorized: boolean; tenantId: string | null};
export type Workspace = {cases: Case[]; settings: Settings; connection: Connection; user: {email: string; name: string}};

export const STEP_DEFS: Omit<Step, "status">[] = [
  {id:"block", title:"Block sign-in", description:"Disable the selected Entra user account and verify the account state.", service:"Entra ID", kind:"automated"},
  {id:"revoke", title:"Revoke active sessions", description:"Invalidate refresh tokens and browser sessions. Existing access tokens may remain valid until expiry or policy enforcement.", service:"Entra ID", kind:"automated"},
  {id:"roles", title:"Remove privileged roles", description:"Individually approve each discovered direct active Entra role removal. PIM eligibility, Azure RBAC and inherited access need a separate review.", service:"Entra ID", kind:"automated"},
  {id:"mailbox", title:"Preserve the mailbox", description:"Preserve the mailbox in Exchange (for example convert it to a shared mailbox or apply a hold), then mark this step as done.", service:"Exchange", kind:"manual"},
  {id:"onedrive", title:"Hand over OneDrive data", description:"Enter the new owner. Exitwise adds them as a site collection administrator of the employee's OneDrive and verifies it.", service:"OneDrive", kind:"manual"},
  {id:"groups", title:"Clean up group access", description:"Approve and remove each supported cloud group membership individually after data preservation. Dynamic, synchronized, role-assignable and license-bearing groups remain for manual review.", service:"Entra ID", kind:"automated"},
  {id:"licenses", title:"Reconcile licenses", description:"Approve each direct license release individually after preservation. Retain licenses when a hold, investigation or retention requirement is recorded.", service:"Microsoft 365", kind:"automated"},
  {id:"review", title:"Verify remaining access", description:"Exitwise checks what access remains: sign-in, roles, PIM eligibility, groups, licenses, apps, consents, owned objects, devices and on-premises sync. Read-only.", service:"Administrator", kind:"manual"},
  {id:"document", title:"Create the audit record", description:"Finalize the case with timestamps, approved scope, action outcomes and administrator evidence.", service:"Exitwise", kind:"automated"},
];
// Steps are independent unless listed here. Licenses wait for data preservation; the review and record wait for the access changes.
export const STEP_DEPENDS: Partial<Record<StepId, StepId[]>> = {licenses:["mailbox","onedrive"],review:["block","revoke","roles","groups","licenses"],document:["block","revoke","roles","mailbox","onedrive","groups","licenses","review"]};
export function waitingOn(c: Case, s: Step): Step[] { return (STEP_DEPENDS[s.id]||[]).map(id=>c.steps.find(x=>x.id===id)!).filter(x=>x&&!done(x)); }
export function available(c: Case, s: Step) { return !done(s) && !waitingOn(c,s).length; }
export function freshSteps(): Step[] { return STEP_DEFS.map(s=>({...s,status:"pending"})); }
export function done(s: Step) { return ["completed","retained"].includes(s.status); }
export function removalDone(r: Removal) { return ["removed","absent","retained"].includes(r.status); }
export function nextRemoval(c: Case) { const step=c.steps.find(s=>!done(s)); const item=step?.removals?.find(r=>!removalDone(r)); return step&&item?{step,item}:null; }
export function needsApproval(c: Case) { return ["awaiting_approval","awaiting_removal_approval"].includes(c.status); }
export function retained(c: Case) { return [c.checks.investigation,c.checks.legalHold,c.checks.retention].includes("yes"); }
export function blockers(c: Case): string[] {
  const issues: string[] = [];
  if ([c.checks.investigation,c.checks.legalHold,c.checks.retention].includes("unknown")) issues.push("Answer the investigation, legal hold and retention checks.");
  if ((c.checks.managerMailbox || c.checks.oneDriveTransfer || c.checks.sharedResources) && !c.manager) issues.push("Assign a handover owner before approving the plan.");
  if (!c.inventory) issues.push("Discover the target account before approving the plan.");
  if (c.inventory && c.inventory.userType !== "Member") issues.push("Live execution supports tenant member accounts only.");
  return issues;
}
export function progress(c: Case) { return Math.round(c.steps.filter(done).length/c.steps.length*100); }
export function deriveStatus(c: Case): Case["status"] {
  if (c.steps.every(done)) return "completed";
  if (c.steps.some(s=>s.status==="approval")) return "awaiting_removal_approval";
  if (c.steps.some(s=>["failed","manual"].includes(s.status))) return "needs_attention";
  if (c.steps.some(s=>s.status==="running" || done(s))) return "in_progress";
  if (c.approvedAt) return "ready";
  return c.inventory && !blockers(c).length ? "awaiting_approval" : "draft";
}
export function event(c: Case, actor: string, type: string, message: string) {
  c.audit.push({id:crypto.randomUUID(),at:new Date().toISOString(),actor,type,message});
}
export function agentReply(c: Case, question: string): string {
  const q=question.toLowerCase();
  const request=nextRemoval(c);
  if (/approval|approve|remove|delet/.test(q) && request) return "The automation is waiting for a separate decision on this "+request.item.kind+": "+request.item.name+" ("+request.item.resourceId+") for "+c.email+". Review this item, approve its removal or keep it with a reason. Approval covers this item only. A failed or expired attempt requires a fresh approval.";
  if (/licen|last|order/.test(q)) return retained(c) ? "This case has a hold, investigation or retention requirement. I will retain licenses and license-bearing groups. Mailbox and OneDrive preservation still require administrator evidence. License release needs a separate review after those requirements end." : "I secure the account first, then wait for mailbox and OneDrive evidence before cleaning up groups or releasing direct licenses. License-bearing groups are reserved for administrator review so group removal cannot silently remove a license.";
  if (/hold|legal|retention/.test(q)) return "Legal hold, investigation and retention are administrator decisions, not inferred facts. Unknown answers block approval. A Yes answer retains all licenses in this workflow. Verify the actual holds and licensing requirements in Purview and Exchange, then attach the evidence in the preservation task.";
  if (/connect|live|tenant/.test(q)) return "Open Connections for the tenant setup. Live cases require server-side Entra credentials, an explicit operator allowlist and live execution enabled. Exchange, OneDrive handover and the final access review use recorded administrator evidence.";
  if (/approval|approve|block|ready/.test(q)) { const b=blockers(c); return b.length ? "Before I can request approval: "+b.join(" ") : "Plan approval binds this employee, discovered account and checklist. Each role, group membership and direct license removal then requires a separate approval. Use Run automation after plan approval and the effective time. Scope changes invalidate approval."; }
  if (/group|role|access/.test(q)) return "The automation requests separate approval for each direct active Entra role and supported cloud group membership before removing it. I reserve dynamic, synchronized, role-assignable and license-bearing groups for review. PIM eligibility, app assignments, Azure RBAC and inherited access are covered by the final administrator evidence task.";
  const next=c.steps.find(s=>!done(s));
  if (!next) return "All workflow steps are recorded. Export the audit report for the approved scope, service results and evidence. Live service actions and administrator attestations are identified separately.";
  return "Next: "+next.title+". "+(next.detail || next.description)+(retained(c)?" License preservation is active for this case.":"");
}
