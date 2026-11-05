export type ScanCriteria={days:number;includeGuests:boolean};
export type DirectoryUser={
  id:string;displayName?:string;userPrincipalName?:string;department?:string|null;
  accountEnabled?:boolean;userType?:string;createdDateTime?:string|null;
  assignedLicenses?:{skuId:string}[];
  licenseAssignmentStates?:{skuId:string;state?:string;assignedByGroup?:string|null}[]|null;
  signInActivity?:{lastSuccessfulSignInDateTime?:string|null;lastSignInDateTime?:string|null;lastNonInteractiveSignInDateTime?:string|null}|null;
};
export type ReportLicense={id:string;name:string;state:"Active"|"Partial"|"Disabled"|"Error"|"Unknown";source:"Direct"|"Group"|"Direct + group"|"Unknown"};
export type InactiveAccount={
  id:string;name:string;upn:string;department:string;enabled:boolean|null;userType:string;
  createdAt:string|null;lastSuccess:string|null;lastAttempt:string|null;daysInactive:number|null;
  category:"inactive"|"unknown";historyReason:string|null;licenses:ReportLicense[];
};
export type InactivityReport={
  id:string;mode:"live";criteria:ScanCriteria;startedAt:string;generatedAt:string;cutoff:string;
  scannedUsers:number;licensedUsers:number;recentLicensedUsers:number;inactiveUsers:number;unknownHistoryUsers:number;
  warnings:string[];accounts:InactiveAccount[];
};
export function activeAssignments(a:InactiveAccount){return a.licenses.filter(l=>l.state==="Active"||l.state==="Partial");}
function timestamp(v:unknown):string|null {if(typeof v!=="string"||!v.trim())return null;const ms=Date.parse(v);return Number.isFinite(ms)?new Date(ms).toISOString():null;}
export function buildInactivityReport(users:DirectoryUser[],criteria:ScanCriteria,mode:"live",now=new Date(),names:Record<string,string>={},warnings:string[]=[]):InactivityReport {
  if(!Number.isInteger(criteria.days)||criteria.days<1||criteria.days>3650)throw new Error("Choose an inactivity threshold between 1 and 3650 days.");
  const current=now.getTime(),cutoff=current-criteria.days*86400000,accounts:InactiveAccount[]=[];
  let licensedUsers=0,recentLicensedUsers=0,scopedUsers=0;
  const seen=new Set<string>();
  for(const user of users){
    if(!user.id||seen.has(user.id))continue;seen.add(user.id);
    if(!criteria.includeGuests&&user.userType!=="Member")continue;scopedUsers++;
    if(!Array.isArray(user.assignedLicenses)||!user.assignedLicenses.length)continue;licensedUsers++;
    const success=timestamp(user.signInActivity?.lastSuccessfulSignInDateTime);
    const isFuture=success!==null&&Date.parse(success)>current;
    if(success&&!isFuture&&Date.parse(success)>cutoff){recentLicensedUsers++;continue;}
    const licenses:ReportLicense[]=[...new Map(user.assignedLicenses.map(l=>[l.skuId.toLowerCase(),l])).values()].map(l=>{
      const sources=(user.licenseAssignmentStates||[]).filter(s=>s.skuId.toLowerCase()===l.skuId.toLowerCase());
      const state:ReportLicense["state"]=sources.some(s=>s.state==="Active")?"Active":sources.some(s=>s.state==="ActiveWithError")?"Partial":sources.some(s=>s.state==="Error")?"Error":sources.some(s=>s.state==="Disabled")?"Disabled":"Unknown";
      const group=sources.some(s=>!!s.assignedByGroup),direct=sources.some(s=>s.assignedByGroup===null);
      return {id:l.skuId,name:names[l.skuId.toLowerCase()]||l.skuId,state,source:group&&direct?"Direct + group":group?"Group":direct?"Direct":"Unknown"};
    });
    const unknown=!success||isFuture;
    accounts.push({id:user.id,name:user.displayName||user.userPrincipalName||user.id,upn:user.userPrincipalName||"",department:user.department||"—",enabled:typeof user.accountEnabled==="boolean"?user.accountEnabled:null,userType:user.userType||"Unknown",createdAt:timestamp(user.createdDateTime),lastSuccess:unknown?null:success,lastAttempt:timestamp(user.signInActivity?.lastSignInDateTime),daysInactive:unknown?null:Math.floor((current-Date.parse(success!))/86400000),category:unknown?"unknown":"inactive",historyReason:isFuture?"The returned successful sign-in is in the future. Verify the source timestamp.":!success?"No successful sign-in timestamp is available. This does not prove the account never signed in.":null,licenses});
  }
  accounts.sort((a,b)=>(b.daysInactive??-1)-(a.daysInactive??-1)||a.name.localeCompare(b.name));
  return {id:crypto.randomUUID(),mode,criteria,startedAt:now.toISOString(),generatedAt:now.toISOString(),cutoff:new Date(cutoff).toISOString(),scannedUsers:scopedUsers,licensedUsers,recentLicensedUsers,inactiveUsers:accounts.filter(a=>a.category==="inactive").length,unknownHistoryUsers:accounts.filter(a=>a.category==="unknown").length,warnings,accounts};
}
export function inactivityCsv(report:InactivityReport,accounts:InactiveAccount[]){
  const cell=(v:unknown)=>{let value=String(v??"");if(/^[\s]*[=+@\-\t\r]/.test(value))value="'"+value;return '"'+value.replaceAll('"','""')+'"';};
  const rows:unknown[][]=[["Mode","Report generated UTC","Threshold days","Cutoff UTC","User object ID","Employee","Sign-in name","Department","Account status","User type","Last successful sign-in UTC","Days since success","History classification","Created UTC","Assigned licenses","Assignment states","Assignment sources"]];
  for(const a of accounts)rows.push([report.mode,report.generatedAt,report.criteria.days,report.cutoff,a.id,a.name,a.upn,a.department,a.enabled===null?"Unknown":a.enabled?"Enabled":"Disabled",a.userType,a.lastSuccess,a.daysInactive,a.category==="unknown"?"Unknown sign-in history":"Inactive by threshold",a.createdAt,a.licenses.map(l=>l.name+" ("+l.id+")").join("; "),a.licenses.map(l=>l.name+": "+l.state).join("; "),a.licenses.map(l=>l.name+": "+l.source).join("; ")]);
  return "\uFEFF"+rows.map(row=>row.map(cell).join(",")).join("\r\n");
}
