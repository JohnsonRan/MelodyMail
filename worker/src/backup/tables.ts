// What the daily export writes (docs/M7-ops.md, "What is exported"). Both lists are explicit; a
// test fails when the schema holds a table or a column that neither names, so every migration
// has to decide. No exported table holds a credential (owner ruling 1, 2026-11-17).

export type ExportTable = {
  name: string;
  /** Every column, in the order the INSERT names them. */
  columns: string[];
  /** The columns that find the row again; the UPDATEs of a split row use them. */
  key: string[];
};

/** Parents before children, so a restore of the common case needs no clean-up. */
export const EXPORTED: ExportTable[] = [
  {
    name: "domains",
    columns: ["name", "receive_enabled", "send_enabled", "created_at"],
    key: ["name"],
  },
  { name: "forward_targets", columns: ["id", "email", "note", "created_at"], key: ["id"] },
  {
    name: "addresses",
    columns: [
      "id",
      "local_part",
      "domain",
      "note",
      "display_name",
      "enabled",
      "forward_only",
      "last_received_at",
      "created_at",
    ],
    key: ["id"],
  },
  {
    name: "address_forwards",
    columns: ["address_id", "target_id"],
    key: ["address_id", "target_id"],
  },
  {
    name: "rules",
    columns: [
      "id",
      "name",
      "enabled",
      "position",
      "match",
      "conditions",
      "mark_read",
      "star",
      "archive",
      "trash",
      "stop",
      "created_at",
      "updated_at",
      "spam",
    ],
    key: ["id"],
  },
  { name: "rule_forwards", columns: ["rule_id", "target_id"], key: ["rule_id", "target_id"] },
  { name: "settings", columns: ["id", "quiet_foreground", "updated_at"], key: ["id"] },
  {
    name: "messages",
    columns: [
      "id",
      "address_id",
      "direction",
      "status",
      "envelope_from",
      "envelope_to",
      "subaddress_tag",
      "message_id_hdr",
      "in_reply_to",
      "references_hdr",
      "thread_key",
      "subject",
      "from_hdr",
      "to_hdr",
      "cc_hdr",
      "bcc_hdr",
      "date_hdr",
      "snippet",
      "raw_size",
      "has_attachments",
      "r2_key",
      "forward_failed",
      "attempts",
      "read",
      "starred",
      "archived",
      "trashed",
      "trashed_at",
      "received_at",
      "resend_id",
      "idempotency_key",
      "error",
      "first_attempt_at",
      "maybe_accepted",
      "seq",
      "spam",
      "spam_at",
      "from_key",
    ],
    key: ["id"],
  },
  // The search text lives only here; re-parsing every message would cost days of the queue
  // budget. The rowid is written explicitly; the FTS5 shadow tables are not exported.
  {
    name: "messages_fts",
    columns: ["rowid", "message_id", "subject", "sender", "body"],
    key: ["rowid"],
  },
  {
    name: "drafts",
    columns: [
      "id",
      "address_id",
      "to_list",
      "cc_list",
      "bcc_list",
      "subject",
      "text",
      "source_id",
      "source_kind",
      "idempotency_key",
      "created_at",
      "updated_at",
    ],
    key: ["id"],
  },
  {
    name: "uploads",
    columns: [
      "id",
      "r2_key",
      "filename",
      "content_type",
      "size",
      "created_at",
      "draft_id",
      "message_id",
    ],
    key: ["id"],
  },
  { name: "send_quota", columns: ["id", "daily_used", "monthly_used", "seen_at"], key: ["id"] },
  {
    name: "telegram_cards",
    columns: ["message_id", "chat_id", "tg_message_id", "created_at"],
    key: ["message_id"],
  },
  // detail holds no secret by rule (worker/AGENTS.md, "Sensitive values").
  {
    name: "audit_log",
    columns: ["id", "event", "created_at", "ip", "user_agent", "detail"],
    key: ["id"],
  },
  // M8. Appended, so the table index of an export running across the deploy names the same
  // tables (docs/M8-mailbox-ux.md, "Data").
  { name: "spam_senders", columns: ["address", "created_at"], key: ["address"] },
];

/**
 * The column lists an export starts with, stored on its row. A run of code with other lists (an
 * export running across a deploy that changed them) discards that export and starts a new one,
 * so one export never mixes rows with and without a column (docs/M8-mailbox-ux.md, "Data").
 */
export const EXPORT_COLUMNS = JSON.stringify(EXPORTED.map((t) => [t.name, t.columns]));

/** Left out, with the reason. A restore from an export therefore resets every credential. */
export const EXCLUDED: Record<string, string> = {
  owner: "holds the TOTP secret",
  passkeys: "useless without owner; a restore registers again",
  sessions: "login state; restoring it would revive old sign-ins",
  auth_challenges: "login state; holds a TOTP secret during setup",
  login_attempts: "login state",
  api_keys: "a restore is a recovery, which revokes every key",
  push_subscriptions: "each row holds a device's auth secret",
  telegram: "Connect renews the binding on the restored origin",
  webhook_events: "a 7-day replay guard",
  backup_exports: "the export's own state",
  counters: "derived from messages.seq; the migration seeds it and a restore recomputes it",
  d1_migrations: "written by the migrations on the target",
  messages_fts_data: "FTS5 shadow table",
  messages_fts_idx: "FTS5 shadow table",
  messages_fts_content: "FTS5 shadow table",
  messages_fts_docsize: "FTS5 shadow table",
  messages_fts_config: "FTS5 shadow table",
};

/** Tables SQLite and D1 create for themselves (sqlite_sequence, _cf_*). */
export const INTERNAL_PREFIXES = ["sqlite_", "_cf_"];
