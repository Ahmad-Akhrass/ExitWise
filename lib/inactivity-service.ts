import { env } from "cloudflare:workers";
import { assertReportingAccess,graphClient,licenseName } from "./graph";
import { buildInactivityReport } from "./inactivity";
import type { DirectoryUser,InactivityReport,ScanCriteria } from "./inactivity";
const db=()=> (env as unknown as {DB:D1Database}).DB;
export async function loadInactivityReport(owner:string,mode:"live"):Promise<InactivityReport|null>{
  const row=await db().prepare("SELECT data FROM inactivity_reports WHERE owner_id = ? AND mode = ?").bind(owner,mode).first<{data:string}>();return row?JSON.parse(row.data):null;
}
export async function scanInactiveAccounts(owner:string,actor:string,mode:"live",criteria:ScanCriteria):Promise<InactivityReport>{
  const startedAt=new Date().toISOString();let users:DirectoryUser[];const names:Record<string,string>={},warnings:string[]=[];
  {
    await assertReportingAccess(actor);const api=await graphClient();
    // Select signInActivity explicitly. Include both successful interactive and non-interactive use.
    // Filter locally: signInActivity filters cannot be combined with other user-property filters.
    try{users=await api.all<DirectoryUser>("/users?$select=id,displayName,userPrincipalName,department,accountEnabled,userType,createdDateTime,assignedLicenses,licenseAssignmentStates,signInActivity&$top=500");}
    catch(error){throw new Error("Unable to read the full sign-in report. Live reporting needs Microsoft Entra ID P1/P2 and admin consent for User.Read.All + AuditLog.Read.All. "+(error instanceof Error?error.message:"Please retry."));}
    for(const u of users)for(const l of u.assignedLicenses||[])names[l.skuId.toLowerCase()]=licenseName(l.skuId);
    try{const skus=await api.all<{skuId:string;skuPartNumber:string}>("/subscribedSkus?$select=skuId,skuPartNumber");for(const sku of skus)if(sku.skuId&&sku.skuPartNumber&&licenseName(sku.skuId)===sku.skuId)names[sku.skuId.toLowerCase()]=sku.skuPartNumber;}
    catch{warnings.push("Product-name lookup was unavailable. Unrecognized products show their SKU IDs. LicenseAssignment.Read.All permits the optional subscribed-product lookup.");}
    warnings.push("Microsoft sign-in activity can take up to 24 hours to update. Missing successful sign-in dates are classified as unknown, not as never signed in.");
  }
  const report=buildInactivityReport(users,criteria,mode,new Date(),names,warnings);report.startedAt=startedAt;
  const data=JSON.stringify(report);
  if(new TextEncoder().encode(data).length>1800000)throw new Error("This report exceeds the interactive report size. No partial result was saved. Narrow the scope or increase the inactivity threshold and scan again.");
  await db().prepare("INSERT INTO inactivity_reports(id,owner_id,mode,data,generated_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, generated_at=excluded.generated_at").bind(owner+":"+mode,owner,mode,data,report.generatedAt).run();
  return report;
}
