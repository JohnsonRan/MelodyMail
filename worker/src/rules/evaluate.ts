import { addressParser, decodeWords } from "postal-mime";

// Rule evaluation (docs/M6-rules-api.md, "Rules"). It reads only the envelope and the headers,
// never the body, and its work is bounded: at most 50 rules of 10 conditions, each header value cut
// to VALUE_MAX characters before decoding. No regular expression runs on sender input except the
// fixed white-space ones below, which are linear.

export const FIELDS = ["from", "to", "recipient", "tag", "subject", "header"] as const;
export const OPS = ["contains", "not_contains", "equals", "starts_with", "ends_with"] as const;

export type Field = (typeof FIELDS)[number];
export type Op = (typeof OPS)[number];
export type Condition = { field: Field; op: Op; value: string; name?: string };

export type Actions = {
  markRead: boolean;
  star: boolean;
  archive: boolean;
  trash: boolean;
  stop: boolean;
};

export type Rule = Actions & {
  match: "all" | "any";
  conditions: Condition[];
  /** Forward target emails, lowercase as stored. */
  targets: string[];
};

/** What email() reads; `get` joins a repeated header with ", " as Headers.get does. */
export type MailSource = {
  envelopeFrom: string;
  headers: { get(name: string): string | null };
  /** The envelope recipient without its sub-address tag (parseRecipient). */
  recipient: string;
  tag: string | null;
};

export type Decision = {
  targets: string[];
  read: boolean;
  starred: boolean;
  archived: boolean;
  trashed: boolean;
};

/** Each header value is cut to this before decoding, as ADDRESS_LIST_MAX in mail/parse.ts. */
export const VALUE_MAX = 2000;

/** Lowercased, runs of white space collapsed to one space, trimmed; no Unicode normalization. */
export function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/** A header's raw value, cut and unfolded; null when the message has no such header. */
function headerValue(source: MailSource, name: string): string | null {
  const raw = source.headers.get(name);
  return raw === null ? null : raw.slice(0, VALUE_MAX).replace(/\r?\n(?=[ \t])/g, "");
}

function addressValues(raw: string): string[] {
  return addressParser(raw, { flatten: true }).flatMap((a) =>
    [a.name, a.address].filter((v): v is string => Boolean(v)),
  );
}

/**
 * The normalized values of each field, read once per message however many conditions use them.
 * A field with no value (no tag, no Subject, a missing header) has an empty list.
 */
export class FieldReader {
  private readonly cache = new Map<string, string[]>();

  constructor(private readonly source: MailSource) {}

  values(field: Field, name = ""): string[] {
    const key = field === "header" ? `header:${name.toLowerCase()}` : field;
    let values = this.cache.get(key);
    if (!values) {
      values = this.read(field, name).map(normalize);
      this.cache.set(key, values);
    }
    return values;
  }

  private read(field: Field, name: string): string[] {
    const s = this.source;
    switch (field) {
      case "from": {
        const from = headerValue(s, "from");
        return from === null ? [s.envelopeFrom] : addressValues(from);
      }
      case "to":
        return ["to", "cc"].flatMap((h) => {
          const raw = headerValue(s, h);
          return raw === null ? [] : addressValues(raw);
        });
      case "recipient":
        return [s.recipient];
      case "tag":
        return s.tag === null ? [] : [s.tag];
      case "subject": {
        const subject = headerValue(s, "subject");
        return subject === null ? [] : [decodeWords(subject)];
      }
      case "header": {
        const value = headerValue(s, name);
        return value === null ? [] : [value];
      }
    }
  }
}

function compare(op: Op, value: string, wanted: string): boolean {
  switch (op) {
    case "contains":
    case "not_contains":
      return value.includes(wanted);
    case "equals":
      return value === wanted;
    case "starts_with":
      return value.startsWith(wanted);
    case "ends_with":
      return value.endsWith(wanted);
  }
}

/** A field with several values matches when any value does; not_contains when none contains it. */
export function conditionMatches(condition: Condition, reader: FieldReader): boolean {
  const values = reader.values(condition.field, condition.name);
  const wanted = normalize(condition.value);
  const any = values.some((v) => compare(condition.op, v, wanted));
  return condition.op === "not_contains" ? !any : any;
}

export function ruleMatches(rule: Rule, reader: FieldReader): boolean {
  const test = (c: Condition) => conditionMatches(c, reader);
  return rule.match === "all" ? rule.conditions.every(test) : rule.conditions.some(test);
}

/**
 * Runs the enabled rules in order. Every matching rule adds its actions; a matching rule with
 * `stop` ends the evaluation. Trash wins over archive: a rule-trashed message is not also archived,
 * so restoring it from Trash brings it back to the Inbox.
 */
export function evaluateRules(rules: Rule[], source: MailSource): Decision {
  const reader = new FieldReader(source);
  const targets = new Set<string>();
  const d = { read: false, starred: false, archived: false, trashed: false };
  for (const rule of rules) {
    if (!ruleMatches(rule, reader)) continue;
    for (const t of rule.targets) targets.add(t);
    d.read ||= rule.markRead;
    d.starred ||= rule.star;
    d.archived ||= rule.archive;
    d.trashed ||= rule.trash;
    if (rule.stop) break;
  }
  return { ...d, archived: d.archived && !d.trashed, targets: [...targets] };
}

/** One stored rule as loadRules reads it; `conditions` and `targets` are JSON text. */
export type RuleRow = {
  match: "all" | "any";
  conditions: string;
  mark_read: number;
  star: number;
  archive: number;
  trash: number;
  stop: number;
  targets: string;
};

export function toRule(row: RuleRow): Rule {
  return {
    match: row.match,
    conditions: JSON.parse(row.conditions) as Condition[],
    markRead: row.mark_read === 1,
    star: row.star === 1,
    archive: row.archive === 1,
    trash: row.trash === 1,
    stop: row.stop === 1,
    targets: JSON.parse(row.targets) as string[],
  };
}

/** The enabled rules in order, each with its target emails: one query (Decision 1). */
export async function loadRules(db: D1Database): Promise<Rule[]> {
  const { results } = await db
    .prepare(
      `SELECT r.match, r.conditions, r.mark_read, r.star, r.archive, r.trash, r.stop,
         (SELECT json_group_array(email) FROM (
            SELECT t.email FROM rule_forwards f JOIN forward_targets t ON t.id = f.target_id
             WHERE f.rule_id = r.id ORDER BY t.id)) AS targets
         FROM rules r WHERE r.enabled = 1 ORDER BY r.position, r.id`,
    )
    .all<RuleRow>();
  return results.map(toRule);
}
