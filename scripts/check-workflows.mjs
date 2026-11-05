import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const directory=path.resolve('.sites-runtime/workflow-checks');
await mkdir(directory,{recursive:true});
const sql=new DatabaseSync(':memory:');
for(const file of (await readdir('drizzle')).filter(f=>f.endsWith('.sql')).sort()) sql.exec((await readFile('drizzle/'+file,'utf8')).replaceAll('--> statement-breakpoint',''));
class Prepared {
  constructor(query,args=[]){this.query=query;this.args=args;}
  bind(...args){return new Prepared(this.query,args);}
  async first(){return sql.prepare(this.query).get(...this.args)||null;}
  async all(){return {results:sql.prepare(this.query).all(...this.args)};}
  async run(){const r=sql.prepare(this.query).run(...this.args);return {success:true,meta:{changes:Number(r.changes)}};}
}
globalThis.__EXITWISE_TEST_ENV={DB:{prepare:q=>new Prepared(q),batch:async statements=>{sql.exec('BEGIN');try{const r=await Promise.all(statements.map(s=>s.run()));sql.exec('COMMIT');return r;}catch(e){sql.exec('ROLLBACK');throw e;}}}};
globalThis.__EXITWISE_TEST_USER={userId:'test-owner',email:'admin@example.com',displayName:'Test Admin'};
await writeFile(path.join(directory,'runtime.mjs'),'export const env=globalThis.__EXITWISE_TEST_ENV;\n');
await writeFile(path.join(directory,'auth.mjs'),'export async function getChatGPTUser(){return globalThis.__EXITWISE_TEST_USER;}\n');
for(const [source,name] of [['lib/model.ts','model'],['lib/store.ts','store'],['lib/graph.ts','graph'],['lib/configuration.ts','configuration'],['lib/request-security.ts','request-security'],['lib/selfhost-auth.ts','selfhost-auth'],['lib/removals.ts','removals'],['lib/agent.ts','agent'],['lib/sharepoint.ts','sharepoint'],['lib/access-review.ts','access-review'],['lib/microsoft-signin.ts','microsoft-signin'],['app/api/workspace/route.ts','route']]){
  let out=ts.transpileModule(await readFile(source,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  out=out.replaceAll('"cloudflare:workers"','"./runtime.mjs"').replaceAll('"../../chatgpt-auth"','"./auth.mjs"').replace(/"@\/lib\/([^"]+)"/g,'"./$1.mjs"').replace(/(['"])\.\/(model|store|graph|agent|removals|configuration|request-security|selfhost-auth|sharepoint|microsoft-signin|access-review)\1/g,'"./$2.mjs"');
  await writeFile(path.join(directory,name+'.mjs'),out);
}
const route=await import(pathToFileURL(path.join(directory,'route.mjs')));
const {getCase,saveCase,listCases}=await import(pathToFileURL(path.join(directory,'store.mjs')));
const {assertLive,graphClient}=await import(pathToFileURL(path.join(directory,'graph.mjs')));
const {runNext}=await import(pathToFileURL(path.join(directory,'agent.mjs')));
let checks=0;let requests=[];
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,options={})=>{requests.push({url:String(url),options});throw new Error('Unexpected network call in authorization checks');};
async function post(body){const res=await route.POST(new Request('https://example.test/api/workspace',{method:'POST',headers:{origin:'https://example.test','Content-Type':'application/json'},body:JSON.stringify(body)}));return {status:res.status,body:await res.json()};}
function pass(label){checks++;process.stdout.write('PASS '+label+'\n');}try {
  const owner=globalThis.__EXITWISE_TEST_USER;
  // A mocked Microsoft 365 tenant: every UPN gets one direct role, three plain groups, one license-bearing group, one inherited and one direct license.
  function standardTenant(){
    const users=new Map(),ops=[];
    const userFor=raw=>{const key=decodeURIComponent(raw).toLowerCase();for(const u of users.values())if(u.id===key||u.upn===key)return u;if(!key.includes('@'))return null;
      const u={id:'id-'+key.replace(/[^a-z0-9]/g,'-'),upn:key,enabled:true,roles:new Map([['role-'+key.replace(/[^a-z0-9]/g,'-'),'Helpdesk Administrator']]),groups:new Map([['grp-product',{name:'Product team',licensed:false}],['grp-all',{name:'All employees',licensed:false}],['grp-atlas',{name:'Project Atlas',licensed:false}],['grp-licensed',{name:'M365 licensed users',licensed:true}]]),licenses:new Set(['sku-m365','sku-direct'])};users.set(u.id,u);return u;};
    const obj=u=>({id:u.id,userPrincipalName:u.upn,userType:'Member',accountEnabled:u.enabled,onPremisesSyncEnabled:false,assignedLicenses:[...u.licenses].map(skuId=>({skuId})),licenseAssignmentStates:[...u.licenses].map(skuId=>({skuId,assignedByGroup:skuId==='sku-m365'?'grp-licensed':null}))});
    const directory=[['Sofia Chen','sofia.chen@example.com'],['Omar Haddad','omar.haddad@example.com']];
    const quoted=v=>((v||'').match(/'([^']*)'/)||[])[1]||'';
    const fetchFn=async(input,options={})=>{
      const u=new URL(String(input)),p=u.pathname,m=options.method||'GET';requests.push({url:u.toString(),options});
      if(p.endsWith('/oauth2/v2.0/token'))return Response.json({access_token:'test-only-token'});
      if(p==='/v1.0/users'){const q=quoted(u.searchParams.get('$filter')).toLowerCase();return Response.json({value:directory.filter(([n,e])=>n.toLowerCase().split(' ').concat(n.toLowerCase(),e).some(v=>v.startsWith(q))).map(([n,e])=>({id:'id-'+e,displayName:n,userPrincipalName:e,accountEnabled:true,userType:'Member'}))});}
      if(p==='/v1.0/roleManagement/directory/roleEligibilitySchedules')return Response.json({value:[]});
      if(p.startsWith('/v1.0/roleManagement/directory/roleAssignments')){
        if(m==='DELETE'){const rid=decodeURIComponent(p.split('/').at(-1));for(const x of users.values())if(x.roles.delete(rid)){ops.push({kind:'role',id:rid});return new Response(null,{status:204});}return Response.json({error:{code:'NotFound'}},{status:404});}
        const x=userFor(quoted(u.searchParams.get('$filter')));return Response.json({value:[...(x?.roles||[])].map(([id,name])=>({id,roleDefinition:{displayName:name}}))});
      }
      const mg=p.match(/^\/v1\.0\/groups\/([^/]+)\/members\/([^/]+)\/\$ref$/);if(mg&&m==='DELETE'){userFor(mg[2]).groups.delete(decodeURIComponent(mg[1]));ops.push({kind:'group',id:mg[1]});return new Response(null,{status:204});}
      const mu=p.match(/^\/v1\.0\/users\/([^/]+)(\/.*)?$/);if(!mu)throw new Error('Unexpected mocked Graph request '+p);
      const x=userFor(mu[1]);if(!x)return Response.json({error:{code:'Request_ResourceNotFound'}},{status:404});const rest=mu[2]||'';
      if(rest==='/appRoleAssignments')return Response.json({error:{code:'Authorization_RequestDenied'}},{status:403});
      if(['/oauth2PermissionGrants','/ownedObjects','/ownedDevices'].includes(rest))return Response.json({value:[]});
      if(rest.startsWith('/memberOf')||rest.startsWith('/transitiveMemberOf'))return Response.json({value:[...x.groups].map(([id,g])=>({id,displayName:g.name,groupTypes:[],onPremisesSyncEnabled:false,isAssignableToRole:false,assignedLicenses:g.licensed?[{skuId:'sku-m365'}]:[]}))});
      if(rest==='/revokeSignInSessions')return Response.json({value:true});
      if(rest==='/assignLicense'){const b=JSON.parse(options.body);assert.equal(b.removeLicenses.length,1);for(const s of b.removeLicenses)x.licenses.delete(s);ops.push({kind:'license',id:b.removeLicenses[0]});return Response.json(obj(x));}
      if(m==='PATCH'){x.enabled=JSON.parse(options.body).accountEnabled;ops.push({kind:'block'});return new Response(null,{status:204});}
      return Response.json(obj(x));
    };
    fetchFn.ops=ops;return fetchFn;
  }
  globalThis.__EXITWISE_TEST_USER=null;assert.equal((await route.GET()).status,401);globalThis.__EXITWISE_TEST_USER=owner;pass('Private API rejects missing identity');
  let result=await post({action:'bootstrap'});assert.equal(result.status,200);assert.equal(result.body.cases.length,0);result=await post({action:'bootstrap'});assert.equal(result.body.cases.length,0);pass('Initialization creates an empty workspace without sample cases');
  result=await route.POST(new Request('https://example.test/api/workspace',{method:'POST',headers:{origin:'https://evil.example'},body:JSON.stringify({action:'bootstrap'})}));assert.equal(result.status,403);pass('Cross-origin writes are rejected');
  const fields={name:'Test Employee',email:'employee@example.com',department:'Engineering',manager:'manager@example.com',ticket:'TEST-001',effectiveAt:new Date(Date.now()-60000).toISOString(),checks:{investigation:'unknown',legalHold:'unknown',retention:'unknown',managerMailbox:true,oneDriveTransfer:true,sharedResources:true}};
  const reviewed={...fields.checks,investigation:'no',legalHold:'no',retention:'no'};
  await assert.rejects(()=>assertLive(owner.email,fields.email),/Live execution requires/);assert.equal((await post({action:'create',case:fields})).status,400);assert.equal((await post({action:'suggest_users',query:'sof'})).status,400);assert.equal(requests.length,0);pass('Unconfigured tenant actions fail before contacting Microsoft');
  Object.assign(globalThis.__EXITWISE_TEST_ENV,{MS_TENANT_ID:'11111111-1111-1111-1111-111111111111',MS_CLIENT_ID:'test-client',MS_CLIENT_SECRET:'test-only',OFFBOARDING_LIVE_ENABLED:'true',OFFBOARDING_ADMIN_EMAILS:owner.email});
  let tenant=standardTenant();globalThis.fetch=tenant;
  let c=(await post({action:'create',case:fields})).body.case;
  const cmd=async(action,extra={})=>{const r=await post({action,caseId:c.id,revision:c.revision,confirmEmail:c.email,...extra});if(r.body.case)c=r.body.case;return r;};
  const currentItem=()=>c.steps.find(s=>!['completed','retained'].includes(s.status))?.removals?.find(r=>!['removed','absent','retained'].includes(r.status));
  const approveNext=async(decision='remove',reason='')=>{const r=await cmd('approve_removal',{removalId:currentItem()?.id,decision,confirmEmail:c.email,reason,attest:true});assert.equal(r.status,200,JSON.stringify(r.body));};
  assert.equal((await cmd('approve')).status,400);assert.equal((await cmd('run')).status,400);pass('Unapproved plans cannot execute');
  await cmd('discover');assert.equal((await cmd('approve')).status,400);pass('Unknown preservation decisions block plan approval');
  await cmd('checks',{checks:reviewed,manager:fields.manager});await cmd('approve');assert.ok(c.approvedAt);await cmd('checks',{checks:reviewed,manager:fields.manager});assert.equal(c.approvedAt,undefined);await cmd('approve');pass('Changing the checklist invalidates plan approval');
  assert.equal((await post({action:'run',caseId:c.id,revision:c.revision-1})).status,409);pass('Stale revisions cannot start an action');
  await cmd('run');await cmd('run');await cmd('run');assert.equal(c.steps[2].status,'approval');assert.equal(c.status,'awaiting_removal_approval');const roleId=currentItem().id;
  await cmd('run');assert.equal(currentItem().status,'pending');assert.equal(c.steps[2].removals.filter(r=>r.status==='removed').length,0);pass('Plan approval and repeated run calls cannot bypass individual role approval');
  assert.equal((await cmd('approve_removal',{removalId:'invented-id',decision:'remove',confirmEmail:c.email,attest:true})).status,400);
  assert.equal((await cmd('approve_removal',{removalId:roleId,decision:'remove',confirmEmail:'other@example.com',attest:true})).status,400);
  assert.equal((await cmd('approve_removal',{removalId:roleId,decision:'remove',confirmEmail:c.email,attest:false})).status,400);pass('Removal approval is bound to the exact queued item, target and attestation');
  await approveNext();assert.equal(currentItem().status,'approved');assert.equal(c.steps[2].removals.filter(r=>r.status==='removed').length,0);await cmd('run');assert.equal(c.steps[2].removals[0].status,'removed');assert.ok(c.steps[2].removals[0].approvedBy);assert.equal((await cmd('approve_removal',{removalId:roleId,decision:'remove',confirmEmail:c.email,attest:true})).status,400);pass('An approval records one decision and is consumed by one removal');
  await cmd('run');assert.equal(c.steps[3].status,'manual');assert.equal((await cmd('evidence',{stepId:'review',evidence:'TEST-001 — verified evidence',attest:true})).status,400);assert.equal((await cmd('evidence',{stepId:'mailbox',evidence:'short',attest:true})).status,400);pass('Evidence remains mandatory and waits for real prerequisites');
  await cmd('evidence',{stepId:'mailbox',evidence:'TEST-001 — mailbox preservation and licensing requirements verified.',attest:true});await cmd('run');assert.equal(c.steps[4].status,'manual');await cmd('evidence',{stepId:'onedrive',evidence:'TEST-001 — handover to the manager completed and verified.',attest:true});await cmd('run');assert.equal(c.steps[5].status,'approval');assert.equal(c.steps[5].removals.length,3);
  const laterGroup=c.steps[5].removals[1].id;assert.equal((await cmd('approve_removal',{removalId:laterGroup,decision:'remove',confirmEmail:c.email,attest:true})).status,200);assert.equal((await cmd('approve_removal',{removalId:c.steps[5].removals[0].id,decision:'remove',confirmEmail:c.email,attest:true})).status,400);await cmd('run');assert.equal(c.steps[5].removals.filter(r=>r.status==='removed').length,1);assert.equal(c.steps[5].removals[1].status,'removed');assert.equal(currentItem().status,'pending');await cmd('run');assert.equal(c.steps[5].removals.filter(r=>r.status==='removed').length,1);pass('Group cleanup removes one approved membership at a time, in any order, and allows no second outstanding approval');
  assert.equal((await cmd('approve_removal',{removalId:currentItem().id,decision:'retain',confirmEmail:'',reason:'short',attest:true})).status,400);await approveNext('retain','TEST-001 — approved temporary access exception.');assert.equal(c.steps[5].removals[0].status,'retained');assert.ok(c.steps[5].removals[0].reason);await approveNext();await cmd('run');assert.equal(c.steps[5].status,'retained');pass('Declining a removal keeps the item and records the exception reason');
  await cmd('run');assert.equal(c.steps[6].status,'approval');assert.equal(c.steps[6].removals.length,1);assert.equal(currentItem().resourceId,'sku-direct');await cmd('run');assert.equal(currentItem().status,'pending');await approveNext();await cmd('run');assert.equal(c.steps[6].removals[0].status,'removed');pass('Each direct license has its own approval; inherited licenses are excluded');
  await cmd('run');assert.equal(c.steps[7].status,'manual');await cmd('evidence',{stepId:'review',evidence:'TEST-001 — PIM, apps, exceptions and residual access reviewed.',attest:true});await cmd('run');assert.equal(c.status,'completed');assert.equal(c.audit.filter(e=>e.type==='attested').length,3);assert.equal(c.audit.filter(e=>e.type==='removal_approved').length,4);assert.equal(c.audit.filter(e=>e.type==='removal_declined').length,1);assert.deepEqual(tenant.ops.map(o=>o.kind),['block','role','group','group','license']);pass('Complete execution records every removal decision and sends exactly one Microsoft change per approved item');
  assert.equal((await cmd('checks',{checks:reviewed,manager:fields.manager})).status,400);const completed=structuredClone(c);pass('Execution scope remains locked after starting');
  globalThis.__EXITWISE_TEST_USER={...owner,userId:'another-owner'};assert.equal((await post({action:'approve_removal',caseId:c.id,revision:c.revision,removalId:roleId,decision:'remove',confirmEmail:c.email,attest:true})).status,400);assert.equal((await listCases('another-owner')).length,0);globalThis.__EXITWISE_TEST_USER=owner;pass('Other workspace users cannot read or approve these removals');
  let hold=(await post({action:'create',case:{...fields,email:'hold@example.com',checks:{...reviewed,legalHold:'yes'}}})).body.case;hold=(await post({action:'discover',caseId:hold.id,revision:hold.revision})).body.case;result=await post({action:'approve',caseId:hold.id,revision:hold.revision,confirmEmail:hold.email});hold=result.body.case;for(let i=0;i<6;i++)hold.steps[i].status='completed';await saveCase(owner.userId,hold);await runNext(owner.userId,owner.email,hold);assert.equal(hold.steps[6].status,'retained');assert.match(hold.steps[6].detail,/All licenses retained/);pass('A legal hold retains licenses without requesting removal approval');
  let future=(await post({action:'create',case:{...fields,checks:reviewed,effectiveAt:new Date(Date.now()+86400000).toISOString()}})).body.case;future.inventory=structuredClone(completed.inventory);future.approvedAt=new Date().toISOString();await saveCase(owner.userId,future);await assert.rejects(runNext(owner.userId,owner.email,future),/effective time/);pass('Future effective times cannot execute early');
  let parallel=(await post({action:'create',case:{...fields,checks:reviewed}})).body.case;parallel.inventory=structuredClone(completed.inventory);parallel.approvedAt=new Date().toISOString();await saveCase(owner.userId,parallel);const settled=await Promise.allSettled([runNext(owner.userId,owner.email,structuredClone(parallel)),runNext(owner.userId,owner.email,structuredClone(parallel))]);assert.equal(settled.filter(r=>r.status==='fulfilled').length,1);assert.equal((await getCase(owner.userId,parallel.id)).audit.filter(e=>e.type==='started').length,1);pass('Concurrent execution obtains a persisted lock');
  Object.assign(globalThis.__EXITWISE_TEST_ENV,{MS_TENANT_ID:'11111111-1111-1111-1111-111111111111',MS_CLIENT_ID:'test-client',MS_CLIENT_SECRET:'test-only',OFFBOARDING_LIVE_ENABLED:'true',OFFBOARDING_ADMIN_EMAILS:owner.email});await assert.rejects(()=>assertLive(owner.email,owner.email),/protected/);pass('Operator accounts remain protected');
  let enabled=true;const roles=new Set(['role-a','role-b']);const groups=new Map([['group-a',{name:'Team A',licensed:false}],['group-b',{name:'Team B',licensed:false}],['group-licensed',{name:'Licensed users',licensed:true}]]);const licenses=new Set(['sku-a','sku-b','sku-inherited']);let failNextRole=false;const operations=[];
  const userObject=()=>({id:'approved-immutable-id',userPrincipalName:fields.email,userType:'Member',accountEnabled:enabled,onPremisesSyncEnabled:false,assignedLicenses:[...licenses].map(skuId=>({skuId})),licenseAssignmentStates:[...licenses].map(skuId=>({skuId,assignedByGroup:skuId==='sku-inherited'?'group-licensed':null}))});
  globalThis.fetch=async(input,options={})=>{
    const u=new URL(String(input)),p=u.pathname;requests.push({url:u.toString(),options});
    if(p.endsWith('/oauth2/v2.0/token'))return Response.json({access_token:'test-only-token'});
    if(p.includes('/roleManagement/directory/roleAssignments')){
      if(options.method==='DELETE'){const id=decodeURIComponent(p.split('/').at(-1));operations.push({kind:'role',id});if(failNextRole){failNextRole=false;return Response.json({error:{code:'ServiceUnavailable'}},{status:503});}roles.delete(id);return new Response(null,{status:204});}
      return Response.json({value:[...roles].map(id=>({id,roleDefinition:{displayName:id==='role-a'?'Helpdesk Administrator':'User Administrator'}}))});
    }
    if(p.includes('/groups/')&&options.method==='DELETE'){assert.ok(p.endsWith('/$ref'));const id=decodeURIComponent(p.split('/')[3]);operations.push({kind:'group',id,path:p});groups.delete(id);return new Response(null,{status:204});}
    if(p.includes('/memberOf/'))return Response.json({value:[...groups].map(([id,g])=>({id,displayName:g.name,groupTypes:[],onPremisesSyncEnabled:false,isAssignableToRole:false,assignedLicenses:g.licensed?[{skuId:'sku-inherited'}]:[]}))});
    if(p.endsWith('/assignLicense')){const b=JSON.parse(options.body);assert.equal(b.removeLicenses.length,1);assert.deepEqual(b.addLicenses,[]);operations.push({kind:'license',id:b.removeLicenses[0],body:b});licenses.delete(b.removeLicenses[0]);return Response.json(userObject());}
    if(p.endsWith('/revokeSignInSessions'))return Response.json({value:true});
    if(p.includes('/users/')){if(options.method==='PATCH'){assert.match(p,/\/users\/approved-immutable-id$/);assert.deepEqual(JSON.parse(options.body),{accountEnabled:false});enabled=false;operations.push({kind:'block'});return new Response(null,{status:204});}return Response.json(userObject());}
    throw new Error('Unexpected mocked Graph request '+p);
  };
  c=(await post({action:'create',case:{...fields,checks:reviewed}})).body.case;await cmd('discover');assert.equal(c.inventory.id,'approved-immutable-id');await cmd('approve',{confirmEmail:c.email});await cmd('run');assert.equal(enabled,false);assert.equal(c.steps[0].status,'completed');pass('Live account blocking stays bound to the reviewed immutable target');
  await cmd('run');await cmd('run');assert.equal(c.steps[2].status,'approval');await cmd('run');assert.equal(operations.filter(o=>o.kind==='role').length,0);pass('Live removal makes no DELETE request until the individual approval is recorded');
  const firstLiveRole=currentItem().id;await approveNext();assert.equal(operations.filter(o=>o.kind==='role').length,0);await cmd('run');assert.equal(operations.filter(o=>o.kind==='role').length,1);assert.equal(roles.size,1);assert.equal(currentItem().status,'pending');assert.equal((await cmd('approve_removal',{removalId:firstLiveRole,decision:'remove',confirmEmail:c.email,attest:true})).status,400);pass('Live role approval removes only that role and cannot authorize a second role');
  failNextRole=true;await approveNext();await cmd('run');assert.equal(currentItem().status,'failed');assert.equal(currentItem().approvedAt,undefined);const attempted=operations.length;await cmd('run');assert.equal(operations.length,attempted);await approveNext();await cmd('run');assert.equal(roles.size,0);pass('Failed removals consume approval and cannot retry without fresh approval');
  await cmd('run');await cmd('evidence',{stepId:'mailbox',evidence:'LIVE-001 — preservation and license requirements verified.',attest:true});await cmd('run');await cmd('evidence',{stepId:'onedrive',evidence:'LIVE-001 — handover and recipient access verified.',attest:true});await cmd('run');assert.equal(c.steps[5].removals.length,2);await approveNext();await cmd('run');assert.equal(operations.filter(o=>o.kind==='group').length,1);assert.equal(groups.has('group-a'),false);assert.equal(groups.has('group-b'),true);pass('Live group approval deletes one membership using $ref');
  groups.get('group-b').licensed=true;await approveNext();await cmd('run');assert.equal(operations.filter(o=>o.kind==='group').length,1);assert.equal(c.steps[5].removals[1].status,'retained');pass('Fresh classification retains a group that became license-bearing after approval');
  await cmd('run');assert.equal(c.steps[6].removals.length,2);await approveNext();await cmd('run');assert.equal(operations.filter(o=>o.kind==='license').length,1);assert.equal(licenses.has('sku-b'),true);await cmd('run');assert.equal(operations.filter(o=>o.kind==='license').length,1);await approveNext();await cmd('run');assert.equal(operations.filter(o=>o.kind==='license').length,2);assert.deepEqual([...licenses],['sku-inherited']);pass('License approvals release exactly one SKU per request and preserve inherited licenses');
  tenant=standardTenant();globalThis.fetch=tenant;c=(await post({action:'create',case:{...fields,checks:reviewed}})).body.case;await cmd('discover');await cmd('approve');await cmd('run');await cmd('run');await cmd('run');await approveNext();c.steps[2].removals[0].approvedAt=new Date(Date.now()-16*60000).toISOString();await saveCase(owner.userId,c);const before=tenant.ops.length;await cmd('run');assert.equal(currentItem().status,'pending');assert.equal(c.steps[2].status,'approval');assert.equal(tenant.ops.length,before);pass('Expired individual approvals pause without executing a removal');
  await assert.rejects(graphClient(Date.now()-1),/time budget/);pass('Expired execution budgets stop further service calls');
  {
    tenant=standardTenant();globalThis.fetch=tenant;
    let r=await post({action:'suggest_users',query:'sof'});assert.equal(r.status,200);assert.deepEqual(r.body.users.map(u=>u.email),['sofia.chen@example.com']);pass('Directory search suggests matching tenant users by name or UPN');
    let d=(await post({action:'create',case:{...fields,email:'click.through@example.com'}})).body.case;
    const step=async(extra,ok=true)=>{const res=await post({caseId:d.id,revision:d.revision,confirmEmail:d.email,...extra});if(ok){assert.equal(res.status,200,res.body.error);d=res.body.case;}return res;};
    const st=id=>d.steps.find(x=>x.id===id);
    await step({action:'discover'});
    assert.equal((await step({action:'do_step',stepId:'block'},false)).status,400);
    await step({action:'checks',checks:reviewed,manager:'manager@example.com'});
    await saveCase(owner.userId,{...(await getCase(owner.userId,d.id)),effectiveAt:new Date(Date.now()+86400000).toISOString()});d=await getCase(owner.userId,d.id);
    await step({action:'do_step',stepId:'revoke'});assert.ok(d.approvedAt);assert.equal(st('revoke').status,'completed');assert.equal(st('block').status,'pending');assert.ok(Date.parse(d.effectiveAt)<=Date.now());pass('Independent steps run in any order on their own click, even with a future effective time');
    assert.match((await step({action:'do_step',stepId:'licenses'},false)).body.error,/waits for: Preserve the mailbox, Hand over OneDrive data/);
    assert.match((await step({action:'do_step',stepId:'review',evidence:'CHG-1 - remaining access reviewed early.',attest:true},false)).body.error,/waits for/);pass('Dependent steps wait only for their real prerequisites');
    await step({action:'do_step',stepId:'groups'});const [g1,g2,g3]=st('groups').removals;
    await step({action:'approve_removal',removalId:g3.id,decision:'remove',confirmEmail:d.email,attest:true,execute:true});
    await step({action:'approve_removal',removalId:g2.id,decision:'retain',confirmEmail:'',reason:'Needed for alumni newsletter.',attest:true});
    await step({action:'approve_removal',removalId:g1.id,decision:'remove',confirmEmail:d.email,attest:true,execute:true});assert.deepEqual(st('groups').removals.map(x=>x.status),['removed','retained','removed']);assert.equal(st('groups').status,'retained');pass('Removal items can be decided in any order with one click each');
    assert.equal((await step({action:'do_step',stepId:'onedrive',newOwner:d.email},false)).status,400);
    await step({action:'do_step',stepId:'onedrive'});assert.equal(st('onedrive').status,'completed');assert.match(st('onedrive').evidence,/Hand over OneDrive data marked as done by admin@example.com/);pass('A OneDrive handover done by hand is marked done in one click');
    await step({action:'do_step',stepId:'block'});await step({action:'do_step',stepId:'roles'});await step({action:'approve_removal',removalId:st('roles').removals[0].id,decision:'remove',confirmEmail:d.email,attest:true,execute:true});
    await step({action:'do_step',stepId:'mailbox'});assert.equal(st('mailbox').status,'completed');assert.match(st('mailbox').evidence,/marked as done by admin@example.com/);
    await step({action:'do_step',stepId:'licenses'});await step({action:'approve_removal',removalId:st('licenses').removals[0].id,decision:'remove',confirmEmail:d.email,attest:true,execute:true});
    const mark=requests.length;await step({action:'do_step',stepId:'review'});const f=Object.fromEntries(st('review').findings.map(x=>[x.check,x]));
    assert.equal(st('review').status,'completed');assert.equal(f['Sign-in blocked'].status,'ok');assert.equal(f['Direct Entra roles'].status,'ok');assert.equal(f['PIM eligible roles'].status,'ok');assert.equal(f['Groups (including inherited)'].status,'attention');assert.match(f['Groups (including inherited)'].detail,/All employees/);assert.equal(f['Licenses'].status,'attention');assert.equal(f['App assignments'].status,'unchecked');assert.match(f['App assignments'].detail,/Directory.Read.All/);assert.equal(f['Azure subscriptions (RBAC)'].status,'unchecked');
    const writes=requests.slice(mark).filter(r=>(r.options.method||'GET')!=='GET'&&!r.url.includes('/oauth2/'));assert.equal(writes.length,0);pass('The read-only access check reports clear, remaining and unchecked access');
await step({action:'do_step',stepId:'document'});
    assert.equal(d.status,'completed');assert.deepEqual(tenant.ops.map(o=>o.kind),['group','group','block','role','license']);pass('Click-per-step flow completes in a free order with exactly one Microsoft change per click');
  }
  {
    const {generateKeyPairSync}=await import('node:crypto');const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
    Object.assign(globalThis.__EXITWISE_TEST_ENV,{MS_TENANT_ID:'11111111-1111-1111-1111-111111111111',MS_CLIENT_ID:'test-client',MS_CLIENT_SECRET:'test-only',OFFBOARDING_LIVE_ENABLED:'true',OFFBOARDING_ADMIN_EMAILS:owner.email,MS_CERTIFICATE:['-----BEGIN CERTIFICATE-----','AQIDBA==','-----END CERTIFICATE-----'].join(String.fromCharCode(10)),MS_CERTIFICATE_KEY:privateKey.export({type:'pkcs8',format:'pem'})});
    let isAdmin=false;const merges=[];
    globalThis.fetch=async(input,options={})=>{
      const u=new URL(String(input));
      if(u.pathname.endsWith('/oauth2/v2.0/token')){const b=new URLSearchParams(options.body);if(b.get('scope').includes('sharepoint.com')){assert.equal(b.get('client_secret'),null);assert.ok(JSON.parse(Buffer.from(b.get('client_assertion').split('.')[0],'base64url')).x5t);}return Response.json({access_token:'test-only-token'});}
      if(u.hostname==='graph.microsoft.com'){if(u.pathname.endsWith('/drive'))return Response.json({error:{code:'itemNotFound'}},{status:404});if(u.pathname==='/v1.0/sites/root')return Response.json({webUrl:'https://contoso.sharepoint.com'});if(u.pathname.includes('new.owner'))return Response.json({userPrincipalName:'new.owner@example.com',accountEnabled:true,userType:'Member'});return Response.json({id:'leaver-id',userPrincipalName:'leaver@example.com',userType:'Member'});}
      if(u.hostname==='contoso-my.sharepoint.com'){assert.ok(u.pathname.startsWith('/personal/leaver_example_com/_api/web/'));
        if(u.pathname.endsWith('/ensureuser')){assert.equal(JSON.parse(options.body).logonName,'i:0#.f|membership|new.owner@example.com');return Response.json({Id:7,IsSiteAdmin:isAdmin});}
        if(options.headers?.['X-HTTP-Method']==='MERGE'){assert.ok(u.pathname.endsWith('/GetUserById(7)'));merges.push(u.pathname);isAdmin=JSON.parse(options.body).IsSiteAdmin===true;return new Response(null,{status:204});}
        return Response.json({IsSiteAdmin:isAdmin});}
      throw new Error('Unexpected request '+u);
    };
    let l=(await post({action:'create',case:{...fields,email:'leaver@example.com',checks:reviewed}})).body.case;
    l.inventory={id:'leaver-id',accountEnabled:true,synced:false,userType:'Member',groups:[],roles:[],licenses:[],discoveredAt:new Date().toISOString()};await saveCase(owner.userId,l);
    let res=await post({action:'do_step',caseId:l.id,revision:l.revision,stepId:'onedrive',newOwner:'new.owner@example.com'});assert.match(res.body.error,/exact target sign-in name/);
    res=await post({action:'do_step',caseId:l.id,revision:l.revision,stepId:'onedrive',newOwner:'new.owner@example.com',confirmEmail:'Leaver@example.com '});assert.equal(res.status,200,res.body.error);
    const od=res.body.case.steps.find(x=>x.id==='onedrive');assert.equal(od.status,'completed',od.detail);assert.equal(isAdmin,true);assert.equal(merges.length,1);assert.equal(od.evidence,'https://contoso-my.sharepoint.com/personal/leaver_example_com');assert.equal(res.body.case.steps.find(x=>x.id==='block').status,'pending');pass('Live OneDrive handover finds the personal site even when Graph hides the drive, then adds and verifies exactly one site collection administrator using the certificate');
    const signin=await import(pathToFileURL(path.join(directory,'microsoft-signin.mjs')));const auth=await import(pathToFileURL(path.join(directory,'selfhost-auth.mjs')));
    Object.assign(globalThis.__EXITWISE_TEST_ENV,{EXITWISE_SELF_HOSTED:'true',EXITWISE_ADMIN_EMAIL:owner.email,EXITWISE_SESSION_SECRET:'x'.repeat(48)});
    async function attempt(user,tamper=false){
      const start=await signin.startSignIn(new Request('https://example.test/api/auth/microsoft'));const auth2=new URL(start.headers.get('location'));const cookie=start.headers.get('set-cookie').split(';')[0];
      assert.equal(auth2.searchParams.get('redirect_uri'),'https://example.test/api/auth/microsoft/callback');assert.equal(auth2.searchParams.get('code_challenge_method'),'S256');
      const claims={aud:'test-client',tid:'11111111-1111-1111-1111-111111111111',iss:'https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0',nonce:auth2.searchParams.get('nonce'),exp:Math.floor(Date.now()/1000)+600,preferred_username:user};
      globalThis.fetch=async(input,options={})=>{assert.ok(String(input).endsWith('/oauth2/v2.0/token'));const b=new URLSearchParams(options.body);assert.equal(b.get('grant_type'),'authorization_code');assert.ok(b.get('code_verifier'));return Response.json({id_token:'e30.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.sig'});};
      return signin.finishSignIn(new Request('https://example.test/api/auth/microsoft/callback?code=abc&state='+(tamper?'forged':auth2.searchParams.get('state')),{headers:{cookie}}));
    }
    let done1=await attempt('Admin@Example.com');assert.equal(done1.status,200);const session=done1.headers.getSetCookie().find(v=>v.startsWith(auth.sessionCookie+'=')).split(';')[0];
    assert.equal((await auth.selfHostedUser(new Headers({cookie:session}))).email,owner.email);
    assert.match((await attempt('stranger@example.com')).headers.get('location'),/error=not_allowed/);assert.match((await attempt(owner.email,true)).headers.get('location'),/error=microsoft_expired/);
    globalThis.__EXITWISE_TEST_ENV.OFFBOARDING_ADMIN_EMAILS='other@example.com';globalThis.__EXITWISE_TEST_ENV.EXITWISE_ADMIN_EMAIL='root@example.com';assert.equal(await auth.selfHostedUser(new Headers({cookie:session})),null);
    pass('Microsoft sign-in admits only listed users, rejects forged state, and removal from the list ends the session');
  }
  console.log(`\n${checks} workflow and authorization checks passed.`);
} finally {globalThis.fetch=originalFetch;sql.close();await rm(directory,{recursive:true,force:true});}
