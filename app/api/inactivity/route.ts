import { validWriteOrigin } from "@/lib/request-security";
import { z } from "zod";
import { getChatGPTUser } from "../../chatgpt-auth";
import { assertReportingAccess } from "@/lib/graph";
import { loadInactivityReport,scanInactiveAccounts } from "@/lib/inactivity-service";
export const dynamic="force-dynamic";
const reply=(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"no-store"}});
export async function GET(request:Request){
  const user=await getChatGPTUser();if(!user)return reply({error:"Sign in to view your report."},401);
  try{await assertReportingAccess(user.email);return reply({report:await loadInactivityReport(user.userId,"live")});}
  catch(error){return reply({error:error instanceof Error?error.message:"Report could not be loaded."},400);}
}
export async function POST(request:Request){
  const user=await getChatGPTUser();if(!user)return reply({error:"Sign in to run an inactivity scan."},401);
  if(!validWriteOrigin(request))return reply({error:"Invalid request origin."},403);
  try{const raw=await request.text();if(raw.length>2000)return reply({error:"Request is too large."},413);const body=z.object({mode:z.literal("live").default("live"),days:z.number().int().min(1).max(3650),includeGuests:z.boolean()}).strict().parse(JSON.parse(raw));return reply({report:await scanInactiveAccounts(user.userId,user.email,body.mode,{days:body.days,includeGuests:body.includeGuests})});}
  catch(error){return reply({error:error instanceof z.ZodError?"Choose a threshold between 1 and 3650 days.":error instanceof Error?error.message:"Scan failed. The previous saved report has been kept."},400);}
}
