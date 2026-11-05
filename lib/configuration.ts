import { env } from "cloudflare:workers";
import { z } from "zod";

export type MicrosoftConfiguration = {
  MS_TENANT_ID?: string;
  MS_CLIENT_ID?: string;
  MS_CLIENT_SECRET?: string;
  OFFBOARDING_ADMIN_EMAILS?: string;
  OFFBOARDING_LIVE_ENABLED?: string;
  OFFBOARDING_PROTECTED_USERS?: string;
  MS_CERTIFICATE?: string;
  MS_CERTIFICATE_KEY?: string;
};
type Runtime = MicrosoftConfiguration & {
  DB: D1Database;
  EXITWISE_CONFIG_KEY?: string;
  EXITWISE_CONFIG_ADMINS?: string;
  EXITWISE_SELF_HOSTED?: string;
  EXITWISE_ADMIN_EMAIL?: string;
};
type Stored = { data: string; revision: number; updated_at: string; updated_by: string };
const runtime = () => env as unknown as Runtime;
const keys = ["MS_TENANT_ID", "MS_CLIENT_ID", "MS_CLIENT_SECRET", "OFFBOARDING_ADMIN_EMAILS", "OFFBOARDING_LIVE_ENABLED", "OFFBOARDING_PROTECTED_USERS", "MS_CERTIFICATE", "MS_CERTIFICATE_KEY"] as const;
const splitEmails = (value = "") => value.split(",").map(v => v.trim().toLowerCase()).filter(Boolean);
const aad = new TextEncoder().encode("exitwise.microsoft-configuration.v1");
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));

