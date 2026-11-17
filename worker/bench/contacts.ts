#!/usr/bin/env bun
/**
 * JS time of GET /api/contacts per request: parsing and ranking the matching rows D1 returns
 * (rankContacts). workerd does not advance performance.now() during computation, so the budget
 * is measured here with the same code under Bun. The route parses at most MATCH_ROWS messages
 * per direction. Inputs, each MATCH_ROWS received and MATCH_ROWS sent messages: plain headers;
 * received From headers of 998 characters (the stored cut) dense with short addresses, which a
 * sender controls; sent To, Cc and Bcc holding 50 addresses (RECIPIENTS_MAX) of 252 characters each
 * (near the 254-character limit); one contact repeated in every row; and received From headers
 * that hold a long run without "@": a quoted 990-character name, or a 980-character name, before
 * the address.
 * Exits 1 when the p95 of any input reaches the budget.
 *
 * Usage: bun bench/contacts.ts [iterations]
 */
import { type ContactRow, MATCH_ROWS, rankContacts } from "../src/send/contacts";

const ITERATIONS = Number(process.argv[2] ?? 200);
/** p95 budget, the per-request JS budget of the parse, Telegram and passkey benches. */
const BUDGET_MS = 3;

const rows = (inbound: (i: number) => string, outbound: (i: number) => (string | null)[]) => [
  ...Array.from(
    { length: MATCH_ROWS },
    (_, i): ContactRow => ({ at: i * 2, headers: [inbound(i)] }),
  ),
  ...Array.from(
    { length: MATCH_ROWS },
    (_, i): ContactRow => ({ at: i * 2 + 1, headers: outbound(i) }),
  ),
];

let dense = "";
for (let i = 0; dense.length < 998; i++) dense += `a${i}@q.io, `;
dense = dense.slice(0, 998);
const long = (i: number, j: number) => `${`r${i}x${j}`.padEnd(240, "x")}@example.org`;
const list = (i: number, from: number, n: number) =>
  Array.from({ length: n }, (_, j) => long(i, from + j)).join(", ");

const INPUTS: Record<string, ContactRow[]> = {
  plain: rows(
    (i) => `Person ${i} <person${i}@example.org>`,
    (i) => [`friend${i}@example.org`, `cc${i}@example.org`, null],
  ),
  "dense From, 50 long recipients": rows(
    () => dense,
    (i) => [list(i, 0, 20), list(i, 20, 20), list(i, 40, 10)],
  ),
  "quoted 990-character name": rows(
    () => `"${"a".repeat(990)}" <x@y.io>`,
    () => [null, null, null],
  ),
  "980-character name": rows(
    () => `${"n".repeat(980)} <x@y.io>`,
    () => [null, null, null],
  ),
  "one contact in every row": rows(
    () => "Same Person <same@example.org>",
    () => ["same@example.org", null, null],
  ),
};

const own = new Set(["me@example.com"]);
let failed = false;
for (const [name, input] of Object.entries(INPUTS)) {
  for (const query of ["example", "q.io", "zzz"]) rankContacts(input, own, query, 8);
  const times: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    rankContacts(input, own, i % 2 ? "example" : "q.io", 8);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)] ?? 0;
  const median = times[Math.floor(times.length / 2)] ?? 0;
  const over = p95 >= BUDGET_MS;
  failed ||= over;
  console.log(
    `${name}: median ${median.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms${over ? " (over budget)" : ""}`,
  );
}
process.exit(failed ? 1 : 0);
