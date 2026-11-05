import { env } from "cloudflare:workers";
import { canSignIn, microsoftConfiguration } from "./configuration";
import { issueSession, sessionCookieHeader, signValue, verifyValue } from "./selfhost-auth";

const flowCookie = "exitwise_oidc";
const flowPath = "/api/auth/microsoft";
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
type Flow = { state: string; nonce: string; verifier: string; exp: number };

export function publicOrigin(request: Request) {
  const configured = (env as unknown as { EXITWISE_PUBLIC_URL?: string }).EXITWISE_PUBLIC_URL;
  return configured ? new URL(configured).origin : new URL(request.url).origin;
}
export const redirectUri = (request: Request) => publicOrigin(request) + flowPath + "/callback";
export async function microsoftSignInReady() {
  try { const c = await microsoftConfiguration(); return !!(c.MS_TENANT_ID && c.MS_CLIENT_ID && c.MS_CLIENT_SECRET); } catch { return false; }
}
function flowCookieHeader(value: string, request: Request) {
  const secure = publicOrigin(request).startsWith("https:");
  // Lax so the cookie returns on Microsoft's top-level redirect back to the callback.
  return `${flowCookie}=${value}; HttpOnly; SameSite=Lax; Path=${flowPath}; Max-Age=${value ? 600 : 0}${secure ? "; Secure" : ""}`;
}
const toLogin = (error: string, request: Request) => new Response(null, { status: 303, headers: { Location: publicOrigin(request) + "/login?error=" + error, "Set-Cookie": flowCookieHeader("", request), "Cache-Control": "no-store" } });
// Short-lived, signed record of the Microsoft account that was refused, so the login page can tell the person
// which account to ask the administrator to add (the account name is kept out of the URL and access logs).
export const deniedCookie = "exitwise_denied";
export type DeniedAccount = { email: string; exp: number };
async function notAllowed(email: string, request: Request) {
  console.warn(`Microsoft sign-in refused: ${email || "(no username claim)"} is not on the sign-in list (admin email or Operator sign-in emails).`);
  const secure = publicOrigin(request).startsWith("https:");
  const headers = new Headers({ Location: publicOrigin(request) + "/login?error=not_allowed", "Cache-Control": "no-store" });
  headers.append("Set-Cookie", flowCookieHeader("", request));
  headers.append("Set-Cookie", `${deniedCookie}=${await signValue({ email, exp: Math.floor(Date.now() / 1000) + 300 } satisfies DeniedAccount)}; HttpOnly; SameSite=Lax; Path=/login; Max-Age=300${secure ? "; Secure" : ""}`);
  return new Response(null, { status: 303, headers });
}

export async function startSignIn(request: Request) {
  const c = await microsoftConfiguration();
  if (!c.MS_TENANT_ID || !c.MS_CLIENT_ID || !c.MS_CLIENT_SECRET) return toLogin("microsoft_unconfigured", request);
  const flow: Flow = { state: random(), nonce: random(), verifier: random(), exp: Math.floor(Date.now() / 1000) + 600 };
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(flow.verifier))));
  const url = new URL(`https://login.microsoftonline.com/${c.MS_TENANT_ID}/oauth2/v2.0/authorize`);
  url.search = new URLSearchParams({ client_id: c.MS_CLIENT_ID, response_type: "code", redirect_uri: redirectUri(request), response_mode: "query", scope: "openid profile email", state: flow.state, nonce: flow.nonce, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account" }).toString();
  return new Response(null, { status: 303, headers: { Location: url.toString(), "Set-Cookie": flowCookieHeader(await signValue(flow), request), "Cache-Control": "no-store" } });
}

export async function finishSignIn(request: Request) {
  const params = new URL(request.url).searchParams;
  const raw = request.headers.get("cookie")?.split(";").map(v => v.trim()).find(v => v.startsWith(flowCookie + "="))?.slice(flowCookie.length + 1);
  const flow = await verifyValue<Flow>(raw);
  if (params.get("error")) return toLogin("microsoft_cancelled", request);
  if (!flow || flow.exp < Date.now() / 1000 || !params.get("code") || params.get("state") !== flow.state) return toLogin("microsoft_expired", request);
  const c = await microsoftConfiguration();
  const r = await fetch(`https://login.microsoftonline.com/${c.MS_TENANT_ID}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(20000), body: new URLSearchParams({ grant_type: "authorization_code", client_id: c.MS_CLIENT_ID || "", client_secret: c.MS_CLIENT_SECRET || "", code: params.get("code")!, redirect_uri: redirectUri(request), code_verifier: flow.verifier, scope: "openid profile email" }) });
  const body = await r.json() as { id_token?: string };
  if (!r.ok || !body.id_token) return toLogin("microsoft_failed", request);
  // The ID token comes straight from Microsoft's token endpoint over TLS, so its claims are checked rather than its signature (OIDC Core 3.1.3.7).
  let claims: { aud?: string; tid?: string; iss?: string; nonce?: string; exp?: number; preferred_username?: string; email?: string; upn?: string };
  try { claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")), ch => ch.charCodeAt(0)))); } catch { return toLogin("microsoft_failed", request); }
  if (claims.aud !== c.MS_CLIENT_ID || claims.tid !== c.MS_TENANT_ID || claims.iss !== `https://login.microsoftonline.com/${c.MS_TENANT_ID}/v2.0` || claims.nonce !== flow.nonce || !claims.exp || claims.exp < Date.now() / 1000) return toLogin("microsoft_failed", request);
  const email = (claims.preferred_username || claims.email || claims.upn || "").trim().toLowerCase();
  if (!await canSignIn(email)) return notAllowed(email, request);
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  headers.append("Set-Cookie", sessionCookieHeader(await issueSession(email), request));
  headers.append("Set-Cookie", flowCookieHeader("", request));
  // A same-site follow-up navigation lets the browser send the SameSite=Strict session cookie.
  return new Response('<!doctype html><meta http-equiv="refresh" content="0;url=/"><title>Signing in…</title><p>Signing in… <a href="/">Continue</a></p>', { status: 200, headers });
}
