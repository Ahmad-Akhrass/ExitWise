import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const databaseSymbol = Symbol.for("exitwise.selfhost.sqlite");
export function openDatabase(filename = path.join(process.env.EXITWISE_DATA_DIR || "/data", "exitwise.sqlite")) {
  if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  return database;
}
export function migrate(database, directory) {
  database.exec("CREATE TABLE IF NOT EXISTS exitwise_migrations (name TEXT PRIMARY KEY, hash TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
    const sql = readFileSync(path.join(directory, name), "utf8");
    const hash = createHash("sha256").update(sql).digest("hex");
    const previous = database.prepare("SELECT hash FROM exitwise_migrations WHERE name = ?").get(name);
    if (previous) { if (previous.hash !== hash) throw new Error(`Applied migration ${name} changed. Restore its original file.`); continue; }
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(sql.replaceAll("--> statement-breakpoint", ""));
      database.prepare("INSERT INTO exitwise_migrations(name,hash,applied_at) VALUES (?,?,?)").run(name, hash, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
  }
}
export function d1Adapter(database) {
  class Prepared {
    constructor(query, args = []) { this.query = query; this.args = args; }
    bind(...args) { return new Prepared(this.query, args); }
    execute() { const result = database.prepare(this.query).run(...this.args); return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; }
    async first(column) { const result = database.prepare(this.query).get(...this.args) || null; return column && result ? result[column] : result; }
    async all() { return { success: true, results: database.prepare(this.query).all(...this.args), meta: {} }; }
    async run() { return this.execute(); }
    async raw() { return database.prepare(this.query).all(...this.args).map(row => Object.values(row)); }
  }
  return {
    prepare: query => new Prepared(query),
    async batch(statements) {
      database.exec("BEGIN IMMEDIATE");
      try { const results = statements.map(statement => statement.execute()); database.exec("COMMIT"); return results; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    },
    async exec(query) { database.exec(query); return { count: 1, duration: 0 }; },
  };
}
export function databaseBinding() {
  if (!globalThis[databaseSymbol]) globalThis[databaseSymbol] = d1Adapter(openDatabase());
  return globalThis[databaseSymbol];
}
