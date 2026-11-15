import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

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
    // Last Passkey assertion or recovery on this session; sensitive actions need it recent.
    reauthAt: integer("reauth_at"),
    // Set only by a recovery: until then (at most 30 minutes) the session counts as fresh, and
    // adding a Passkey on it ends that early.
    recoveryFreshUntil: integer("recovery_fresh_until"),
    // Where the session was opened (owner ruling G, amended 2026-11-16): the IP from
    // cf-connecting-ip, the rest from request.cf, written with the session.
    ip: text("ip"),
    country: text("country"),
    region: text("region"),
    city: text("city"),
    organization: text("organization"),
    // "cf" (location from request.cf), "local" (private or loopback address) or null (none).
    geoSource: text("geo_source"),
  },
  (t) => [index("sessions_expires_at").on(t.expiresAt)],
);

export const authChallenges = sqliteTable("auth_challenges", {
  id: text("id").primaryKey(),
  purpose: text("purpose", { enum: ["setup", "login", "add-passkey", "reauth"] }).notNull(),
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
  // Which domain, address or forwarding target the event touched. Never a secret.
  detail: text("detail"),
});

// M2: domains, addresses and forwarding targets.

export const domains = sqliteTable("domains", {
  // Lowercase ASCII (an internationalized name in its xn-- form); never renamed.
  name: text("name").primaryKey(),
  receiveEnabled: integer("receive_enabled", { mode: "boolean" }).notNull().default(true),
  sendEnabled: integer("send_enabled", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
});

export const addresses = sqliteTable(
  "addresses",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // Lowercase; the part before "@" (and before any "+tag").
    localPart: text("local_part").notNull(),
    // No cascade: removing a domain that still has addresses is refused unless they are
    // deleted in the same request.
    domain: text("domain")
      .notNull()
      .references(() => domains.name),
    note: text("note").notNull().default(""),
    displayName: text("display_name").notNull().default(""),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    // Forward to the default targets without keeping a copy.
    forwardOnly: integer("forward_only", { mode: "boolean" }).notNull().default(false),
    lastReceivedAt: integer("last_received_at"),
    createdAt: integer("created_at").notNull(),
  },
  // Inbound mail (M3) finds its address with one lookup on this index.
  (t) => [uniqueIndex("addresses_domain_local_part").on(t.domain, t.localPart)],
);

export const forwardTargets = sqliteTable("forward_targets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Lowercase. Must be a verified destination address in the Cloudflare account.
  email: text("email").notNull().unique(),
  note: text("note").notNull().default(""),
  createdAt: integer("created_at").notNull(),
});

export const addressForwards = sqliteTable(
  "address_forwards",
  {
    addressId: integer("address_id")
      .notNull()
      .references(() => addresses.id, { onDelete: "cascade" }),
    targetId: integer("target_id")
      .notNull()
      .references(() => forwardTargets.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.addressId, t.targetId] }),
    index("address_forwards_target_id").on(t.targetId),
  ],
);
