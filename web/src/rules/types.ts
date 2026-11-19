// Shapes of the rule routes (worker/src/rules/routes.ts) and the editor's draft.

export const FIELDS = ["from", "to", "recipient", "tag", "subject", "header"] as const;
export const OPS = ["contains", "not_contains", "equals", "starts_with", "ends_with"] as const;
export const ACTIONS = ["markRead", "star", "archive", "trash", "spam", "stop"] as const;

/** Limits the Worker enforces (worker/src/rules/validate.ts); the editor keeps within them. */
export const CONDITIONS_MAX = 10;
export const RULE_TARGETS_MAX = 5;

export type Field = (typeof FIELDS)[number];
export type Op = (typeof OPS)[number];
export type Action = (typeof ACTIONS)[number];

export type Condition = { field: Field; op: Op; value: string; name?: string };

export type RuleDraft = {
  name: string;
  enabled: boolean;
  match: "all" | "any";
  conditions: Condition[];
  targetIds: number[];
} & Record<Action, boolean>;

export type Rule = RuleDraft & { id: number; position: number };

export type RuleTest = {
  matched: boolean;
  conditions: { matched: boolean }[];
  targets: string[];
} & Record<Action, boolean>;

export const newCondition = (): Condition => ({ field: "from", op: "contains", value: "" });

export function emptyDraft(): RuleDraft {
  return {
    name: "",
    enabled: true,
    match: "all",
    conditions: [newCondition()],
    targetIds: [],
    markRead: false,
    star: false,
    archive: false,
    trash: false,
    spam: false,
    stop: false,
  };
}

/** The body the create, update and test routes take. */
export function ruleBody(d: RuleDraft) {
  return {
    name: d.name,
    enabled: d.enabled,
    match: d.match,
    conditions: d.conditions.map((c) =>
      c.field === "header" ? c : { field: c.field, op: c.op, value: c.value },
    ),
    targetIds: d.targetIds,
    markRead: d.markRead,
    star: d.star,
    archive: d.archive,
    trash: d.trash,
    spam: d.spam,
    stop: d.stop,
  };
}
