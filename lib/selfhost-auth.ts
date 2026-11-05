import { env } from "cloudflare:workers";
import { canSignIn } from "./configuration";
type Runtime = { EXITWISE_SELF_HOSTED?: string; EXITWISE_ADMIN_EMAIL?: string; EXITWISE_ADMIN_PASSWORD?: string; EXITWISE_SESSION_SECRET?: string; EXITWISE_PUBLIC_URL?: string };
const runtime = () => env as unknown as Runtime;
export const sessionCookie = "exitwise_session";
const duration = 8 * 60 * 60;
const encoder = new TextEncoder();
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const decode = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
export const isSelfHosted = () => runtime().EXITWISE_SELF_HOSTED === "true";
function equal(a: Uint8Array, b: Uint8Array) { if (a.length !== b.length) return false; let result = 0; for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i]; return result === 0; }
async function signingKey() {
  const secret = runtime().EXITWISE_SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("Self-hosted session signing is not configured.");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function verifyAdministrator(email: string, password: string) {
  const c = runtime();
  if (!isSelfHosted() || !c.EXITWISE_ADMIN_PASSWORD || c.EXITWISE_ADMIN_PASSWORD.length < 14 || !c.EXITWISE_ADMIN_EMAIL) return false;
  // Compare fixed-size digests without a prefix-dependent string comparison.
  const [expected, supplied] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(c.EXITWISE_ADMIN_PASSWORD)), crypto.subtle.digest("SHA-256", encoder.encode(password))]);
  return equal(new Uint8Array(expected), new Uint8Array(supplied)) && email.trim().toLowerCase() === c.EXITWISE_ADMIN_EMAIL.trim().toLowerCase();
}
export async function signValue(value: unknown) {
  const payload = encode(encoder.encode(JSON.stringify(value)));
  const signature = await crypto.subtle.sign("HMAC", await signingKey(), encoder.encode(payload));
  return `${payload}.${encode(new Uint8Array(signature))}`;
}
export async function verifyValue<T>(token: string | undefined): Promise<T | null> {
  if (!token || token.length > 4096) return null;
  try {
    const [payload, signature, extra] = token.split("."); if (!payload || !signature || extra) return null;
    if (!await crypto.subtle.verify("HMAC", await signingKey(), decode(signature), encoder.encode(payload))) return null;
    return JSON.parse(new TextDecoder().decode(decode(payload))) as T;
  } catch { return null; }
}
export async function issueSession(email = runtime().EXITWISE_ADMIN_EMAIL!) {
  const now = Math.floor(Date.now() / 1000);
  return signValue({ email: email.trim().toLowerCase(), iat: now, exp: now + duration, nonce: crypto.randomUUID() });
}
export async function selfHostedUser(headers: Headers) {
  if (!isSelfHosted()) return null;
  const token = headers.get("cookie")?.split(";").map(v => v.trim()).find(v => v.startsWith(sessionCookie + "="))?.slice(sessionCookie.length + 1);
  if (!token || token.length > 2048) return null;
  const body = await verifyValue<{ email?: unknown; iat?: unknown; exp?: unknown }>(token); if (!body) return null;
  const admin = runtime().EXITWISE_ADMIN_EMAIL?.trim().toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  if (!admin || typeof body.email !== "string" || !Number.isInteger(body.exp) || !Number.isInteger(body.iat) || (body.exp as number) <= now || (body.iat as number) > now + 30 || (body.exp as number) - (body.iat as number) !== duration) return null;
  // Removing someone from the sign-in list ends their access on the next request.
  if (!await canSignIn(body.email)) return null;
  // Everyone allowed in shares the installation workspace; audit entries still name each person.
  return { userId: "selfhost-admin:" + admin, email: body.email, displayName: body.email, fullName: null };
}
export function sessionCookieHeader(token: string, request: Request) {
  const c = runtime();
  const secure = c.EXITWISE_PUBLIC_URL ? new URL(c.EXITWISE_PUBLIC_URL).protocol === "https:" : new URL(request.url).protocol === "https:";
  return `${sessionCookie}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token ? duration : 0}${secure ? "; Secure" : ""}`;
}
// A process-wide limit bounds repeated password attempts, including attempts with forged proxy headers.
const attempts: number[] = [];
export function acceptLoginAttempt(now = Date.now()) {
  while (attempts[0] && attempts[0] < now - 60000) attempts.shift();
  if (attempts.length >= 8) return false;
  attempts.push(now); return true;
}
