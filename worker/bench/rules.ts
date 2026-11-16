#!/usr/bin/env bun
/**
 * JS time of rule evaluation per message (docs/M6-rules-api.md, "CPU budget"): loading 50 rule
 * rows (JSON.parse) and evaluating them against crafted headers. workerd does not advance
 * performance.now() during computation, so the budget is measured here with the same code under
 * Bun. Inputs: 50 enabled rules of 10 conditions that never match (every condition runs, no
 * stop), mixing every field and operator, against the worst headers below (From, To and Cc of 100
 * addresses each, or of 2,000 characters of short addresses or of groups, with an encoded
 * 2,000-character subject and a header repeated 50 times), against plain
 * headers, against 20 distinct header names (the HEADER_NAMES_MAX cap), each holding 2,000
 * characters dense with white space, and against the worst headers and the 20 names together;
 * and the same rules made to match. Each input has its own p95 budget: 2 ms for the adversarial
 * worst headers, alone or with the 20 names, and 1 ms for every other input (owner ruling
 * 2026-11-17). Exits 1 when the p95 of any input reaches its budget.
 *
 * Usage: bun bench/rules.ts [iterations]
 */
import {
  type Condition,
  evaluateRules,
  type MailSource,
  type RuleRow,
  toRule,
} from "../src/rules/evaluate";

const ITERATIONS = Number(process.argv[2] ?? 200);
/** p95 budgets (owner ruling 2026-11-17). */
const BUDGET_MS = 1;
const ADVERSARIAL_BUDGET_MS = 2;

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const qp = (bytes: Uint8Array) =>
  [...bytes].map((b) => `=${b.toString(16).toUpperCase().padStart(2, "0")}`).join("");

/** A subject of about 2,000 characters of B and Q encoded words in UTF-8, GBK and ISO-2022-JP. */
function encodedSubject(): string {
  const utf8 = new TextEncoder().encode("构建失败通知");
  // "测试" in GBK and "テスト" in ISO-2022-JP, as bytes.
  const gbk = new Uint8Array([0xb2, 0xe2, 0xca, 0xd4]);
  const jis = new Uint8Array([
    0x1b, 0x24, 0x42, 0x25, 0x46, 0x25, 0x39, 0x25, 0x48, 0x1b, 0x28, 0x42,
  ]);
  const words = [
    `=?UTF-8?B?${b64(utf8)}?=`,
    `=?UTF-8?Q?${qp(utf8)}?=`,
    `=?GBK?B?${b64(gbk)}?=`,
    `=?GBK?Q?${qp(gbk)}?=`,
    `=?ISO-2022-JP?B?${b64(jis)}?=`,
  ];
  let subject = "";
  for (let i = 0; subject.length < 2000; i++) subject += `${words[i % words.length]} `;
  return subject;
}

/** 100 addresses with display names: the 2,000-character cut keeps about 60, and the parser sees
 * only the first 50 (cutAddressList). */
const ADDRESS_LIST = Array.from(
  { length: 100 },
  (_, i) => `"Person ${i}" <person${i}@example${i}.org>`,
).join(", ");
/** About 300 short addresses in 2,000 characters: the most a parser would see without the cut. */
const SHORT_LIST = Array.from({ length: 600 }, (_, i) => `a${i}@b`)
  .join(",")
  .slice(0, 2000);
/** Groups of short addresses filling 2,000 characters. */
const GROUP_LIST = Array.from(
  { length: 100 },
  (_, g) => `g${g}: ${Array.from({ length: 5 }, (_, i) => `a${i}@b`).join(", ")};`,
)
  .join(" ")
  .slice(0, 2000);

/** Headers as Headers.get reads them: the worst case for every field, with `list` in From, To and Cc. */
function worstHeaders(list = ADDRESS_LIST): Headers {
  const h = new Headers();
  h.set("subject", encodedSubject());
  for (const name of ["from", "to", "cc"]) h.set(name, list);
  for (let i = 0; i < 50; i++) h.append("x-repeated", `value number ${i} of a repeated header`);
  return h;
}

function plainHeaders(): MailSource["headers"] {
  return new Headers({
    from: "GitHub <notifications@github.com>",
    to: "Shop <shop@example.com>",
    subject: "[repo] Build failed on main",
    "list-id": "<repo.github.com>",
  });
}

const FIELDS: [Condition["field"], string?][] = [
  ["from"],
  ["to"],
  ["recipient"],
  ["tag"],
  ["subject"],
  ["header", "x-repeated"],
  ["header", "list-id"],
];
const OPS: Condition["op"][] = ["contains", "equals", "starts_with", "ends_with"];

/** 50 rule rows of 10 conditions as D1 returns them; `hit` makes every condition match. */
function ruleRows(hit: boolean): RuleRow[] {
  return Array.from({ length: 50 }, (_, r) => {
    const conditions: Condition[] = Array.from({ length: 10 }, (_, i) => {
      const [field, name] = FIELDS[(r + i) % FIELDS.length] ?? ["from"];
      const op = OPS[(r * 3 + i) % OPS.length] ?? "contains";
      // A miss compares a value of 256 characters that no header holds; a hit uses not_contains.
      const value = `zz${"q".repeat(250)}${r}-${i}`;
      return {
        field,
        op: hit ? "not_contains" : op,
        value,
        ...(name ? { name } : {}),
      };
    });
    return {
      // "any" over misses and "all" over hits: neither stops early, so every condition runs.
      match: hit ? "all" : "any",
      conditions: JSON.stringify(conditions),
      mark_read: 1,
      star: 0,
      archive: r % 2,
      trash: 0,
      stop: 0,
      targets: JSON.stringify(r % 10 === 0 ? [`t${r}@out.example`] : []),
    };
  });
}

