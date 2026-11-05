import type { Case, Step } from './model';
import { available, blockers, done, event, waitingOn } from './model';
import { assertLive, discover, graphClient } from './graph';
import { saveCase } from './store';
import { isRemovalStep, runRemoval } from './removals';
import { addOneDriveOwner } from './sharepoint';

export function validateRun(c:Case) {
  if(!c.approvedAt)throw new Error('Review and approve the current plan before running the automation.');
  if(blockers(c).length)throw new Error(blockers(c).join(' '));
  if(Date.parse(c.effectiveAt)>Date.now())throw new Error('The effective time has not arrived. Return after the displayed time to run this case.');
  if(c.steps.some(s=>s.status==='running'))throw new Error('An action is in progress or its outcome is uncertain. Refresh first. If it stays running, use Reconcile action to inspect Microsoft state before a retry.');
}
export async function runNext(owner:string,actor:string,c:Case):Promise<Case> {
  const s=c.steps.find(st=>!done(st));if(!s){validateRun(c);return c;}return runStep(owner,actor,c,s);
}
export async function runStep(owner:string,actor:string,c:Case,s:Step):Promise<Case> {
  validateRun(c);await assertLive(actor,c.email);
  if(done(s))return c;if(!available(c,s))throw new Error(s.title+' waits for: '+waitingOn(c,s).map(x=>x.title).join(', ')+'.');
  // Plan approval never bypasses the separate gate for each removal.
  if(isRemovalStep(s))return runRemoval(owner,actor,c,s);
  if(s.kind==='manual') {if(s.status==='manual')return c;s.status='manual';s.detail='Waiting for an administrator evidence reference and a completion attestation.';event(c,'Automation bot','paused',s.title+': administrator handover required.');await saveCase(owner,c);return c;}
  s.status='running';s.startedAt=new Date().toISOString();event(c,'Automation bot','started',`Action started: ${s.title}.`);
  await saveCase(owner,c);
  try {await perform(c,s);s.status='completed';s.completedAt=new Date().toISOString();event(c,'Automation bot',s.status,`${s.title}: ${s.detail}`);}
  catch(error) {s.status='failed';s.detail=error instanceof Error?error.message:'Action failed. Inspect service state before retrying.';event(c,'Automation bot','failed',s.title+': '+s.detail);}
  await saveCase(owner,c);return c;
}
async function perform(c:Case,s:Step) {
  if(!c.inventory)throw new Error('Discovery is required.');
  if(s.id==='document') {if(!c.steps.filter(x=>x.id!=='document').every(done))throw new Error('Every previous action and handover must be recorded before closure.');s.detail='Audit record finalized with every individual removal decision, outcome and administrator attestation.';return;}
  const api=await graphClient(),uid=encodeURIComponent(c.inventory.id);
  const target=await api.call<{id:string;userPrincipalName:string;userType:string}>(`/users/${uid}?$select=id,userPrincipalName,userType`);
  if(target.id!==c.inventory.id||target.userPrincipalName.toLowerCase()!==c.email.toLowerCase()||target.userType!=='Member')throw new Error('The target account identity changed. Stop and create a newly reviewed case.');
  if(s.id==='block') {
    await api.call(`/users/${uid}`,'PATCH',{accountEnabled:false});const check=await api.call<{accountEnabled:boolean}>(`/users/${uid}?$select=accountEnabled`);
    if(check.accountEnabled!==false)throw new Error('Graph accepted the change, but accountEnabled=false is not verified. Reconcile before retrying.');s.detail='Entra accountEnabled=false verified. Separate on-premises or application access still requires review.';
  }
  if(s.id==='revoke') {const result=await api.call<{value?:boolean}>(`/users/${uid}/revokeSignInSessions`,'POST');if(result.value===false)throw new Error('Microsoft did not confirm session invalidation.');s.detail='Microsoft accepted refresh-token and browser-session invalidation. Enforcement may be delayed; access tokens and application sessions require policy or expiry.';}
}
export async function handOverOneDrive(owner:string,actor:string,c:Case,s:Step,newOwner:string):Promise<Case> {
  validateRun(c);await assertLive(actor,c.email);
  if(s.id!=='onedrive'||done(s)||!available(c,s))throw new Error('The OneDrive handover is not open.');
  if(!c.inventory)throw new Error('Discovery is required.');
  if(newOwner===c.email.toLowerCase())throw new Error('Choose a different person as the new OneDrive owner.');
  s.status='running';s.startedAt=new Date().toISOString();event(c,actor,'started',`OneDrive handover started: ${newOwner} as site collection administrator.`);await saveCase(owner,c);
  try {
    {
      const api=await graphClient(),uid=encodeURIComponent(c.inventory.id);
      const target=await api.call<{id:string;userPrincipalName:string}>(`/users/${uid}?$select=id,userPrincipalName`);
      if(target.id!==c.inventory.id||target.userPrincipalName.toLowerCase()!==c.email.toLowerCase())throw new Error('The target account identity changed. Stop and create a newly reviewed case.');
      const o=await api.call<{userPrincipalName:string;accountEnabled:boolean;userType:string}>(`/users/${encodeURIComponent(newOwner)}?$select=userPrincipalName,accountEnabled,userType`);
      if(!o.accountEnabled||o.userType!=='Member')throw new Error('The new owner must be an active member account in this tenant.');
      const r=await addOneDriveOwner(c.inventory.id,c.email,o.userPrincipalName.toLowerCase());
      s.evidence=r.site;s.detail=`${o.userPrincipalName} ${r.already?'was already':'added as'} site collection administrator of ${r.site} (verified).`;
    }
    s.status='completed';s.completedAt=new Date().toISOString();if(!c.manager)c.manager=newOwner;event(c,'SharePoint','completed','Hand over OneDrive data: '+s.detail);
  } catch(error) {s.status='failed';s.detail=(error instanceof Error?error.message:'OneDrive handover failed.')+' Retry, or record the handover manually.';event(c,'Automation bot','failed','Hand over OneDrive data: '+s.detail);}
  await saveCase(owner,c);return c;
}
export async function recordEvidence(owner:string,actor:string,c:Case,stepId:string,evidence:string) {
  const next=c.steps.find(st=>st.id===stepId);if(!c.approvedAt||!next||!available(c,next)||next.kind!=='manual')throw new Error('Only an open administrator handover whose prerequisites are done can accept evidence.');if(c.steps.some(s=>s.status==='running'))throw new Error('Wait for the running action before recording evidence.');
  if(evidence.trim().length<20)throw new Error('Include a verifiable evidence reference and a description (at least 20 characters).');await assertLive(actor,c.email);
  next.evidence=evidence.trim();next.status='completed';next.completedAt=new Date().toISOString();next.detail='Completion attested by '+actor+'. Evidence: '+evidence.trim();event(c,actor,'attested',next.title+': '+evidence.trim());await saveCase(owner,c);return c;
}
export async function reconcile(owner:string,actor:string,c:Case,evidence:string) {
  const step=c.steps.find(s=>s.status==='running');if(!step)throw new Error('There is no unresolved running action.');if(Date.now()-Date.parse(step.startedAt||'')<120000)throw new Error('Allow the running action two minutes to finish before reconciling.');if(evidence.trim().length<20)throw new Error('Provide the service-state inspection reference before unlocking this action.');
  {await assertLive(actor,c.email);await discover(c.email);}
  const item=step.removals?.find(r=>r.status==='running');
  if(item){item.status='failed';item.result='Interrupted outcome inspected: '+evidence;delete item.approvedAt;delete item.approvedBy;step.status='approval';}
  else step.status='failed';
  step.detail='Administrator inspected service state. '+(item?'Fresh individual approval is required before retrying this removal. ':'The interrupted action is unlocked for an idempotent retry. ')+evidence;event(c,actor,'reconciled',step.title+': '+evidence);await saveCase(owner,c);return c;
}
