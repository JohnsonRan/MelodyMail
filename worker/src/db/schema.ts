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

// M3: inbound mail. The body text for search lives only in messages_fts (a virtual table that
// drizzle-kit cannot describe; created by hand at the end of migration 0005).

export const messages = sqliteTable(
  "messages",
  {
    // crypto.randomUUID(); also names the raw object in R2.
    id: text("id").primaryKey(),
    // No foreign key: a message outlives the address it arrived on.
    addressId: integer("address_id").notNull(),
    direction: text("direction", { enum: ["in", "out"] }).notNull(),
    // Inbound: stored, parsed, parse_failed. Outbound (M5): sending, then the delivery status from
    // Resend, which only moves forward (worker/src/send/webhook.ts).
    status: text("status", {
      enum: [
        "stored",
        "parsed",
        "parse_failed",
        "sending",
        "sent",
        "delayed",
        "delivered",
        "bounced",
        "complained",
        "failed",
        "suppressed",
        "delivery_failed",
      ],
    }).notNull(),
    envelopeFrom: text("envelope_from").notNull(),
    envelopeTo: text("envelope_to").notNull(),
    subaddressTag: text("subaddress_tag"),
    // Filled by the queue consumer from the first 64 KB of the raw message.
    messageIdHdr: text("message_id_hdr"),
    inReplyTo: text("in_reply_to"),
    referencesHdr: text("references_hdr"),
    threadKey: text("thread_key"),
    subject: text("subject"),
    fromHdr: text("from_hdr"),
    toHdr: text("to_hdr"),
    ccHdr: text("cc_hdr"),
    // Outbound only: the Bcc list is kept for the sender's own copy.
    bccHdr: text("bcc_hdr"),
    dateHdr: text("date_hdr"),
    snippet: text("snippet"),
    rawSize: integer("raw_size").notNull(),
    hasAttachments: integer("has_attachments", { mode: "boolean" }).notNull().default(false),
    r2Key: text("r2_key").notNull(),
    // Forwards that failed after the message was stored (the copy is kept).
    forwardFailed: integer("forward_failed").notNull().default(0),
    // Parse tries, counted before each one, so a try the CPU limit kills still counts.
    attempts: integer("attempts").notNull().default(0),
    read: integer("read", { mode: "boolean" }).notNull().default(false),
    starred: integer("starred", { mode: "boolean" }).notNull().default(false),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    trashed: integer("trashed", { mode: "boolean" }).notNull().default(false),
    receivedAt: integer("received_at").notNull(),
    // M5, outbound only: Resend's email id, the client's idempotency key, and a short error code
    // (never upstream text) when the send failed.
    resendId: text("resend_id"),
    idempotencyKey: text("idempotency_key"),
    error: text("error"),
    // Outbound only: when the first Resend request that may have been accepted was made. Resend
    // dedupes a key for 24 hours from its first stored request; a same-key retry is safe only
    // inside that window.
    firstAttemptAt: integer("first_attempt_at"),
    // Outbound only: 1 once any attempt's outcome is unknown (a network error, a timeout, a 5xx,
    // or an attempt that never answered), so Resend may have accepted it. A 429 leaves it alone.
    maybeAccepted: integer("maybe_accepted").notNull().default(0),
  },
  (t) => [
    uniqueIndex("messages_resend_id").on(t.resendId),
    uniqueIndex("messages_idempotency_key").on(t.idempotencyKey),
    // The Sent folder.
    index("messages_direction_received").on(
      t.direction,
      t.trashed,
      sql`${t.receivedAt} DESC`,
      sql`${t.id} DESC`,
    ),
    index("messages_address_received").on(t.addressId, sql`${t.receivedAt} DESC`),
    // The cron step finds messages still waiting for the parser.
    index("messages_status_received").on(t.status, t.receivedAt),
    index("messages_thread_key").on(t.threadKey),
    // M4 folder lists: keyset pagination on (received_at DESC, id DESC) inside one folder.
    index("messages_folder_received").on(
      t.trashed,
      t.archived,
      sql`${t.receivedAt} DESC`,
      sql`${t.id} DESC`,
    ),
    index("messages_starred_received").on(
      t.starred,
      t.trashed,
      sql`${t.receivedAt} DESC`,
      sql`${t.id} DESC`,
    ),
    // Unread counts read only unread rows.
    index("messages_unread")
      .on(t.trashed, t.archived, t.starred, t.addressId)
      .where(sql`${t.read} = 0`),
  ],
);

// M4b: Web Push subscriptions, one per signed-in device. The cascade ends a device's push with
// its session (sign-out, revoke, recovery, expiry). p256dh and auth are the browser's public
// encryption keys, not secrets of ours.
export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("push_subscriptions_endpoint").on(t.endpoint),
    index("push_subscriptions_session").on(t.sessionId),
  ],
);

