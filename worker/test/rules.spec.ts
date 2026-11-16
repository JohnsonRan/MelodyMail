import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleEmail } from "../src/mail/inbound";
import {
  type Condition,
  evaluateRules,
  type MailSource,
  type Rule,
  VALUE_MAX,
} from "../src/rules/evaluate";
import { headersFromRaw } from "../src/rules/routes";
import { type Client, setupOwner } from "./helpers";
import { addAddress, addRule, asMessage, inbound, messageRows } from "./mail-helpers";
import { seedMessage } from "./mailbox-helpers";

// Rules (docs/M6-rules-api.md, "Rules"): evaluation units, then the session routes against real
// D1 and R2. The email() and consumer paths are in inbound.spec.ts and consumer.spec.ts.

type Json = Record<string, unknown>;

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

const BODY = {
  name: "GitHub",
  match: "all",
  conditions: [{ field: "from", op: "ends_with", value: "@github.com" }],
  archive: true,
};

async function owner(): Promise<Client> {
  return (await setupOwner()).client;
}

async function addTarget(client: Client, email: string): Promise<number> {
  const res = await client.json("POST", "/api/forward-targets", { email }, 201);
  return (res.target as { id: number }).id;
}

async function auditRows(prefix: string) {
  const { results } = await env.DB.prepare(
    "SELECT event, detail FROM audit_log WHERE event LIKE ? ORDER BY id",
  )
    .bind(`${prefix}%`)
    .all();
  return results;
}

