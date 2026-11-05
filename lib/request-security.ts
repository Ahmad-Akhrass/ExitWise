import { env } from "cloudflare:workers";
export function validWriteOrigin(request: Request): boolean {
  const c = env as unknown as { EXITWISE_SELF_HOSTED?: string; EXITWISE_PUBLIC_URL?: string };
  const origin = request.headers.get("origin");
  if (!origin || request.headers.get("sec-fetch-site") === "cross-site") return false;
  try {
    const expected = c.EXITWISE_PUBLIC_URL ? new URL(c.EXITWISE_PUBLIC_URL).origin : new URL(request.url).origin;
    return origin === expected || (c.EXITWISE_SELF_HOSTED !== "true" && origin === "https://exitwise-offboarding.windyraven8.chatgpt.site");
  } catch { return false; }
}
