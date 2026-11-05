import { isSelfHosted } from "@/lib/selfhost-auth";
import { finishSignIn } from "@/lib/microsoft-signin";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (!isSelfHosted()) return new Response("Not found", { status: 404 });
  try { return await finishSignIn(request); } catch { return new Response(null, { status: 303, headers: { Location: "/login?error=microsoft_failed", "Cache-Control": "no-store" } }); }
}
