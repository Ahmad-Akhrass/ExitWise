import { validWriteOrigin } from "@/lib/request-security";
import { getChatGPTUser } from "../../chatgpt-auth";
import { canManageConfiguration, configurationSnapshot, saveConfiguration } from "@/lib/configuration";
import { z } from "zod";
export const dynamic = "force-dynamic";
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "Pragma": "no-cache" } });
async function authorized() {
  const user = await getChatGPTUser();
  if (!user) return { error: reply({ error: "Sign in to configure the connection." }, 401) };
  if (!canManageConfiguration(user.email)) return { error: reply({ error: "Only the configuration administrator can open this editor." }, 403) };
  return { user };
}
export async function GET() {
  const auth = await authorized(); if (auth.error) return auth.error;
  try { return reply({ configuration: await configurationSnapshot(auth.user!.email) }); }
  catch { return reply({ error: "Connection settings are unavailable. Verify the server encryption key and database migration." }, 503); }
}
export async function POST(request: Request) {
  const auth = await authorized(); if (auth.error) return auth.error;
  if (!validWriteOrigin(request)) return reply({ error: "Invalid request origin." }, 403);
  if (!request.headers.get("content-type")?.startsWith("application/json")) return reply({ error: "Send connection settings as JSON." }, 415);
  try {
    const raw = await request.text(); if (raw.length > 20000) return reply({ error: "Request is too large." }, 413);
    const configuration = await saveConfiguration(auth.user!.email, JSON.parse(raw));
    return reply({ configuration, message: "Connection settings saved. New requests use this configuration immediately." });
  } catch (error) {
    const message = error instanceof SyntaxError ? "Invalid connection settings." : error instanceof z.ZodError ? "Check the tenant GUID, client GUID, operator emails and protected account emails." : error instanceof Error ? error.message : "Connection settings could not be saved.";
    return reply({ error: message }, /another session/.test(message) ? 409 : 400);
  }
}
