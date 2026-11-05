import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core";

export const offboardingCases = sqliteTable("offboarding_cases", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(),
  data: text("data").notNull(), revision: integer("revision").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
}, (t) => [index("cases_owner_idx").on(t.ownerId)]);

export const workspaceSettings = sqliteTable("workspace_settings", {
  ownerId: text("owner_id").primaryKey(), data: text("data").notNull(),
});

export const inactivityReports = sqliteTable("inactivity_reports", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(),
  mode: text("mode").notNull(), data: text("data").notNull(),
  generatedAt: text("generated_at").notNull(),
}, (t) => [index("inactivity_owner_idx").on(t.ownerId)]);

export const connectionConfiguration = sqliteTable("connection_configuration", {
  id: text("id").primaryKey(),
  data: text("data").notNull(),
  revision: integer("revision").notNull(),
  updatedAt: text("updated_at").notNull(),
  updatedBy: text("updated_by").notNull(),
});
