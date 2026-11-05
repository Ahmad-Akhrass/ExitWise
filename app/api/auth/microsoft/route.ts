import { isSelfHosted } from "@/lib/selfhost-auth";
import { startSignIn } from "@/lib/microsoft-signin";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (!isSelfHosted()) return new Response("Not found", { status: 404 });
  try { return await startSignIn(request); } catch { return new Response("Microsoft sign-in is unavailable.", { status: 503 }); }
}
