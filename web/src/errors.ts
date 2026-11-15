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
