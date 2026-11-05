import { databaseBinding } from "./sqlite.mjs";
// This module is a server-build alias. Browser bundles never import it.
export const env = new Proxy({}, {
  get(_target, name) { return name === "DB" ? databaseBinding() : process.env[name]; },
});
