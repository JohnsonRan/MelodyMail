import type { TFunction } from "i18next";
import { ACTIONS, type Condition, type RuleDraft } from "./types";

function conditionText(t: TFunction, c: Condition): string {
  return t("summary.condition", {
    field: c.field === "header" ? c.name : t(`field.${c.field}`),
    op: t(`op.${c.op}`),
    value: c.value,
  });
}

/** One line per rule for the table: "From contains github.com → Forward to a@x.com, Archive". */
export function ruleSummary(t: TFunction, rule: RuleDraft, emailOf: (id: number) => string) {
  const conditions = rule.conditions
    .map((c) => conditionText(t, c))
    .join(t(rule.match === "all" ? "summary.and" : "summary.or"));
  const actions = [
    ...(rule.targetIds.length > 0
      ? [t("action.forwardTo", { targets: rule.targetIds.map(emailOf).join(", ") })]
      : []),
    ...ACTIONS.filter((a) => rule[a]).map((a) => t(`action.${a}`)),
  ];
  return t("summary.line", { conditions, actions: actions.join(t("summary.listSeparator")) });
}
