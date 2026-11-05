import type { Case, Removal, Step } from './model';
import { blockers, done, event, removalDone, retained } from './model';
import { assertLive, discover, graphClient } from './graph';
import { saveCase } from './store';

export function isRemovalStep(s:Step){return ['roles','groups','licenses'].includes(s.id);}
const unresolved=(s:Step)=>s.removals?.find(r=>!removalDone(r));
function itemFor(c:Case,kind:Removal['kind'],resourceId:string,name:string):Removal {
  return {id:crypto.randomUUID(),kind,resourceId,name,targetUserId:c.inventory!.id,status:'pending',requestedAt:new Date().toISOString()};
}
function summarize(c:Case,s:Step){
  const items=s.removals||[];const next=unresolved(s);
  if(next){s.status='approval';s.detail=`Separate approval required: ${next.kind} — ${next.name}. ${items.filter(r=>!removalDone(r)).length} removal decision(s) remain. Each item is approved individually.`;return;}
  const removed=items.filter(r=>r.status==='removed').length,kept=items.filter(r=>r.status==='retained').length,absent=items.filter(r=>r.status==='absent').length;
  s.status=kept||s.id==='licenses'&&!items.length?'retained':'completed';s.completedAt=new Date().toISOString();
  s.detail=`${removed} item(s) removed after individual approval; ${kept} retained; ${absent} already absent.`+(s.id==='groups'?' Protected and license-bearing groups stay reserved for administrator review.':s.id==='roles'?' PIM and inherited privileges still require review.': ' Inherited licenses stay reserved for administrator review.');
}
export async function approveRemoval(owner:string,actor:string,c:Case,id:string,decision:'remove'|'retain',confirmEmail:string,reason:string){
  if(!c.approvedAt||blockers(c).length)throw new Error('Approve the reviewed case plan before individual removals.');
  if(Date.parse(c.effectiveAt)>Date.now())throw new Error('The effective time has not arrived.');
  if(c.steps.some(s=>s.status==='running'))throw new Error('Wait for the current action before approving another removal.');
  await assertLive(actor,c.email);
  const step=c.steps.find(s=>s.removals?.some(r=>r.id===id));const item=step?.removals?.find(r=>r.id===id);
  if(!step||done(step)||!isRemovalStep(step)||step.status!=='approval'||!item||!['pending','failed'].includes(item.status))throw new Error('Only a waiting removal can be approved. Refresh and review that exact item.');
  if(item.targetUserId!==c.inventory?.id)throw new Error('The removal target differs from the approved account.');
  if(decision==='remove'&&confirmEmail!==c.email)throw new Error('Confirm the exact target sign-in name before approving this removal.');
  if(item.kind==='license'&&retained(c))throw new Error('Preservation requirements prevent license removal.');
  if(decision==='retain'){
    if(reason.trim().length<10)throw new Error('Record a reason for retaining this item (at least 10 characters).');
    item.status='retained';item.reason=reason.trim();item.result='Kept by '+actor+': '+item.reason;item.completedAt=new Date().toISOString();
    event(c,actor,'removal_declined',`Retained ${item.kind}: ${item.name} (${item.resourceId}) for ${c.email}, target ${item.targetUserId}. Reason: ${item.reason}`);
    summarize(c,step);
  } else {
    item.status='approved';item.approvedAt=new Date().toISOString();item.approvedBy=actor;delete item.result;
    step.status='pending';step.detail=`One removal approved: ${item.name}. All later removals require their own approval.`;
    event(c,actor,'removal_approved',`Single-use approval to remove ${item.kind}: ${item.name} (${item.resourceId}) from ${c.email}, target ${item.targetUserId}. Approval ID: ${item.id}.`);
  }
  await saveCase(owner,c);return c;
}
export async function runRemoval(owner:string,actor:string,c:Case,s:Step){
  if(!c.inventory)throw new Error('Discovery is required.');
  if(!s||!isRemovalStep(s))throw new Error('This step has no removal items.');
  if(s.id==='licenses'&&retained(c)){
    s.status='retained';s.detail='All licenses retained because an investigation, legal hold or retention requirement is active.';s.completedAt=new Date().toISOString();
    event(c,'Automation bot','retained',s.detail);await saveCase(owner,c);return c;
  }
  if(!s.removals){
    if(s.id==='roles')s.removals=c.inventory.roles.map(r=>itemFor(c,'role',r.id,r.name));
    if(s.id==='groups')s.removals=c.inventory.groups.filter(g=>!g.dynamic&&!g.synced&&!g.privileged&&!g.licensed).map(g=>itemFor(c,'group',g.id,g.name));
    if(s.id==='licenses')s.removals=c.inventory.licenses.filter(l=>!l.inherited).map(l=>itemFor(c,'license',l.id,l.name));
    summarize(c,s);event(c,'Automation bot',s.status==='approval'?'removal_requested':'completed',s.title+': '+s.detail);await saveCase(owner,c);return c;
  }
  const item=s.removals.find(r=>r.status==='approved')||unresolved(s);
  if(!item){summarize(c,s);await saveCase(owner,c);return c;}
  if(item.status!=='approved'){
    if(s.status!=='approval'){summarize(c,s);await saveCase(owner,c);}return c;
  }
  if(!item.approvedAt||!item.approvedBy||Date.now()-Date.parse(item.approvedAt)>15*60000){
    item.status='pending';delete item.approvedAt;delete item.approvedBy;summarize(c,s);event(c,'Automation bot','approval_expired',`Approval expired for ${item.name}. Review and approve the individual removal again.`);await saveCase(owner,c);return c;
  }
  // Consume exactly this item's approval and persist the lock before a service mutation.
  item.status='running';s.status='running';s.startedAt=new Date().toISOString();
  event(c,'Automation bot','removal_started',`Removal started: ${item.kind} ${item.name} (${item.resourceId}), target ${item.targetUserId}, approval ${item.id} by ${item.approvedBy}.`);
  await saveCase(owner,c);
  try {
    const result=await executeOne(c,item);item.status=result.status;item.result=result.detail;item.completedAt=new Date().toISOString();
    event(c,'Microsoft Graph','removal_'+item.status,`${item.kind} ${item.name} (${item.resourceId}): ${item.result}`);
  } catch(error){
    item.status='failed';item.result=error instanceof Error?error.message:'The removal could not be verified. Inspect service state before approving a retry.';
    // A failed attempt consumes its approval. Any retry needs a fresh decision.
    delete item.approvedAt;delete item.approvedBy;
    event(c,'Automation bot','removal_failed',`${item.kind} ${item.name} (${item.resourceId}): ${item.result} A fresh approval is required to retry.`);
  }
  summarize(c,s);await saveCase(owner,c);return c;
}
async function executeOne(c:Case,item:Removal):Promise<{status:'removed'|'absent'|'retained';detail:string}>{
  if(!c.inventory||item.targetUserId!==c.inventory.id)throw new Error('The target object does not match the approved removal.');
  if(item.kind==='license'&&(!['mailbox','onedrive'].every(id=>c.steps.find(s=>s.id===id)?.status==='completed')||retained(c)))throw new Error('Preservation decisions and handover evidence prevent license release.');
  await assertLive(item.approvedBy!,c.email);
  const deadline=Date.now()+80000,api=await graphClient(deadline),uid=encodeURIComponent(item.targetUserId);
  const target=await api.call<{id:string;userPrincipalName:string;userType:string}>(`/users/${uid}?$select=id,userPrincipalName,userType`);
  if(target.id!==item.targetUserId||target.userPrincipalName.toLowerCase()!==c.email.toLowerCase()||target.userType!=='Member')throw new Error('The target account identity changed. Create a newly reviewed case.');
  if(item.kind==='role'){
    const path=`/roleManagement/directory/roleAssignments?$filter=${encodeURIComponent("principalId eq '"+item.targetUserId+"'")}`;
    const current=await api.all<{id:string}>(path),scope=new Set(c.inventory.roles.map(r=>r.id));
    if(current.some(r=>!scope.has(r.id)))throw new Error('New role assignments appeared after plan approval. Review the scope in a new case.');
    if(!current.some(r=>r.id===item.resourceId))return {status:'absent',detail:'The approved direct role assignment is already absent; no deletion was sent.'};
    await api.call(`/roleManagement/directory/roleAssignments/${encodeURIComponent(item.resourceId)}`,'DELETE');
    if((await api.all<{id:string}>(path)).some(r=>r.id===item.resourceId))throw new Error('This role removal is not yet verified. Inspect state before approving a retry.');
  } else if(item.kind==='group'){
    const current=await discover(c.email,deadline),scope=new Set(c.inventory.groups.map(g=>g.id));
    if(current.id!==item.targetUserId)throw new Error('The target object changed after approval.');
    if(current.groups.some(g=>!scope.has(g.id)))throw new Error('New groups appeared after plan approval. Review the scope in a new case.');
    const group=current.groups.find(g=>g.id===item.resourceId);
    if(!group)return {status:'absent',detail:'This membership is already absent; no deletion was sent.'};
    if(group.dynamic||group.synced||group.privileged||group.licensed)return {status:'retained',detail:'Fresh discovery classified this group as protected or license-bearing; retained for manual review.'};
    if(group.name!==item.name)throw new Error('The group name changed after approval. Review the current scope in a new case.');
    await api.call(`/groups/${encodeURIComponent(item.resourceId)}/members/${uid}/$ref`,'DELETE');
    if((await api.all<{id:string}>(`/users/${uid}/memberOf/microsoft.graph.group?$select=id`)).some(g=>g.id===item.resourceId))throw new Error('This membership removal is not yet verified. Inspect state before approving a retry.');
  } else {
    const current=await api.call<{assignedLicenses:{skuId:string}[];licenseAssignmentStates:{skuId:string;assignedByGroup:string|null}[]}>(`/users/${uid}?$select=assignedLicenses,licenseAssignmentStates`);
    if(!Array.isArray(current.licenseAssignmentStates))throw new Error('License assignment source could not be verified. Keep the license until reviewed.');
    if(current.assignedLicenses.some(l=>!c.inventory!.licenses.some(a=>a.id===l.skuId)))throw new Error('New licenses appeared after plan approval. Review the current scope in a new case.');
    if(!current.assignedLicenses.some(l=>l.skuId===item.resourceId))return {status:'absent',detail:'This license is already absent; no release was sent.'};
    if(current.licenseAssignmentStates.some(l=>l.skuId===item.resourceId&&l.assignedByGroup))return {status:'retained',detail:'This license is now group-inherited and was retained for administrator review.'};
    await api.call(`/users/${uid}/assignLicense`,'POST',{addLicenses:[],removeLicenses:[item.resourceId]});
    if((await api.call<{assignedLicenses:{skuId:string}[]}>(`/users/${uid}?$select=assignedLicenses`)).assignedLicenses.some(l=>l.skuId===item.resourceId))throw new Error('This license release is not yet verified. Inspect state before approving a retry.');
  }
  return {status:'removed',detail:`Only the approved ${item.kind} was removed and its absence verified. Approval ${item.id}, by ${item.approvedBy} at ${item.approvedAt}.`};
}
