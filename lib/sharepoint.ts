import { microsoftConfiguration } from "./configuration";
import { graphClient } from "./graph";

// SharePoint REST rejects app-only tokens issued for a client secret, so site administration uses the certificate credential.
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const text = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));
const pemBytes = (pem: string) => Uint8Array.from(atob(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "")), c => c.charCodeAt(0));
function signal(deadline: number) { const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error("This action reached its time budget. Inspect the OneDrive site before retrying."); return AbortSignal.timeout(Math.min(25000, remaining)); }

async function clientAssertion(tenant: string, clientId: string, certificate: string, key: string) {
  const thumbprint = new Uint8Array(await crypto.subtle.digest("SHA-1", pemBytes(certificate)));
  const signingKey = await crypto.subtle.importKey("pkcs8", pemBytes(key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const body = `${text({ alg: "RS256", typ: "JWT", x5t: b64url(thumbprint) })}.${text({ aud: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, iss: clientId, sub: clientId, jti: crypto.randomUUID(), nbf: now - 30, exp: now + 300 })}`;
  return `${body}.${b64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, new TextEncoder().encode(body))))}`;
}
async function sharePointToken(origin: string, deadline: number) {
  const c = await microsoftConfiguration();
  if (!c.MS_CERTIFICATE || !c.MS_CERTIFICATE_KEY) throw new Error("OneDrive handover needs the app certificate. Add it under Connections → Environment editor.");
  const r = await fetch(`https://login.microsoftonline.com/${c.MS_TENANT_ID}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: signal(deadline), body: new URLSearchParams({ grant_type: "client_credentials", client_id: c.MS_CLIENT_ID || "", client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: await clientAssertion(c.MS_TENANT_ID || "", c.MS_CLIENT_ID || "", c.MS_CERTIFICATE, c.MS_CERTIFICATE_KEY), scope: origin + "/.default" }) });
  const body = await r.json() as { access_token?: string; error?: string };
  if (!r.ok || !body.access_token) throw new Error("SharePoint authentication failed (" + (body.error || r.status) + "). Check that the certificate is uploaded to the app registration.");
  return body.access_token;
}
export function oneDriveSite(webUrl: string) {
  const u = new URL(webUrl); const parts = u.pathname.split("/").filter(Boolean);
  if (u.protocol !== "https:" || !u.hostname.endsWith("-my.sharepoint.com") || parts[0] !== "personal" || !parts[1]) throw new Error("The OneDrive address returned by Microsoft is not a personal site.");
  return { origin: u.origin, url: `${u.origin}/personal/${parts[1]}` };
}
/** Adds newOwner as a site collection administrator of the target user's OneDrive and verifies it. */
/** OneDrive personal site address SharePoint derives from the sign-in name, used when Graph cannot resolve the drive (for example an unlicensed user). */
export function derivedOneDriveSite(tenantRootUrl: string, upn: string) {
  const root = new URL(tenantRootUrl); if (!root.hostname.endsWith(".sharepoint.com")) throw new Error("The tenant SharePoint address could not be determined.");
  return oneDriveSite(`https://${root.hostname.replace(/\.sharepoint\.com$/, "-my.sharepoint.com")}/personal/${upn.toLowerCase().replace(/[^a-z0-9]/g, "_")}`);
}
export async function addOneDriveOwner(targetUserId: string, targetUpn: string, newOwner: string, deadline = Date.now() + 80000): Promise<{ site: string; already: boolean }> {
  const api = await graphClient(deadline);
  let site: { origin: string; url: string };
  try { site = oneDriveSite((await api.call<{ webUrl?: string }>(`/users/${encodeURIComponent(targetUserId)}/drive?$select=webUrl`)).webUrl || ""); }
  catch (e) {
    if (!/Graph (403|404)/.test((e as Error).message)) throw e;
    // Graph hides drives of unlicensed users and needs Files.Read.All; SharePoint itself decides whether the personal site exists.
    site = derivedOneDriveSite((await api.call<{ webUrl: string }>("/sites/root?$select=webUrl")).webUrl, targetUpn);
  }
  const token = await sharePointToken(site.origin, deadline);
  async function sp<T>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
    const r = await fetch(site.url + path, { method: init.method || "GET", signal: signal(deadline), headers: { Authorization: "Bearer " + token, Accept: "application/json;odata=nometadata", "Content-Type": "application/json;odata=verbose", ...init.headers }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    if (r.status === 404) throw new Error(`No OneDrive exists at ${site.url}. The employee may never have opened OneDrive, or it was already deleted after the license was removed.`);
    if (!r.ok) { let message = ""; try { const b = await r.json() as { "odata.error"?: { message?: { value?: string } }; error?: { message?: { value?: string } | string } }; message = b["odata.error"]?.message?.value || (typeof b.error?.message === "string" ? b.error.message : b.error?.message?.value) || ""; } catch {} throw new Error(`SharePoint ${r.status}${message ? ": " + message : ""}. ${r.status === 401 || r.status === 403 ? "Grant the SharePoint application permission Sites.FullControl.All with admin consent." : "Inspect the OneDrive site before retrying."}`); }
    const t = await r.text(); return (t ? JSON.parse(t) : {}) as T;
  }
  const user = await sp<{ Id: number; IsSiteAdmin: boolean }>("/_api/web/ensureuser", { method: "POST", body: { logonName: "i:0#.f|membership|" + newOwner } });
  if (!Number.isInteger(user.Id)) throw new Error("SharePoint did not return the new owner's site user.");
  if (user.IsSiteAdmin) return { site: site.url, already: true };
  await sp(`/_api/web/GetUserById(${user.Id})`, { method: "POST", headers: { "X-HTTP-Method": "MERGE", "IF-MATCH": "*" }, body: { __metadata: { type: "SP.User" }, IsSiteAdmin: true } });
  const check = await sp<{ IsSiteAdmin: boolean }>(`/_api/web/GetUserById(${user.Id})?$select=IsSiteAdmin`);
  if (check.IsSiteAdmin !== true) throw new Error("SharePoint accepted the change, but the new owner is not yet verified as site collection administrator. Check the site before retrying.");
  return { site: site.url, already: false };
}
