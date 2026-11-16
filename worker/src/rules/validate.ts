import type { Parsed } from "../domains/validate";
import { type Condition, FIELDS, type Field, OPS, type Op } from "./evaluate";

// Boundary validation of a rule body, shared by create, update and test
// (docs/M6-rules-api.md, "Limits"). Each failure answers one error code; the submitted value is
// never echoed.

export const RULES_MAX = 50;
/**
 * Distinct header names (case-insensitive) over all enabled rules. email() reads each named header
 * once per message, so this bounds that work; 50 rules over 500 names measured 9 to 11 ms p95.
 */
export const HEADER_NAMES_MAX = 20;
export const CONDITIONS_MAX = 10;
export const RULE_TARGETS_MAX = 5;
const NAME_MAX = 100;
const VALUE_MAX = 256;
// An HTTP token (RFC 9110, section 5.6.2): the names Headers.get accepts. RFC 5322 allows more,
// but a name outside this set makes Headers.get throw in email().
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused
const CONTROL = /[\x00-\x1f\x7f]/;

export type RuleInput = {
  name: string;
  enabled: boolean;
  match: "all" | "any";
  conditions: Condition[];
  markRead: boolean;
  star: boolean;
  archive: boolean;
  trash: boolean;
  stop: boolean;
  targetIds: number[];
};

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const err = (error: string): Parsed<never> => ({ ok: false, error });

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return (list as readonly unknown[]).includes(value);
}

function parseCondition(value: unknown): Condition | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const c = value as Record<string, unknown>;
  const field: unknown = c.field;
  const op: unknown = c.op;
  if (!isOneOf<Field>(FIELDS, field) || !isOneOf<Op>(OPS, op)) return null;
  if (typeof c.value !== "string") return null;
  const text = c.value.trim();
  if (text.length === 0 || text.length > VALUE_MAX || CONTROL.test(text)) return null;
  if (field !== "header") return c.name === undefined ? { field, op, value: text } : null;
  if (typeof c.name !== "string" || !HEADER_NAME.test(c.name)) return null;
  return { field, op, value: text, name: c.name };
}

function flag(value: unknown, fallback: boolean): boolean | null {
  if (value === undefined) return fallback;
  return typeof value === "boolean" ? value : null;
}

/**
 * A rule body. `forTest` accepts a rule that is still being written: its name is not read and it
 * may have no action yet (POST /api/rules/test only evaluates it).
 */
export function parseRule(body: Record<string, unknown>, forTest = false): Parsed<RuleInput> {
  let name = "";
  if (!forTest) {
    if (typeof body.name !== "string") return err("invalid_rule_name");
    name = body.name.trim();
    if (name.length === 0 || name.length > NAME_MAX || CONTROL.test(name)) {
      return err("invalid_rule_name");
    }
  }
  if (body.match !== "all" && body.match !== "any") return err("bad_request");
  const list = body.conditions;
  if (!Array.isArray(list) || list.length === 0 || list.length > CONDITIONS_MAX) {
    return err("invalid_condition");
  }
  const conditions: Condition[] = [];
  for (const item of list) {
    const condition = parseCondition(item);
    if (!condition) return err("invalid_condition");
    conditions.push(condition);
  }
  const ids = body.targetIds ?? [];
  if (!Array.isArray(ids) || !ids.every((v) => Number.isSafeInteger(v) && v > 0)) {
    return err("bad_request");
  }
  const targetIds = [...new Set(ids as number[])];
  if (targetIds.length > RULE_TARGETS_MAX) return err("too_many_rule_targets");
  const flags = {
    enabled: flag(body.enabled, true),
    markRead: flag(body.markRead, false),
    star: flag(body.star, false),
    archive: flag(body.archive, false),
    trash: flag(body.trash, false),
    stop: flag(body.stop, false),
  };
  if (Object.values(flags).some((v) => v === null)) return err("bad_request");
  const f = flags as Record<keyof typeof flags, boolean>;
  // "Stop processing more rules" alone is an action: it keeps later rules off matching mail.
  const acts = targetIds.length > 0 || f.markRead || f.star || f.archive || f.trash || f.stop;
  if (!acts && !forTest) return err("no_rule_action");
  return ok({ name, match: body.match, conditions, targetIds, ...f });
}