/** The header-name cap (HEADER_NAMES_MAX, 20): each name present with 2,000 characters of words
 * and white space, so each value costs its full normalization once. */
const CAP_NAMES = Array.from({ length: 20 }, (_, i) => `x-cap-${i}`);

function cappedHeaders(): Headers {
  const h = new Headers();
  const value = "ab 	 ".repeat(400).slice(0, 2000);
  for (const name of CAP_NAMES) h.set(name, value);
  return h;
}

/** 50 rules of 10 header conditions spread over the 20 capped names. */
function cappedRows(hit: boolean): RuleRow[] {
  return ruleRows(hit).map((row, r) => ({
    ...row,
    conditions: JSON.stringify(
      (JSON.parse(row.conditions) as Condition[]).map((c, i) => ({
        ...c,
        field: "header",
        name: CAP_NAMES[(r * 10 + i) % CAP_NAMES.length],
      })),
    ),
  }));
}

/** The worst headers and the 20 capped header names together. */
function combinedHeaders(): Headers {
  const h = worstHeaders();
  for (const [name, value] of cappedHeaders()) h.set(name, value);
  return h;
}

/** The mixed rules with every header condition on one of the 20 capped names. */
function combinedRows(hit: boolean): RuleRow[] {
  let n = 0;
  return ruleRows(hit).map((row) => ({
    ...row,
    conditions: JSON.stringify(
      (JSON.parse(row.conditions) as Condition[]).map((c) =>
        c.field === "header" ? { ...c, name: CAP_NAMES[n++ % CAP_NAMES.length] } : c,
      ),
    ),
  }));
}

const source = (headers: MailSource["headers"]): MailSource => ({
  envelopeFrom: "bounce+123@mailer.example.org",
  headers,
  recipient: "shop@example.com",
  tag: "github",
});

const inputs: [string, MailSource, RuleRow[], number][] = [
  [
    "50 x 10 conditions, worst headers, no match",
    source(worstHeaders()),
    ruleRows(false),
    ADVERSARIAL_BUDGET_MS,
  ],
  [
    "50 x 10 conditions, plain headers, no match",
    source(plainHeaders()),
    ruleRows(false),
    BUDGET_MS,
  ],
  [
    "50 x 10 conditions, worst headers, all match",
    source(worstHeaders()),
    ruleRows(true),
    ADVERSARIAL_BUDGET_MS,
  ],
  [
    "50 x 10 conditions, plain headers, all match",
    source(plainHeaders()),
    ruleRows(true),
    BUDGET_MS,
  ],
  [
    "50 x 10 conditions, 20 header names, no match",
    source(cappedHeaders()),
    cappedRows(false),
    BUDGET_MS,
  ],
  [
    "50 x 10 conditions, 20 header names, all match",
    source(cappedHeaders()),
    cappedRows(true),
    BUDGET_MS,
  ],
  [
    "50 x 10 conditions, worst + 20 names, no match",
    source(combinedHeaders()),
    combinedRows(false),
    ADVERSARIAL_BUDGET_MS,
  ],
  [
    "50 x 10 conditions, worst + 20 names, all match",
    source(combinedHeaders()),
    combinedRows(true),
    ADVERSARIAL_BUDGET_MS,
  ],
  [
    "50 x 10 conditions, short addresses, no match",
    source(worstHeaders(SHORT_LIST)),
    ruleRows(false),
    ADVERSARIAL_BUDGET_MS,
  ],
  [
    "50 x 10 conditions, short addresses, all match",
    source(worstHeaders(SHORT_LIST)),
    ruleRows(true),
    ADVERSARIAL_BUDGET_MS,
  ],
  [
    "50 x 10 conditions, address groups, no match",
    source(worstHeaders(GROUP_LIST)),
    ruleRows(false),
    ADVERSARIAL_BUDGET_MS,
  ],
  [
    "50 x 10 conditions, address groups, all match",
    source(worstHeaders(GROUP_LIST)),
    ruleRows(true),
    ADVERSARIAL_BUDGET_MS,
  ],
];

let over = false;
for (const [name, src, rows, budget] of inputs) {
  const samples: number[] = [];
  let matched = false;
  for (let i = 0; i < ITERATIONS + 20; i++) {
    const start = performance.now();
    const decision = evaluateRules(rows.map(toRule), src);
    const elapsed = performance.now() - start;
    matched = decision.read;
    if (i >= 20) samples.push(elapsed);
  }
  samples.sort((a, b) => a - b);
  const at = (q: number) =>
    samples[Math.min(samples.length - 1, Math.floor(q * samples.length))] ?? 0;
  if (at(0.95) >= budget) over = true;
  console.log(
    `${name.padEnd(48)} median ${at(0.5).toFixed(3)} ms, p95 ${at(0.95).toFixed(3)} ms, max ${at(1).toFixed(3)} ms, ${matched ? "matched" : "no match"}, budget ${budget} ms`,
  );
}
if (over) {
  console.error("p95 at or over an input's budget");
  process.exit(1);
}
