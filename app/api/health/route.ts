import { env } from "cloudflare:workers";
export const dynamic = "force-dynamic";
export async function GET() {
  if ((env as unknown as { EXITWISE_SELF_HOSTED?: string }).EXITWISE_SELF_HOSTED !== "true") return new Response(null, { status: 404 });
  try { await (env as unknown as { DB: D1Database }).DB.prepare("SELECT 1 AS ok").first(); return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } }); }
  catch { return Response.json({ status: "unavailable" }, { status: 503 }); }
}