// M5: sending through Resend (docs/M5-sending.md, "Data"). The Markdown source, the rendered HTML
// and the recipients of a draft live here until it is sent; the sent copy is a JSON object in R2.
export const drafts = sqliteTable(
  "drafts",
  {
    // Chosen by the browser when compose opens, so uploads can name it before the first save.
    id: text("id").primaryKey(),
    addressId: integer("address_id"),
    // JSON arrays of bare addresses.
    toList: text("to_list").notNull().default("[]"),
    ccList: text("cc_list").notNull().default("[]"),
    bccList: text("bcc_list").notNull().default("[]"),
    subject: text("subject").notNull().default(""),
    // The Markdown source as written.
    text: text("text").notNull().default(""),
    // The message replied to or forwarded, and how.
    sourceId: text("source_id"),
    sourceKind: text("source_kind", { enum: ["reply", "replyAll", "forward"] }),
    // One per compose session: a double click, a retry and a second tab all send one email.
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("drafts_idempotency_key").on(t.idempotencyKey),
    index("drafts_updated").on(t.updatedAt),
  ],
);

// Attachments, streamed to R2 by PUT /api/uploads. An upload belongs to a draft until it is sent,
// then to the sent message; the cron removes one that belongs to neither after 24 hours.
export const uploads = sqliteTable(
  "uploads",
  {
    id: text("id").primaryKey(),
    r2Key: text("r2_key").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    createdAt: integer("created_at").notNull(),
    // No foreign keys: the draft may not be saved yet, and the cron sweeps uploads whose draft is
    // gone.
    draftId: text("draft_id"),
    messageId: text("message_id"),
  },
  (t) => [
    index("uploads_draft").on(t.draftId),
    index("uploads_message").on(t.messageId),
    index("uploads_created").on(t.createdAt),
  ],
);

// The webhook replay guard: one row per svix-id seen in the last 7 days.
export const webhookEvents = sqliteTable(
  "webhook_events",
  {
    svixId: text("svix_id").primaryKey(),
    receivedAt: integer("received_at").notNull(),
  },
  (t) => [index("webhook_events_received").on(t.receivedAt)],
);

// The last quota counts Resend reported (x-resend-daily-quota, x-resend-monthly-quota).
export const sendQuota = sqliteTable(
  "send_quota",
  {
    id: integer("id").primaryKey(),
    dailyUsed: integer("daily_used").notNull(),
    monthlyUsed: integer("monthly_used").notNull(),
    seenAt: integer("seen_at").notNull(),
  },
  (t) => [check("send_quota_single_row", sql`${t.id} = 1`)],
);

// M5b: Telegram notifications (docs/M5b-telegram.md, "Data"). One bound private chat at most. The
// webhook secret and the pending link code are stored as SHA-256 hex only.
export const telegram = sqliteTable(
  "telegram",
  {
    id: integer("id").primaryKey(),
    botUsername: text("bot_username").notNull(),
    // The https:// origin Connect ran on; message links in cards are built from it.
    origin: text("origin").notNull(),
    webhookSecretHash: text("webhook_secret_hash").notNull(),
    linkCodeHash: text("link_code_hash"),
    linkExpiresAt: integer("link_expires_at"),
    chatId: integer("chat_id"),
    chatLabel: text("chat_label"),
    language: text("language"),
    boundAt: integer("bound_at"),
    // A short code of the last failed send (blocked, rate_limited, failed), cleared on success.
    lastError: text("last_error"),
    lastErrorAt: integer("last_error_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [check("telegram_single_row", sql`${t.id} = 1`)],
);

// One row per card sent; the primary key is the send claim, so a message gets one card.
export const telegramCards = sqliteTable(
  "telegram_cards",
  {
    messageId: text("message_id")
      .primaryKey()
      .references(() => messages.id, { onDelete: "cascade" }),
    chatId: integer("chat_id").notNull(),
    // Null until sendWidget returns, and for a card that went out as a plain message.
    tgMessageId: integer("tg_message_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("telegram_cards_chat_message").on(t.chatId, t.tgMessageId)],
);

// M5c: owner settings that change while the service runs (docs/M5c-foreground.md, "Owner
// ruling"). One row at most; a missing row means every setting is at its default.
export const settings = sqliteTable(
  "settings",
  {
    id: integer("id").primaryKey(),
    // 1: no Web Push and no Telegram message while any MelodyMail page is in the foreground.
    quietForeground: integer("quiet_foreground").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [check("settings_single_row", sql`${t.id} = 1`)],
);

// M6: rules (docs/M6-rules-api.md, "Rules"). email() reads the enabled rules in position order;
// a rule's conditions are a JSON array validated on write (worker/src/rules/validate.ts). API keys
// arrive in migration 0014.
export const rules = sqliteTable(
  "rules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    enabled: integer("enabled").notNull().default(1),
    position: integer("position").notNull(),
    match: text("match", { enum: ["all", "any"] }).notNull(),
    conditions: text("conditions").notNull(),
    markRead: integer("mark_read").notNull().default(0),
    star: integer("star").notNull().default(0),
    archive: integer("archive").notNull().default(0),
    trash: integer("trash").notNull().default(0),
    stop: integer("stop").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("rules_enabled_position").on(t.enabled, t.position),
    check("rules_match", sql`${t.match} IN ('all', 'any')`),
  ],
);

// A rule forwards only to stored targets (docs/M6-rules-api.md, Decision 2). Deleting either side
// removes the link.
export const ruleForwards = sqliteTable(
  "rule_forwards",
  {
    ruleId: integer("rule_id")
      .notNull()
      .references(() => rules.id, { onDelete: "cascade" }),
    targetId: integer("target_id")
      .notNull()
      .references(() => forwardTargets.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.ruleId, t.targetId] }),
    index("rule_forwards_target_id").on(t.targetId),
  ],
);
