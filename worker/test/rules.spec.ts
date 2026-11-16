import { describe, expect, it } from "vitest";
import {
  type Condition,
  evaluateRules,
  type MailSource,
  type Rule,
  VALUE_MAX,
} from "../src/rules/evaluate";

// Rules (docs/M6-rules-api.md, "Rules"): evaluation units. The email() and consumer paths are in
// inbound.spec.ts and consumer.spec.ts.

function source(headers: Record<string, string | string[]> = {}, extra: Partial<MailSource> = {}) {
  const h = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    for (const v of [value].flat()) h.append(name, v);
  }
  return {
    envelopeFrom: "bounce@env.example",
    headers: h,
    recipient: "shop@example.com",
    tag: null,
    ...extra,
  };
}

const NONE = { markRead: false, star: false, archive: false, trash: false, stop: false };

function rule(conditions: Condition[], extra: Partial<Rule> = {}): Rule {
  return { match: "all", conditions, targets: [], ...NONE, markRead: true, ...extra };
}

/** Whether one condition matches the source. */
function hits(c: Condition, s: MailSource): boolean {
  return evaluateRules([rule([c])], s).read;
}

const MAIL = source({
  From: '"GitHub" <Notifications@GitHub.com>',
  To: "Shop <shop@example.com>, other@example.net",
  Cc: "Team <team@example.org>",
  Subject: "Build  FAILED\ton main",
  "List-Id": "<repo.github.com>",
});