describe("rule routes", () => {
  it("creates, lists in order, replaces and deletes rules, auditing ids only", async () => {
    const client = await owner();
    const t1 = await addTarget(client, "a@out.test");
    const t2 = await addTarget(client, "b@out.test");
    const first = (await client.json("POST", "/api/rules", { ...BODY, targetIds: [t2, t1] }, 201))
      .rule as Json;
    expect(first).toMatchObject({
      name: "GitHub",
      enabled: true,
      position: 1,
      match: "all",
      conditions: BODY.conditions,
      markRead: false,
      archive: true,
      stop: false,
      targetIds: [t1, t2],
    });
    const second = (
      await client.json("POST", "/api/rules", { ...BODY, name: "Two", trash: true }, 201)
    ).rule as Json;
    expect(second.position).toBe(2);

    await client.json("PUT", `/api/rules/${first.id}`, {
      ...BODY,
      name: "Renamed",
      enabled: false,
      match: "any",
      targetIds: [t2],
    });
    const list = (await client.json("GET", "/api/rules")).rules as Json[];
    expect(list.map((r) => [r.name, r.enabled, r.match, r.targetIds])).toEqual([
      ["Renamed", false, "any", [t2]],
      ["Two", true, "all", []],
    ]);

    await client.json("DELETE", `/api/rules/${first.id}`);
    expect(await client.json("DELETE", `/api/rules/${first.id}`, undefined, 404)).toEqual({
      error: "not_found",
    });
    expect(await client.json("PUT", `/api/rules/${first.id}`, BODY, 404)).toEqual({
      error: "not_found",
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM rule_forwards").first("n")).toBe(0);
    expect(await auditRows("rule")).toEqual([
      { event: "rule_created", detail: `rule ${first.id}` },
      { event: "rule_created", detail: `rule ${second.id}` },
      { event: "rule_updated", detail: `rule ${first.id}` },
      { event: "rule_deleted", detail: `rule ${first.id}` },
    ]);
  });

  it("refuses invalid bodies, unknown targets and a 51st rule", async () => {
    const client = await owner();
    const header = { field: "header", op: "contains", value: "x" };
    const cases: [Json, string][] = [
      [{ ...BODY, name: " " }, "invalid_rule_name"],
      [{ ...BODY, name: "n".repeat(101) }, "invalid_rule_name"],
      [{ ...BODY, match: "most" }, "bad_request"],
      [{ ...BODY, conditions: [] }, "invalid_condition"],
      [{ ...BODY, conditions: Array(11).fill(BODY.conditions[0]) }, "invalid_condition"],
      [
        { ...BODY, conditions: [{ field: "body", op: "contains", value: "x" }] },
        "invalid_condition",
      ],
      [
        { ...BODY, conditions: [{ field: "from", op: "matches", value: "x" }] },
        "invalid_condition",
      ],
      [
        { ...BODY, conditions: [{ field: "from", op: "contains", value: "" }] },
        "invalid_condition",
      ],
      [
        { ...BODY, conditions: [{ field: "from", op: "contains", value: "x".repeat(257) }] },
        "invalid_condition",
      ],
      [{ ...BODY, conditions: [{ ...header, name: "X-A" }, header] }, "invalid_condition"],
      [{ ...BODY, conditions: [{ ...header, name: "Bad:Name" }] }, "invalid_condition"],
      [{ ...BODY, conditions: [{ ...header, name: "h".repeat(65) }] }, "invalid_condition"],
      [{ ...BODY, conditions: [{ ...BODY.conditions[0], name: "X-A" }] }, "invalid_condition"],
      [{ ...BODY, archive: false }, "no_rule_action"],
      [{ ...BODY, archive: "yes" }, "bad_request"],
      [{ ...BODY, targetIds: [1, 2, 3, 4, 5, 6] }, "too_many_rule_targets"],
      [{ ...BODY, targetIds: [999] }, "unknown_target"],
    ];
    for (const [body, error] of cases) {
      expect(await client.json("POST", "/api/rules", body, 400), JSON.stringify(body)).toEqual({
        error,
      });
    }
    // "Stop processing more rules" alone is an action; a header name may be 64 characters.
    const stopOnly = { ...BODY, archive: false, stop: true };
    await client.json("POST", "/api/rules", stopOnly, 201);
    await client.json(
      "POST",
      "/api/rules",
      { ...BODY, conditions: [{ ...header, name: "h".repeat(64) }] },
      201,
    );
    await env.DB.prepare(
      `INSERT INTO rules (name, position, match, conditions, archive, created_at, updated_at)
       SELECT 'r', value + 10, 'all', '[]', 1, 0, 0 FROM json_each(?)`,
    )
      .bind(JSON.stringify(Array.from({ length: 48 }, (_, i) => i)))
      .run();
    expect(await client.json("POST", "/api/rules", BODY, 409)).toEqual({ error: "too_many_rules" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM rules").first("n")).toBe(50);
  });

  it("reorders only with every rule id exactly once", async () => {
    const client = await owner();
    const ids: number[] = [];
    for (const name of ["a", "b", "c"]) {
      ids.push(
        ((await client.json("POST", "/api/rules", { ...BODY, name }, 201)).rule as Json)
          .id as number,
      );
    }
    const [a, b, c] = ids as [number, number, number];
    for (const order of [
      [c, a],
      [c, a, b, 999],
      [c, a, a],
      [c, a, 999],
    ]) {
      expect(
        await client.json("PUT", "/api/rules/order", { ids: order }, 409),
        String(order),
      ).toEqual({
        error: "order_mismatch",
      });
    }
    await client.json("PUT", "/api/rules/order", { ids: [c, a, b] });
    const list = (await client.json("GET", "/api/rules")).rules as Json[];
    expect(list.map((r) => r.name)).toEqual(["c", "a", "b"]);
    expect((await auditRows("rules_reordered"))[0]?.detail).toBe(`${c},${a},${b}`);
  });

  it("changes no stored message when a rule is created, edited or deleted", async () => {
    const client = await owner();
    await seedMessage({ id: "m1", from: "x@github.com" });
    const before = await messageRows();
    const id = (
      (await client.json("POST", "/api/rules", { ...BODY, trash: true }, 201)).rule as Json
    ).id;
    await client.json("PUT", `/api/rules/${id}`, { ...BODY, markRead: true });
    await client.json("DELETE", `/api/rules/${id}`);
    expect(await messageRows()).toEqual(before);
  });
});

describe("forward targets used by rules", () => {
  it("refuses to remove a target a rule uses, and with detach disables a rule left without action", async () => {
    const client = await owner();
    const target = await addTarget(client, "a@out.test");
    const other = await addTarget(client, "b@out.test");
    const forwardOnly = await addRule({ conditions: BODY.conditions, targets: ["a@out.test"] });
    const both = await addRule({
      conditions: BODY.conditions,
      targets: ["a@out.test", "b@out.test"],
    });
    const archives = await addRule({
      conditions: BODY.conditions,
      archive: true,
      targets: ["a@out.test"],
    });
    const list = (await client.json("GET", "/api/forward-targets")).targets as Json[];
    expect(list.map((t) => [t.id, t.ruleCount])).toEqual([
      [target, 3],
      [other, 1],
    ]);

    expect(await client.json("DELETE", `/api/forward-targets/${target}`, undefined, 409)).toEqual({
      error: "target_in_use",
    });
    await client.json("DELETE", `/api/forward-targets/${target}?detach=1`);
    const rules = (await client.json("GET", "/api/rules")).rules as Json[];
    expect(rules.map((r) => [r.id, r.enabled, r.targetIds])).toEqual([
      [forwardOnly, false, []],
      [both, true, [other]],
      [archives, true, []],
    ]);
  });
});

describe("POST /api/rules/test", () => {
  const RAW = [
    "From: GitHub <noreply@github.com>",
    "To: shop+ci@example.com",
    "Subject: =?UTF-8?B?5p6E5bu6?= failed",
    "X-GitHub-Reason: ci",
    " activity",
    "",
    "Body with Subject: never read",
    "",
  ].join("\r\n");

  it("reads only the header block, unfolded", () => {
    const h = headersFromRaw(new TextEncoder().encode(`${RAW}X-Late: 1\r\n`));
    expect(h.get("X-GitHub-Reason")).toBe("ci activity");
    expect(h.get("x-late")).toBeNull();
  });

  it("answers what email() decides for the same message, and changes nothing", async () => {
    const client = await owner();
    await addAddress("shop");
    const target = await addTarget(client, "a@out.test");
    const draft = {
      // The editor tests a rule before it has a name.
      name: "",
      match: "any" as const,
      conditions: [
        { field: "subject", op: "contains", value: "构建" },
        { field: "header", name: "X-GitHub-Reason", op: "equals", value: "CI   activity" },
        { field: "tag", op: "equals", value: "ci" },
        { field: "from", op: "contains", value: "gitlab" },
      ],
      star: true,
      trash: true,
      stop: true,
      targetIds: [target],
    };
    // email() with the same rule saved: the stored flags and the forward are its decision.
    await addRule({ ...draft, targets: ["a@out.test"] });
    const message = inbound("shop+ci@example.com", RAW, {
      From: "GitHub <noreply@github.com>",
      Subject: "=?UTF-8?B?5p6E5bu6?= failed",
      "X-GitHub-Reason": "ci activity",
    });
    await handleEmail(asMessage(message), env);
    expect(message.forward.mock.calls.map((c) => c[0])).toEqual(["a@out.test"]);
    const [stored] = await messageRows();
    expect(stored).toMatchObject({ starred: 1, trashed: 1, archived: 0, read: 0 });

    const auditBefore = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log").first("n");
    const ask = (rule: Json) =>
      client.json("POST", "/api/rules/test", { messageId: stored?.id, rule });
    expect(await ask({ ...draft, match: "all" })).toEqual({
      matched: false,
      conditions: [{ matched: true }, { matched: true }, { matched: true }, { matched: false }],
      markRead: false,
      star: false,
      archive: false,
      trash: false,
      stop: false,
      targets: [],
    });
    expect(await ask(draft)).toEqual({
      matched: true,
      conditions: [{ matched: true }, { matched: true }, { matched: true }, { matched: false }],
      markRead: false,
      star: true,
      archive: false,
      trash: true,
      stop: true,
      targets: ["a@out.test"],
    });
    expect(await messageRows()).toEqual([stored]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log").first("n")).toBe(
      auditBefore,
    );
  });

  it("answers no_raw for a message without its raw object or an outbound one, 404 for none", async () => {
    const client = await owner();
    await seedMessage({ id: "gone", raw: null });
    await seedMessage({ id: "out" });
    await env.DB.prepare("UPDATE messages SET direction = 'out' WHERE id = 'out'").run();
    const rule = { match: "all", conditions: BODY.conditions };
    for (const id of ["gone", "out"]) {
      expect(
        await client.json("POST", "/api/rules/test", { messageId: id, rule }, 409),
        id,
      ).toEqual({
        error: "no_raw",
      });
    }
    expect(await client.json("POST", "/api/rules/test", { messageId: "none", rule }, 404)).toEqual({
      error: "not_found",
    });
    expect(
      await client.json(
        "POST",
        "/api/rules/test",
        { messageId: "out", rule: { ...rule, targetIds: [9] } },
        400,
      ),
    ).toEqual({ error: "unknown_target" });
  });
});
