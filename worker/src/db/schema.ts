import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Times are Unix epoch milliseconds. No column ever holds a secret in clear: the recovery key and
// session tokens are stored as SHA-256 hex. The TOTP secret must be readable to check codes.

export const owner = sqliteTable(
  "owner",
  {
    id: integer("id").primaryKey(),
    totpSecret: text("totp_secret").notNull(),
    totpLastStep: integer("totp_last_step").notNull().default(0),
    recoveryKeyHash: text("recovery_key_hash").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [check("owner_single_row", sql`${t.id} = 1`)],
);

export const passkeys = sqliteTable("passkeys", {
  // WebAuthn credential id, base64url.
  id: text("id").primaryKey(),
  // COSE public key, base64url.
  publicKey: text("public_key").notNull(),
  counter: integer("counter").notNull(),
  // JSON array of AuthenticatorTransport values.
  transports: text("transports").notNull().default("[]"),
  label: text("label").notNull(),
  createdAt: integer("created_at").notNull(),
  lastUsedAt: integer("last_used_at"),
});

export const sessions = sqliteTable(
  "sessions",
  {
    // SHA-256 hex of the cookie token.
    id: text("id").primaryKey(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    userAgent: text("user_agent").notNull().default(""),
  },
  (t) => [index("sessions_expires_at").on(t.expiresAt)],
);

export const authChallenges = sqliteTable("auth_challenges", {
  id: text("id").primaryKey(),
  purpose: text("purpose", { enum: ["setup", "login", "add-passkey"] }).notNull(),
  challenge: text("challenge").notNull(),
  // Only for purpose "setup": the TOTP secret offered with the registration options.
  totpSecret: text("totp_secret"),
  expiresAt: integer("expires_at").notNull(),
});

export const loginAttempts = sqliteTable(
  "login_attempts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    scope: text("scope").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("login_attempts_scope_created_at").on(t.scope, t.createdAt)],
);

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  event: text("event").notNull(),
  createdAt: integer("created_at").notNull(),
  ip: text("ip").notNull().default(""),
  userAgent: text("user_agent").notNull().default(""),
});
