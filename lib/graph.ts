import type { Connection, Inventory } from "./model";
import { microsoftConfiguration } from "./configuration";
const emails=(v?:string)=>(v||"").toLowerCase().split(",").map(s=>s.trim()).filter(Boolean);
export async function connection(email:string):Promise<Connection> {
  const c=await microsoftConfiguration();return {configured:!!(c.MS_TENANT_ID&&c.MS_CLIENT_ID&&c.MS_CLIENT_SECRET),enabled:c.OFFBOARDING_LIVE_ENABLED==="true",authorized:emails(c.OFFBOARDING_ADMIN_EMAILS).includes(email.toLowerCase()),tenantId:c.MS_TENANT_ID||null};
}
export async function assertReportingAccess(actor:string) {
  const s=await connection(actor);
  if(!s.configured||!s.authorized)throw new Error("Live reporting requires server-side tenant credentials and an allowlisted operator. Review Connections setup. Live account changes can remain disabled.");
}
export async function assertLive(actor:string,target?:string) {
  const c=await microsoftConfiguration();
  if(!(c.MS_TENANT_ID&&c.MS_CLIENT_ID&&c.MS_CLIENT_SECRET)||c.OFFBOARDING_LIVE_ENABLED!=="true"||!emails(c.OFFBOARDING_ADMIN_EMAILS).includes(actor.toLowerCase()))throw new Error("Live execution requires a configured tenant, live mode enabled and an allowlisted operator.");
  const protectedUsers=[...emails(c.OFFBOARDING_ADMIN_EMAILS),...emails(c.OFFBOARDING_PROTECTED_USERS)];
  if(target && protectedUsers.includes(target.toLowerCase()))throw new Error("This account is protected from offboarding. Operator accounts are protected automatically.");
}
function requestSignal(deadline:number) {const remaining=deadline-Date.now();if(remaining<=0)throw new Error("This action reached its time budget. Inspect the current service state before retrying.");return AbortSignal.timeout(Math.min(25000,remaining));}
async function token(deadline:number):Promise<string> {
  const c=await microsoftConfiguration();if(!c.MS_TENANT_ID||!/^[0-9a-f-]{36}$/i.test(c.MS_TENANT_ID))throw new Error("Use the Microsoft Entra tenant GUID in MS_TENANT_ID.");
  const r=await fetch(`https://login.microsoftonline.com/${c.MS_TENANT_ID}/oauth2/v2.0/token`,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"client_credentials",client_id:c.MS_CLIENT_ID||"",client_secret:c.MS_CLIENT_SECRET||"",scope:"https://graph.microsoft.com/.default"}),signal:requestSignal(deadline)});
  const body=await r.json() as {access_token?:string;error?:string};if(!r.ok||!body.access_token)throw new Error("Microsoft authentication failed ("+(body.error||r.status)+"). Check the server credentials and admin consent.");return body.access_token;
}
export async function graphClient(deadline=Date.now()+80000) {
  const bearer=await token(deadline);
  async function call<T=Record<string,unknown>>(path:string,method="GET",body?:unknown):Promise<T> {
    const url=path.startsWith("https:")?new URL(path):new URL("https://graph.microsoft.com/v1.0"+path);
    if(url.origin!=="https://graph.microsoft.com"||!url.pathname.startsWith("/v1.0/"))throw new Error("Invalid Microsoft Graph endpoint.");
    const response=await fetch(url,{method,headers:{Authorization:"Bearer "+bearer,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:requestSignal(deadline)});
    if(!response.ok) {let code="GraphError";try {const b=await response.json() as {error?:{code?:string}};code=b.error?.code||code;}catch{};throw new Error(`Microsoft Graph ${response.status}: ${code}. ${response.status===429?"Throttled; retry after "+(response.headers.get("Retry-After")||"the indicated delay")+" seconds.":"Review the account, permissions and service state before retrying."}`);}
    if(response.status===204)return {} as T;const text=await response.text();return (text?JSON.parse(text):{}) as T;
  }
  async function all<T>(path:string):Promise<T[]> {const result:T[]=[];let next:string|undefined=path;let page=0;while(next){if(++page>100)throw new Error("Discovery exceeded 100 pages. Narrow and review the account manually.");const r: {value?:T[];"@odata.nextLink"?:string}=await call(next);if(!Array.isArray(r.value))throw new Error("Microsoft Graph returned an incomplete collection.");result.push(...r.value);next=r["@odata.nextLink"];}return result;}
  return {call,all};
}
const skuNames:Record<string,string>={"cbdc14ab-d96c-4c30-b9f4-6ada7cdc1d46":"Microsoft 365 Business Premium","05e9a617-0261-4cee-bb44-138d3ef5d965":"Microsoft 365 E3","06ebc4ee-1bb5-47dd-8120-11324bc54e06":"Microsoft 365 E5","6fd2c87f-b296-42f0-b197-1e91e994b900":"Office 365 E3"};
export function licenseName(skuId:string){return skuNames[skuId.toLowerCase()]||skuId;}
export async function discover(email:string,deadline=Date.now()+80000):Promise<Inventory> {
  const api=await graphClient(deadline);
  type User={id:string;accountEnabled:boolean;onPremisesSyncEnabled:boolean;userType:string;userPrincipalName:string;assignedLicenses:{skuId:string}[];licenseAssignmentStates:{skuId:string;assignedByGroup:string|null}[]};
  const u=await api.call<User>(`/users/${encodeURIComponent(email)}?$select=id,userPrincipalName,accountEnabled,onPremisesSyncEnabled,userType,assignedLicenses,licenseAssignmentStates`);
  if(u.userPrincipalName.toLowerCase()!==email.toLowerCase())throw new Error("The returned sign-in name differs from the requested target. Use the exact user principal name.");
  type Group={id:string;displayName:string;groupTypes:string[];isAssignableToRole:boolean;onPremisesSyncEnabled:boolean;assignedLicenses:{skuId:string}[]};
  type Role={id:string;roleDefinition?:{displayName?:string}};
  const [groups,roles]=await Promise.all([
    api.all<Group>(`/users/${u.id}/memberOf/microsoft.graph.group?$select=id,displayName,groupTypes,isAssignableToRole,onPremisesSyncEnabled,assignedLicenses`),
    api.all<Role>(`/roleManagement/directory/roleAssignments?$filter=${encodeURIComponent("principalId eq '"+u.id+"'")}&$expand=roleDefinition`),
  ]);
  const licensedGroupIds=(u.licenseAssignmentStates||[]).filter(s=>s.assignedByGroup).map(s=>s.assignedByGroup);
  return {id:u.id,accountEnabled:u.accountEnabled,synced:!!u.onPremisesSyncEnabled,userType:u.userType,discoveredAt:new Date().toISOString(),
    groups:groups.map(g=>({id:g.id,name:g.displayName||g.id,dynamic:g.groupTypes?.includes("DynamicMembership")||false,synced:!!g.onPremisesSyncEnabled,privileged:!!g.isAssignableToRole,licensed:licensedGroupIds.includes(g.id)||!!g.assignedLicenses?.length})),
    roles:roles.map(r=>({id:r.id,name:r.roleDefinition?.displayName||r.id})),
    licenses:(u.assignedLicenses||[]).map(l=>({id:l.skuId,name:skuNames[l.skuId]||l.skuId,inherited:(u.licenseAssignmentStates||[]).some(s=>s.skuId===l.skuId&&!!s.assignedByGroup)}))};
}
export type UserSuggestion={id:string;name:string;email:string;department:string;jobTitle:string;accountEnabled:boolean;userType:string;protected:boolean};
export async function searchUsers(query:string):Promise<UserSuggestion[]> {
  const c=await microsoftConfiguration();const protectedUsers=[...emails(c.OFFBOARDING_ADMIN_EMAILS),...emails(c.OFFBOARDING_PROTECTED_USERS)];
  const q=query.replace(/'/g,"''");const filter=`startswith(displayName,'${q}') or startswith(userPrincipalName,'${q}') or startswith(mail,'${q}')`;
  type User={id:string;displayName?:string;userPrincipalName:string;department?:string;jobTitle?:string;accountEnabled:boolean;userType?:string};
  const r=await (await graphClient()).call<{value?:User[]}>(`/users?$filter=${encodeURIComponent(filter)}&$select=id,displayName,userPrincipalName,department,jobTitle,accountEnabled,userType&$top=8`);
  return (r.value||[]).map(u=>({id:u.id,name:u.displayName||u.userPrincipalName,email:u.userPrincipalName.toLowerCase(),department:u.department||"",jobTitle:u.jobTitle||"",accountEnabled:u.accountEnabled,userType:u.userType||"Member",protected:protectedUsers.includes(u.userPrincipalName.toLowerCase())}));
}
export async function testConnection(){const api=await graphClient();await api.call("/users?$top=1&$select=id");return "Microsoft authentication and user discovery permission verified. Action permissions are evaluated by Graph at execution.";}
