import { acceptLoginAttempt, isSelfHosted, issueSession, sessionCookieHeader, verifyAdministrator } from "@/lib/selfhost-auth";
import { validWriteOrigin } from "@/lib/request-security";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  if (!isSelfHosted()) return new Response("Not found", { status: 404 });
  if (!validWriteOrigin(request)) return new Response("Invalid request origin", { status: 403 });
  if (Number(request.headers.get("content-length") || 0) > 3000) return new Response("Request too large", { status: 413 });
  try {
    const raw = await request.text(); if (raw.length > 3000) return new Response("Request too large", { status: 413 });
    const form = new URLSearchParams(raw);
    if (form.get("action") === "logout") return new Response(null, { status: 303, headers: { Location: "/login", "Set-Cookie": sessionCookieHeader("", request), "Cache-Control": "no-store" } });
    if (!acceptLoginAttempt()) return new Response("Too many attempts. Try again in one minute.", { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } });
    const email = form.get("email") || "", password = form.get("password") || "";
    if (email.length > 254 || password.length > 512 || !await verifyAdministrator(email, password)) return new Response(null, { status: 303, headers: { Location: "/login?error=credentials", "Cache-Control": "no-store" } });
    return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": sessionCookieHeader(await issueSession(), request), "Cache-Control": "no-store" } });
  } catch { return new Response("Sign-in is unavailable. Check the self-hosted authentication configuration.", { status: 503 }); }
}
