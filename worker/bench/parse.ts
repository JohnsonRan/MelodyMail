#!/usr/bin/env bun
/**
 * JS time of the bounded inbound parse over the first 64 KB of each fixture, a 20 MiB message,
 * thirteen crafted MIME shapes and six adversarial HTML bodies, all generated in memory except
 * the fixtures. workerd does not advance performance.now() during computation, so the budget is
 * measured here with the same code under Bun (docs/PLAN.md, section 2, "CPU budget"). An input
 * the parser refuses is timed until it throws (the message then becomes parse_failed). Exits 1
 * when the p95 of any input reaches the 3 ms budget.
 *
 * Usage: bun bench/parse.ts [iterations]
 */
import { parseSlice } from "../src/mail/parse";
import {
  adversarialHtml,
  attachmentFirst,
  craftedMessages,
  FIXTURE_NAMES,
  largeMessage,
} from "../test/fixtures/generated";

const ITERATIONS = Number(process.argv[2] ?? 200);
const BUDGET_MS = 3;

const inputs: [string, Uint8Array][] = [];
for (const name of FIXTURE_NAMES) {
  const res = await fetch(new URL(`../test/fixtures/${name}.eml`, import.meta.url));
  inputs.push([name, new Uint8Array(await res.arrayBuffer())]);
}
inputs.push(
  ["20 MiB attachment", largeMessage()],
  ["text after the first 64 KB", attachmentFirst()],
  ...craftedMessages(),
  ...adversarialHtml().map(([name, message]): [string, Uint8Array] => [`html: ${name}`, message]),
);

let over = false;
const all: number[] = [];
for (const [name, bytes] of inputs) {
  const samples: number[] = [];
  let outcome = "parsed";
  for (let i = 0; i < ITERATIONS + 20; i++) {
    const start = performance.now();
    try {
      await parseSlice(bytes);
    } catch {
      outcome = "refused";
    }
    const elapsed = performance.now() - start;
    if (i >= 20) samples.push(elapsed);
  }
  samples.sort((a, b) => a - b);
  const at = (q: number) =>
    samples[Math.min(samples.length - 1, Math.floor(q * samples.length))] ?? 0;
  all.push(...samples);
  if (at(0.95) >= BUDGET_MS) over = true;
  console.log(
    `${name.padEnd(46)} median ${at(0.5).toFixed(3)} ms, p95 ${at(0.95).toFixed(3)} ms, max ${at(1).toFixed(3)} ms, ${outcome}`,
  );
}
all.sort((a, b) => a - b);
const q = (p: number) => all[Math.min(all.length - 1, Math.floor(p * all.length))] ?? 0;
console.log(
  `${`all (n=${all.length})`.padEnd(46)} median ${q(0.5).toFixed(3)} ms, p95 ${q(0.95).toFixed(3)} ms, max ${q(1).toFixed(3)} ms`,
);
if (over) {
  console.error(`p95 at or over the ${BUDGET_MS} ms budget`);
  process.exit(1);
}