describe("rule conditions", () => {
  it("reads each field with each operator", () => {
    const cases: [Condition, boolean][] = [
      [{ field: "from", op: "contains", value: "github.com" }, true],
      [{ field: "from", op: "equals", value: "github" }, true],
      [{ field: "from", op: "equals", value: "notifications@github.com" }, true],
      [{ field: "from", op: "starts_with", value: "notif" }, true],
      [{ field: "from", op: "ends_with", value: "@github.com" }, true],
      [{ field: "from", op: "ends_with", value: "hub.com" }, true],
      [{ field: "from", op: "ends_with", value: "@gitlab.com" }, false],
      [{ field: "from", op: "not_contains", value: "github" }, false],
      [{ field: "from", op: "not_contains", value: "gitlab" }, true],
      [{ field: "to", op: "equals", value: "other@example.net" }, true],
      [{ field: "to", op: "equals", value: "team" }, true],
      [{ field: "to", op: "ends_with", value: "@example.org" }, true],
      [{ field: "to", op: "not_contains", value: "shop@" }, false],
      [{ field: "to", op: "not_contains", value: "nobody" }, true],
      [{ field: "recipient", op: "equals", value: "shop@example.com" }, true],
      [{ field: "recipient", op: "starts_with", value: "shop@" }, true],
      [{ field: "subject", op: "starts_with", value: "build failed" }, true],
      [{ field: "subject", op: "contains", value: "failed on" }, true],
      [{ field: "subject", op: "ends_with", value: "on main" }, true],
      [{ field: "subject", op: "equals", value: "build failed" }, false],
      [{ field: "header", name: "List-Id", op: "equals", value: "<repo.github.com>" }, true],
      [{ field: "header", name: "list-id", op: "contains", value: "REPO" }, true],
      [{ field: "header", name: "X-Missing", op: "contains", value: "x" }, false],
      [{ field: "header", name: "X-Missing", op: "not_contains", value: "x" }, true],
    ];
    for (const [c, expected] of cases) expect(hits(c, MAIL), JSON.stringify(c)).toBe(expected);
  });

  it("folds case and collapses white space on both sides", () => {
    const c: Condition = { field: "subject", op: "equals", value: "  BUILD failed ON\tMAIN " };
    expect(hits(c, MAIL)).toBe(true);
  });

  it("decodes encoded words in the subject and the display name", () => {
    const s = source({
      Subject: "=?UTF-8?B?5p6E5bu65aSx6LSl?= =?ISO-2022-JP?B?GyRCJUYlOSVIGyhC?=",
      From: "=?UTF-8?Q?J=C3=BCrgen?= <j@example.org>",
    });
    expect(hits({ field: "subject", op: "contains", value: "构建失败" }, s)).toBe(true);
    expect(hits({ field: "subject", op: "contains", value: "テスト" }, s)).toBe(true);
    expect(hits({ field: "from", op: "equals", value: "jürgen" }, s)).toBe(true);
  });

  it("unfolds a folded header and joins a repeated one", () => {
    const folded: MailSource = {
      ...source(),
      headers: { get: (n) => (n === "subject" ? "Weekly\r\n report" : null) },
    };
    expect(hits({ field: "subject", op: "equals", value: "weekly report" }, folded)).toBe(true);
    const repeated = source({ "X-Tag": ["alpha", "beta"] });
    const tag = (op: Condition["op"], value: string) =>
      hits({ field: "header", name: "X-Tag", op, value }, repeated);
    expect(tag("equals", "alpha, beta")).toBe(true);
    expect(tag("ends_with", "beta")).toBe(true);
  });

  it("uses the envelope sender without a From header", () => {
    expect(hits({ field: "from", op: "equals", value: "bounce@env.example" }, source())).toBe(true);
    expect(hits({ field: "from", op: "contains", value: "env" }, MAIL)).toBe(false);
  });

  it("matches the sub-address tag, and a message without one only by not_contains", () => {
    const tagged = source({}, { tag: "github" });
    expect(hits({ field: "tag", op: "equals", value: "GitHub" }, tagged)).toBe(true);
    expect(hits({ field: "tag", op: "contains", value: "git" }, source())).toBe(false);
    expect(hits({ field: "tag", op: "not_contains", value: "git" }, source())).toBe(true);
  });

  it("cuts a header value at 2,000 characters before comparing", () => {
    const s = source({ Subject: `${"x".repeat(VALUE_MAX - 3)}needle` });
    expect(hits({ field: "subject", op: "contains", value: "nee" }, s)).toBe(true);
    expect(hits({ field: "subject", op: "contains", value: "needle" }, s)).toBe(false);
  });

  it("needs every condition with match all and one with match any", () => {
    const conditions: Condition[] = [
      { field: "from", op: "contains", value: "github" },
      { field: "subject", op: "contains", value: "passed" },
    ];
    expect(evaluateRules([rule(conditions)], MAIL).read).toBe(false);
    expect(evaluateRules([rule(conditions, { match: "any" })], MAIL).read).toBe(true);
  });
});

describe("rule order and actions", () => {
  const github: Condition = { field: "from", op: "contains", value: "github" };
  const never: Condition = { field: "from", op: "contains", value: "nobody" };

  it("adds the actions of every matching rule, targets once each in rule order", () => {
    const d = evaluateRules(
      [
        rule([github], { ...NONE, star: true, targets: ["b@out.test", "a@out.test"] }),
        rule([never], { ...NONE, trash: true, targets: ["c@out.test"] }),
        rule([github], { ...NONE, archive: true, targets: ["a@out.test", "d@out.test"] }),
      ],
      MAIL,
    );
    expect(d).toEqual({
      targets: ["b@out.test", "a@out.test", "d@out.test"],
      read: false,
      starred: true,
      archived: true,
      trashed: false,
    });
  });

  it("stops after a matching rule with stop, not after one that does not match", () => {
    const later = rule([github], { ...NONE, trash: true });
    expect(evaluateRules([rule([github], { stop: true }), later], MAIL).trashed).toBe(false);
    expect(evaluateRules([rule([never], { stop: true }), later], MAIL).trashed).toBe(true);
  });

  it("lets Trash win over archive", () => {
    const d = evaluateRules(
      [rule([github], { ...NONE, archive: true }), rule([github], { ...NONE, trash: true })],
      MAIL,
    );
    expect([d.archived, d.trashed]).toEqual([false, true]);
  });
});
