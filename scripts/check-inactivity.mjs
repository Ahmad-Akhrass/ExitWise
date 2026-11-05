import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,writeFile,readdir,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
const directory=path.resolve('.sites-runtime/inactivity-checks');await mkdir(directory,{recursive:true});
const sql=new DatabaseSync(':memory:');
for(const f of (await readdir('drizzle')).filter(f=>f.endsWith('.sql')).sort())sql.exec((await readFile('drizzle/'+f,'utf8')).replaceAll('--> statement-breakpoint',''));
class Prepared{constructor(query,args=[]){this.query=query;this.args=args;}bind(...args){return new Prepared(this.query,args);}async first(){return sql.prepare(this.query).get(...this.args)||null;}async run(){return {meta:{changes:Number(sql.prepare(this.query).run(...this.args).changes)}};}}
globalThis.__EXITWISE_INACTIVE_ENV={DB:{prepare:q=>new Prepared(q)}};
globalThis.__EXITWISE_INACTIVE_USER={userId:'owner-a',email:'admin@example.com',displayName:'Test Admin'};
await writeFile(path.join(directory,'runtime.mjs'),'export const env=globalThis.__EXITWISE_INACTIVE_ENV;');
await writeFile(path.join(directory,'auth.mjs'),'export async function getChatGPTUser(){return globalThis.__EXITWISE_INACTIVE_USER;}');
for(const [source,name] of [['lib/inactivity.ts','inactivity'],['lib/graph.ts','graph'],['lib/configuration.ts','configuration'],['lib/request-security.ts','request-security'],['lib/selfhost-auth.ts','selfhost-auth'],['lib/inactivity-service.ts','inactivity-service'],['app/api/inactivity/route.ts','route']]){
 let out=ts.transpileModule(await readFile(source,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 out=out.replaceAll('"cloudflare:workers"','"./runtime.mjs"').replaceAll('"../../chatgpt-auth"','"./auth.mjs"').replace(/(['"])(?:\.\/|@\/lib\/)(inactivity|inactivity-service|graph|configuration|request-security|selfhost-auth)\1/g,'"./$2.mjs"');await writeFile(path.join(directory,name+'.mjs'),out);
}
// Fictional directory fixture used only by these checks.
function sampleDirectoryUsers(now=new Date()){
  const ago=(days)=>new Date(now.getTime()-days*86400000).toISOString();
  const license=(skuId="sample-m365",state="Active",assignedByGroup=null)=>({assignedLicenses:[{skuId}],licenseAssignmentStates:[{skuId,state,assignedByGroup}]});
  const base={accountEnabled:true,userType:"Member",createdDateTime:ago(600)};
  return [
    {...base,id:"sample-inactive-1",displayName:"Daniel Brooks",userPrincipalName:"daniel.brooks@contoso.example",department:"Sales",...license(),signInActivity:{lastSuccessfulSignInDateTime:ago(146),lastSignInDateTime:ago(2)}},
    {...base,id:"sample-inactive-2",displayName:"Maya Patel",userPrincipalName:"maya.patel@contoso.example",department:"Finance",accountEnabled:false,...license("sample-e3","Active","sample-license-group"),signInActivity:{lastSuccessfulSignInDateTime:ago(221)}},
    {...base,id:"sample-inactive-3",displayName:"Ethan Reed",userPrincipalName:"ethan.reed@contoso.example",department:"Operations",...license("sample-powerbi","ActiveWithError"),signInActivity:{lastSuccessfulSignInDateTime:ago(97)}},
    {...base,id:"sample-unknown",displayName:"Nora Lewis",userPrincipalName:"nora.lewis@contoso.example",department:"Support",...license(),signInActivity:{lastSuccessfulSignInDateTime:null}},
    {...base,id:"sample-license-unknown",displayName:"Oliver Wilson",userPrincipalName:"oliver.wilson@contoso.example",department:"Engineering",assignedLicenses:[{skuId:"sample-e3"}],signInActivity:{lastSuccessfulSignInDateTime:ago(187)}},
    {...base,id:"sample-recent",displayName:"Ava Turner",userPrincipalName:"ava.turner@contoso.example",department:"Product",...license(),signInActivity:{lastSuccessfulSignInDateTime:ago(4),lastSignInDateTime:ago(100)}},
    {...base,id:"sample-unlicensed",displayName:"Unlicensed sample",userPrincipalName:"unlicensed@contoso.example",assignedLicenses:[],signInActivity:{lastSuccessfulSignInDateTime:ago(300)}},
    {...base,id:"sample-guest",displayName:"Guest sample",userPrincipalName:"guest@contoso.example",userType:"Guest",...license(),signInActivity:{lastSuccessfulSignInDateTime:ago(180)}},
  ];
}
const {buildInactivityReport,activeAssignments,inactivityCsv}=await import(pathToFileURL(path.join(directory,'inactivity.mjs')));
const route=await import(pathToFileURL(path.join(directory,'route.mjs')));
const {assertLive}=await import(pathToFileURL(path.join(directory,'graph.mjs')));
const originalFetch=globalThis.fetch;let calls=[],checks=0;
const pass=label=>{checks++;console.log('PASS '+label);};
const request=(body,origin='https://example.test')=>new Request('https://example.test/api/inactivity',{method:'POST',headers:{'Content-Type':'application/json',origin},body:JSON.stringify(body)});
const post=async body=>{const r=await route.POST(request(body));return {status:r.status,body:await r.json()};};
const get=async()=>{const r=await route.GET(new Request('https://example.test/api/inactivity'));return {status:r.status,body:await r.json()};};
try{
 const now=new Date('2026-10-26T00:00:00Z'),criteria={days:90,includeGuests:false},users=sampleDirectoryUsers(now);
 const report=buildInactivityReport(users,criteria,'live',now);
 assert.equal(report.inactiveUsers,4);assert.equal(report.unknownHistoryUsers,1);assert.equal(report.recentLicensedUsers,1);assert.equal(report.licensedUsers,6);pass('Threshold reporting excludes recent, unlicensed and default guest accounts');
 assert.equal(report.accounts.find(a=>a.id==='sample-inactive-1').daysInactive,146);assert.ok(!report.accounts.some(a=>a.id==='sample-recent'));pass('Recent failed attempts cannot hide inactivity; successful background use prevents a false match');
 const boundary={...users[0],id:'boundary',signInActivity:{lastSuccessfulSignInDateTime:new Date(now.getTime()-90*86400000).toISOString()}};assert.equal(buildInactivityReport([boundary],criteria,'live',now).inactiveUsers,1);pass('Exactly the chosen number of inactivity days is included');
 const unknown=report.accounts.find(a=>a.id==='sample-unknown');assert.equal(unknown.daysInactive,null);assert.match(unknown.historyReason,/does not prove/);const bad=buildInactivityReport([{...users[0],id:'invalid',signInActivity:{lastSuccessfulSignInDateTime:'not-a-date'}},{...users[0],id:'future',signInActivity:{lastSuccessfulSignInDateTime:'2030-01-01T00:00:00Z'}}],criteria,'live',now);assert.equal(bad.unknownHistoryUsers,2);assert.equal(bad.inactiveUsers,0);pass('Missing, invalid and future timestamps remain unknown rather than inactive or never signed in');
 assert.equal(buildInactivityReport(users,{...criteria,includeGuests:true},'live',now).inactiveUsers,5);assert.equal(report.accounts.find(a=>a.id==='sample-inactive-2').enabled,false);pass('Disabled licensed accounts remain visible and guest inclusion is explicit');
 const unverified=report.accounts.find(a=>a.id==='sample-license-unknown');assert.equal(unverified.licenses[0].state,'Unknown');assert.equal(activeAssignments(unverified).length,0);assert.equal(report.accounts.find(a=>a.id==='sample-inactive-3').licenses[0].state,'Partial');pass('Assignment states distinguish active, partial and unverified licenses');
 const combined={...users[0],assignedLicenses:[{skuId:'SKU'},{skuId:'SKU'}],licenseAssignmentStates:[{skuId:'SKU',state:'Active',assignedByGroup:null},{skuId:'SKU',state:'Disabled',assignedByGroup:'group'}]};const row=buildInactivityReport([combined],criteria,'live',now).accounts[0];assert.equal(row.licenses.length,1);assert.equal(row.licenses[0].state,'Active');assert.equal(row.licenses[0].source,'Direct + group');pass('Duplicate direct and inherited sources count one assigned SKU');
 const injection={...report.accounts[0],name:'=HYPERLINK("evil")',department:' +SUM(1,1)'};const csv=inactivityCsv(report,[injection]);assert.ok(csv.includes("'=HYPERLINK"));assert.ok(csv.includes("' +SUM"));assert.ok(csv.includes('Days since success'));assert.throws(()=>buildInactivityReport([], {...criteria,days:0},'live',now));pass('CSV export neutralizes spreadsheet formulas and thresholds are validated');
 const user=globalThis.__EXITWISE_INACTIVE_USER;globalThis.__EXITWISE_INACTIVE_USER=null;assert.equal((await post(criteria)).status,401);assert.equal((await get()).status,401);globalThis.__EXITWISE_INACTIVE_USER=user;assert.equal((await route.POST(request(criteria,'https://evil.example'))).status,403);pass('Reporting endpoints reject missing identity and cross-origin writes');
 assert.equal((await post({days:0,includeGuests:false})).status,400);assert.equal((await post({days:90,includeGuests:false,action:'delete'})).status,400);assert.equal((await post({mode:'demo',...criteria})).status,400);pass('The report endpoint accepts only validated read-only live scan parameters');
 globalThis.fetch=async()=>{throw new Error('Unconfigured scan attempted network access');};
 assert.equal((await post(criteria)).status,400);assert.equal((await get()).status,400);pass('Scanning requires configured credentials and an allowlisted operator');
 Object.assign(globalThis.__EXITWISE_INACTIVE_ENV,{MS_TENANT_ID:'11111111-1111-1111-1111-111111111111',MS_CLIENT_ID:'test-client',MS_CLIENT_SECRET:'test-only',OFFBOARDING_ADMIN_EMAILS:user.email,OFFBOARDING_LIVE_ENABLED:'false'});
 await assert.rejects(()=>assertLive(user.email),/Live execution requires/);
 let fail=false;
 globalThis.fetch=async(input,options={})=>{const url=new URL(String(input));calls.push({url:String(url),method:options.method||'GET'});if(url.hostname==='login.microsoftonline.com')return Response.json({access_token:'test-only'});assert.equal(options.method||'GET','GET');if(fail)return Response.json({error:{code:'Authorization_RequestDenied'}},{status:403});if(url.pathname.endsWith('/subscribedSkus'))return Response.json({error:{code:'Authorization_RequestDenied'}},{status:403});if(url.searchParams.get('page')==='2')return Response.json({value:[users.find(u=>u.id==='sample-unknown'),users.find(u=>u.id==='sample-recent')]});assert.equal(url.searchParams.get('$top'),'500');assert.ok(url.searchParams.get('$select').includes('signInActivity'));return Response.json({value:[users[0],users[1]],'@odata.nextLink':'https://graph.microsoft.com/v1.0/users?page=2'});};
 const live=await post(criteria);assert.equal(live.status,200,JSON.stringify(live.body));assert.equal(live.body.report.inactiveUsers,2);assert.equal(live.body.report.unknownHistoryUsers,1);assert.equal(live.body.report.recentLicensedUsers,1);assert.ok(calls.some(c=>c.url.endsWith('page=2')));assert.ok(calls.filter(c=>c.url.includes('graph.microsoft.com')).every(c=>c.method==='GET'));pass('Live scans follow all pages and run with account mutations disabled using GET requests only');
 assert.ok(live.body.report.warnings.some(w=>w.includes('Product-name lookup')));assert.equal((await get()).body.report.id,live.body.report.id);globalThis.__EXITWISE_INACTIVE_USER={...user,userId:'owner-b'};assert.equal((await get()).body.report,null);globalThis.__EXITWISE_INACTIVE_USER=user;pass('Optional product-name permission errors preserve usable results; saved reports persist and stay isolated to their owner');
 fail=true;const failed=await post(criteria);assert.equal(failed.status,400);assert.match(failed.body.error,/AuditLog.Read.All/);assert.equal((await get()).body.report.id,live.body.report.id);pass('Sign-in permission failures keep the last complete report instead of publishing an empty result');
 console.log(`\n${checks} inactivity-report checks passed.`);
}finally{globalThis.fetch=originalFetch;sql.close();await rm(directory,{recursive:true,force:true});}
