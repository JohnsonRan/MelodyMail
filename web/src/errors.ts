import type { TFunction } from "i18next";
import { ApiError } from "./api";

const KNOWN = new Set([
  "already_initialized",
  "invalid_setup_token",
  "setup_disabled",
  "verification_failed",
  "locked",
  "rate_limited",
  "last_passkey",
  "passkey_exists",
  "reauth_required",
  "invalid_domain",
  "domain_not_ascii",
  "domain_exists",
  "domain_has_addresses",
  "dns_check_failed",
  "invalid_local_part",
  "unknown_domain",
  "unknown_target",
  "forward_only_needs_target",
  "address_exists",
  "invalid_note",
  "invalid_display_name",
  "invalid_email",
  "target_exists",
  "target_in_use",
  "not_in_trash",
  "not_subscribed",
  "push_failed",
  "invalid_subscription",
  "send_not_configured",
  "attachments_not_configured",
  "sending_disabled",
  "address_disabled",
  "unknown_address",
  "no_recipients",
  "too_many_recipients",
  "invalid_recipient",
  "invalid_subject",
  "unknown_upload",
  "attachments_too_large",
  "file_too_large",
  "unknown_source",
  "send_in_progress",
  "send_status_unknown",
  "daily_quota_exceeded",
  "monthly_quota_exceeded",
  "send_rejected",
  "send_failed",
  "already_sent",
  "draft_conflict",
  "telegram_not_configured",
  "telegram_needs_https",
  "telegram_not_connected",
  "telegram_failed",
  "invalid_rule_name",
  "invalid_condition",
  "no_rule_action",
  "too_many_rule_targets",
  "too_many_rules",
  "order_mismatch",
  "no_raw",
  "too_many_header_names",
  "network",
]);

/** Maps an API or WebAuthn failure to its localized message. */
export function errorMessage(t: TFunction, err: unknown): string {
  // The browser rejects with NotAllowedError when the owner cancels or the prompt times out.
  if (err instanceof Error && err.name === "NotAllowedError") return t("errors.passkeyCancelled");
  if (err instanceof ApiError && KNOWN.has(err.code)) {
    const minutes = Math.max(1, Math.ceil((err.retryAfter ?? 60) / 60));
    return t(`errors.${err.code}`, { minutes });
  }
  return t("errors.generic");
}
