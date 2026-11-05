import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDatabase, migrate } from "./sqlite.mjs";

const directory = process.env.EXITWISE_DATA_DIR || "/data";
process.umask(0o077);
mkdirSync(directory, { recursive: true, mode: 0o700 });
process.env.EXITWISE_SELF_HOSTED = "true";
for (const key of ["EXITWISE_ADMIN_PASSWORD", "EXITWISE_CONFIG_KEY", "EXITWISE_SESSION_SECRET", "MS_CLIENT_SECRET"]) {
  if (process.env[key + "_FILE"]) {
    if (process.env[key]) throw new Error(`Set either ${key} or ${key}_FILE.`);
    process.env[key] = readFileSync(process.env[key + "_FILE"], "utf8").replace(/\r?\n$/, "");
  }
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env.EXITWISE_ADMIN_EMAIL || "")) throw new Error("Set EXITWISE_ADMIN_EMAIL in .env before starting Exitwise.");
const password = process.env.EXITWISE_ADMIN_PASSWORD || "";
if (password.length < 14 || password.length > 512 || /^change|^replace|^your[-_ ]/i.test(password)) throw new Error("Set EXITWISE_ADMIN_PASSWORD to a unique password of 14–512 characters before starting Exitwise.");
function persistentSecret(key, filename) {
  if (process.env[key]) return;
  const file = path.join(directory, filename);
  try { writeFileSync(file, randomBytes(32).toString("base64"), { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  chmodSync(file, 0o600);
  process.env[key] = readFileSync(file, "utf8").trim();
}
persistentSecret("EXITWISE_CONFIG_KEY", "configuration.key");
persistentSecret("EXITWISE_SESSION_SECRET", "session.key");
if (Buffer.from(process.env.EXITWISE_CONFIG_KEY, "base64").length !== 32) throw new Error("EXITWISE_CONFIG_KEY must be a base64-encoded 32-byte key.");
if (process.env.EXITWISE_SESSION_SECRET.length < 32) throw new Error("EXITWISE_SESSION_SECRET must contain at least 32 characters.");
if (process.env.EXITWISE_PUBLIC_URL) {
  const url = new URL(process.env.EXITWISE_PUBLIC_URL);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("EXITWISE_PUBLIC_URL must contain only the public HTTP(S) origin.");
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const database = openDatabase();
migrate(database, path.join(root, "drizzle"));
database.close();
console.log("Exitwise database ready. Open the workspace and sign in with your configured administrator account.");
await import(pathToFileURL(path.join(root, "server.js")));
