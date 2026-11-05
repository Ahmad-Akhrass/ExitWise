import { env } from "cloudflare:workers";
import type { Case, Settings } from "./model";
import { deriveStatus } from "./model";


function db(): D1Database { const binding = (env as unknown as {DB:D1Database}).DB; if(!binding) throw new Error("The workspace database is unavailable."); return binding; }
const defaults: Settings = {retentionDays:90,defaultDepartment:"Operations"};
export async function listCases(owner:string): Promise<Case[]> {
  const res=await db().prepare("SELECT data, revision FROM offboarding_cases WHERE owner_id = ? ORDER BY updated_at DESC").bind(owner).all<{data:string;revision:number}>();
  return res.results.map(r=>({...JSON.parse(r.data),revision:r.revision}));
}
export async function getCase(owner:string,id:string): Promise<Case> {
  const r=await db().prepare("SELECT data, revision FROM offboarding_cases WHERE id = ? AND owner_id = ?").bind(id,owner).first<{data:string;revision:number}>();
  if(!r) throw new Error("Case not found.");
  return {...JSON.parse(r.data),revision:r.revision};
}
export async function insertCase(owner:string,c:Case) {
  await db().prepare("INSERT INTO offboarding_cases (id,owner_id,data,revision,updated_at) VALUES (?,?,?,0,?)").bind(c.id,owner,JSON.stringify(c),c.updatedAt).run();
}
export async function saveCase(owner:string,c:Case) {
  c.updatedAt=new Date().toISOString(); c.status=deriveStatus(c);
  const r=await db().prepare("UPDATE offboarding_cases SET data = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND owner_id = ? AND revision = ?").bind(JSON.stringify(c),c.updatedAt,c.id,owner,c.revision).run();
  if(r.meta.changes!==1) throw new Error("This case changed in another session. Refresh and review its latest state.");
  c.revision++;
}
export async function getSettings(owner:string):Promise<Settings> {
  const r=await db().prepare("SELECT data FROM workspace_settings WHERE owner_id = ?").bind(owner).first<{data:string}>();
  return r ? {...defaults,...JSON.parse(r.data)} : defaults;
}
export async function saveSettings(owner:string,s:Settings) {
  await db().prepare("INSERT INTO workspace_settings(owner_id,data) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET data = excluded.data").bind(owner,JSON.stringify(s)).run();
}
export async function bootstrap(owner:string,_actor:string) {
  await db().prepare("INSERT INTO workspace_settings(owner_id,data) VALUES (?,?) ON CONFLICT(owner_id) DO NOTHING").bind(owner,JSON.stringify(defaults)).run();
}