export function canManageConfiguration(email: string): boolean {
  const c = runtime();
  const admins = c.EXITWISE_SELF_HOSTED === "true" ? c.EXITWISE_ADMIN_EMAIL : c.EXITWISE_CONFIG_ADMINS;
  return splitEmails(admins).includes(email.toLowerCase());
}
// Workspace sign-in: the installation administrator plus the operator list edited in Connections.
export async function canSignIn(email: string): Promise<boolean> {
  const e = email.trim().toLowerCase(); if (!e) return false;
  if (splitEmails(runtime().EXITWISE_ADMIN_EMAIL).includes(e)) return true;
  try { return splitEmails((await microsoftConfiguration()).OFFBOARDING_ADMIN_EMAILS).includes(e); } catch { return false; }
}
export function configurationAvailable(): boolean { return !!runtime().EXITWISE_CONFIG_KEY; }
async function encryptionKey() {
  try {
    const bytes = decode(runtime().EXITWISE_CONFIG_KEY || "");
    if (bytes.length !== 32) throw new Error();
    return await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  } catch { throw new Error("The environment editor needs a valid server encryption key. Ask the host administrator to configure EXITWISE_CONFIG_KEY."); }
}
async function storedConfiguration(): Promise<Stored | null> {
  return runtime().DB.prepare("SELECT data, revision, updated_at, updated_by FROM connection_configuration WHERE id = ?").bind("microsoft").first<Stored>();
}
async function decrypt(data: string): Promise<MicrosoftConfiguration> {
  try {
    const packet = JSON.parse(data) as { v: number; iv: string; ciphertext: string };
    if (packet.v !== 1) throw new Error();
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(packet.iv), additionalData: aad }, await encryptionKey(), decode(packet.ciphertext));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch { throw new Error("Saved connection settings could not be decrypted. Restore the original server encryption key before continuing."); }
}
async function effective(row: Stored | null): Promise<MicrosoftConfiguration> {
  const fallback: MicrosoftConfiguration = {};
  for (const key of keys) if (runtime()[key] !== undefined) fallback[key] = runtime()[key];
  return row ? { ...fallback, ...await decrypt(row.data) } : fallback;
}
export async function microsoftConfiguration(): Promise<MicrosoftConfiguration> { return effective(await storedConfiguration()); }
export async function configurationSnapshot(actor: string) {
  if (!canManageConfiguration(actor)) throw new Error("Only a configuration administrator can edit this connection.");
  const row = await storedConfiguration();
  const c = await effective(row);
  return {
    revision: row?.revision || 0,
    ready: configurationAvailable(),
    tenantId: c.MS_TENANT_ID || "",
    clientId: c.MS_CLIENT_ID || "",
    secretConfigured: !!c.MS_CLIENT_SECRET,
    certificate: c.MS_CERTIFICATE || "",
    certificateKeyConfigured: !!c.MS_CERTIFICATE_KEY,
    adminEmails: c.OFFBOARDING_ADMIN_EMAILS || actor,
    protectedUsers: c.OFFBOARDING_PROTECTED_USERS || "",
    liveEnabled: c.OFFBOARDING_LIVE_ENABLED === "true",
    source: row ? "editor" : "host",
    updatedAt: row?.updated_at || null,
    updatedBy: row?.updated_by || null,
  };
}
const emailList = z.string().max(4000).transform(value => [...new Set(splitEmails(value))]).refine(values => values.every(v => z.string().email().max(254).safeParse(v).success), "Enter comma-separated email addresses.").transform(values => values.join(","));
export const configurationInput = z.object({
  revision: z.number().int().nonnegative(),
  tenantId: z.string().trim().uuid(),
  clientId: z.string().trim().uuid(),
  clientSecret: z.string().max(8192).refine(v => !/[\r\n\x00]/.test(v)).optional(),
  clearSecret: z.boolean().default(false),
  certificate: z.string().max(16000).optional(),
  certificateKey: z.string().max(16000).optional(),
  clearCertificate: z.boolean().default(false),
  adminEmails: emailList.refine(value => value.length > 0, "At least one operator is required."),
  protectedUsers: emailList,
  liveEnabled: z.boolean(),
}).strict();
export async function saveConfiguration(actor: string, value: unknown) {
  if (!canManageConfiguration(actor)) throw new Error("Only a configuration administrator can edit this connection.");
  const input = configurationInput.parse(value);
  const row = await storedConfiguration();
  if ((row?.revision || 0) !== input.revision) throw new Error("Connection settings changed in another session. Reload the editor before saving.");
  const old = await effective(row);
  const secret = input.clearSecret ? "" : input.clientSecret || old.MS_CLIENT_SECRET || "";
  if (input.clearSecret && input.clientSecret) throw new Error("Choose either replace or clear the client secret.");
  if ((input.tenantId !== old.MS_TENANT_ID || input.clientId !== old.MS_CLIENT_ID) && old.MS_CLIENT_SECRET && !input.clientSecret && !input.clearSecret) throw new Error("Enter a new client secret when changing the tenant or application ID.");
  if (input.liveEnabled && !secret) throw new Error("Configure a client secret before enabling live account changes.");
  const pem = (v: string | undefined, label: RegExp) => { const t = (v || "").trim(); if (t && !label.test(t)) throw new Error("Paste the full PEM text, including the BEGIN and END lines."); return t; };
  const certificate = input.clearCertificate ? "" : pem(input.certificate, /^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/) || old.MS_CERTIFICATE || "";
  const certificateKey = input.clearCertificate ? "" : pem(input.certificateKey, /^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----$/) || old.MS_CERTIFICATE_KEY || "";
  if (!!certificate !== !!certificateKey) throw new Error("Save the certificate and its private key together.");
  const c: MicrosoftConfiguration = { MS_TENANT_ID: input.tenantId, MS_CLIENT_ID: input.clientId, MS_CLIENT_SECRET: secret, OFFBOARDING_ADMIN_EMAILS: input.adminEmails, OFFBOARDING_PROTECTED_USERS: input.protectedUsers, OFFBOARDING_LIVE_ENABLED: String(input.liveEnabled), MS_CERTIFICATE: certificate, MS_CERTIFICATE_KEY: certificateKey };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, await encryptionKey(), new TextEncoder().encode(JSON.stringify(c)));
  const data = JSON.stringify({ v: 1, iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) });
  const now = new Date().toISOString();
  const result = row
    ? await runtime().DB.prepare("UPDATE connection_configuration SET data = ?, revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ? AND revision = ?").bind(data, now, actor, "microsoft", input.revision).run()
    : await runtime().DB.prepare("INSERT INTO connection_configuration(id,data,revision,updated_at,updated_by) VALUES (?,?,1,?,?) ON CONFLICT(id) DO NOTHING").bind("microsoft", data, now, actor).run();
  if (result.meta.changes !== 1) throw new Error("Connection settings changed in another session. Reload the editor before saving.");
  return configurationSnapshot(actor);
}
