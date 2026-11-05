// Tests the exact standalone server + startup files used by the Dockerfile, without needing a Docker daemon.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
const root = path.resolve(".next-docker/standalone");
await stat(path.join(root, "server.js"));
for (const name of ["docker", "drizzle", "public"]) await cp(path.resolve(name), path.join(root, name), { recursive: true });
await mkdir(path.join(root, ".next-docker"), { recursive: true });
await cp(path.resolve(".next-docker/static"), path.join(root, ".next-docker/static"), { recursive: true });
const directory = path.resolve(".sites-runtime/docker-server-check");
await rm(directory, { recursive: true, force: true }); await mkdir(directory, { recursive: true });
const portFinder = createServer(); portFinder.listen(0, "127.0.0.1"); await once(portFinder, "listening"); const port = portFinder.address().port; await new Promise(resolve => portFinder.close(resolve));
const origin = "http://127.0.0.1:" + port;
const email = "docker-test@example.com", password = "test-only-administrator-password";
let child, logs = "", checks = 0;
const pass = name => { checks++; console.log("PASS " + name); };
async function start() {
  child = spawn(process.execPath, ["docker/entrypoint.mjs"], { cwd: root, env: { ...process.env, NODE_ENV: "production", EXITWISE_DATA_DIR: directory, EXITWISE_ADMIN_EMAIL: email, EXITWISE_ADMIN_PASSWORD: password, EXITWISE_CONFIG_KEY: "", EXITWISE_CONFIG_KEY_FILE: "", EXITWISE_SESSION_SECRET: "", EXITWISE_SESSION_SECRET_FILE: "", EXITWISE_ADMIN_PASSWORD_FILE: "", MS_CLIENT_SECRET_FILE: "", EXITWISE_PUBLIC_URL: origin, PORT: String(port), HOSTNAME: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", value => { logs += value; }); child.stderr.on("data", value => { logs += value; });
  for (let i = 0; i < 150; i++) { if (child.exitCode !== null) throw new Error("Standalone server exited before it became ready. " + logs); try { if ((await fetch(origin + "/api/health")).ok) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error("Standalone server did not become healthy. " + logs);
}
async function stop() { if (!child || child.exitCode !== null) return; const done = once(child, "exit"); child.kill("SIGTERM"); await done; }
async function call(url, body, cookie) { return fetch(origin + url, { method: body ? "POST" : "GET", headers: { ...(cookie ? { cookie } : {}), ...(body ? { origin, "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: "manual" }); }
try {
  await start(); pass("The packaged standalone entrypoint migrates SQLite and becomes healthy");
  assert.equal((await call("/")).headers.get("location"), "/login"); assert.equal((await call("/api/workspace")).status, 401);
  assert.equal((await fetch(origin + "/api/workspace", { headers: { "oai-authenticated-user-id": "spoofed", "oai-authenticated-user-email": email } })).status, 401); pass("The actual Docker server rejects unauthenticated requests and spoofed Site identity headers");
  const page = await call("/login"); assert.equal(page.status, 200); assert.match(await page.text(), /Administrator email/); pass("The self-hosted sign-in page renders from the production build");
  const login = await fetch(origin + "/api/session", { method: "POST", headers: { origin, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email, password }), redirect: "manual" });
  assert.equal(login.status, 303); assert.equal(login.headers.get("location"), "/"); const cookie = login.headers.get("set-cookie").split(";")[0]; pass("Administrator credentials create an authenticated session on the production server");
  const workspace = await (await call("/api/workspace", { action: "bootstrap" }, cookie)).json(); assert.equal(workspace.cases.length, 0); assert.equal(workspace.selfHosted, true); assert.equal(workspace.connection.configured, false); pass("Authenticated APIs initialize an empty workspace through the SQLite runtime binding");
  const initial = await (await call("/api/environment", null, cookie)).json(); assert.equal(initial.configuration.ready, true);
  const secret = "test-only-runtime-secret";
  const saved = await call("/api/environment", { revision: 0, tenantId: "11111111-1111-4111-8111-111111111111", clientId: "22222222-2222-4222-8222-222222222222", clientSecret: secret, adminEmails: email, protectedUsers: "", liveEnabled: false }, cookie); assert.equal(saved.status, 200, await saved.clone().text()); assert.ok(!(await saved.text()).includes(secret));
  const connection = await (await call("/api/workspace", null, cookie)).json(); assert.equal(connection.connection.configured, true); assert.equal(connection.connection.enabled, false); pass("The production editor API saves encrypted credentials and updates connection status without enabling account changes");
  assert.equal((await call("/api/inactivity", { mode: "demo", days: 90, includeGuests: false }, cookie)).status, 400); const empty = await call("/api/inactivity", null, cookie); assert.equal(empty.status, 200); assert.equal((await empty.json()).report, null);
  assert.equal((await call("/api/workspace", { action: "settings", settings: { retentionDays: 45, defaultDepartment: "Finance" } }, cookie)).status, 200); pass("The standalone server rejects demo scans, serves the live report endpoint and saves workspace settings");
  await stop(); await start();
  const after = await (await call("/api/environment", null, cookie)).json(); assert.equal(after.configuration.secretConfigured, true); assert.equal(after.configuration.revision, 1); assert.equal((await (await call("/api/workspace", null, cookie)).json()).settings.retentionDays, 45); pass("Restart preserves encryption keys, credentials, session validity and workspace data");
  console.log(`\n${checks} standalone Docker-runtime checks passed.`);
} finally { await stop(); await rm(directory, { recursive: true, force: true }); }
