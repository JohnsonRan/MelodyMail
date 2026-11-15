#!/usr/bin/env bun
/**
 * JS time of the bounded inbound parse over the first 256 KB of each fixture, a 20 MiB message
 * and six adversarial HTML bodies, all generated in memory except the fixtures. workerd does not
 * advance performance.now() during computation, so the budget is measured here with the same
 * code under Bun (docs/PLAN.md, section 2, "CPU budget"). Exits 1 when the p95 of any of those
 * reaches the 3 ms budget. A slice with no text part is the parse's known worst case (both
 * passes run); it is reported but not gated, see docs/STATE.md, M3 open questions.
 *
 * Usage: bun bench/parse.ts [iterations]
 */
import { parseSlice, SLICE_BYTES } from "../src/mail/parse";
import {
  adversarialHtml,
  attachmentFirst,
  FIXTURE_NAMES,
  largeMessage,
} from "../test/fixtures/generated";

const ITERATIONS = Number(process.argv[2] ?? 200);
const BUDGET_MS = 3;

const inputs: [string, Uint8Array, boolean][] = [];
for (const name of FIXTURE_NAMES) {
  const res = await fetch(new URL(`../test/fixtures/${name}.eml`, import.meta.url));
  inputs.push([name, new Uint8Array(await res.arrayBuffer()), true]);
}
inputs.push(
  ["20 MiB attachment (generated)", largeMessage().subarray(0, SLICE_BYTES), true],
  ["no text in slice (not gated)", attachmentFirst(4000).subarray(0, SLICE_BYTES), false],
);
for (const [name, message] of adversarialHtml()) inputs.push([`html: ${name}`, message, true]);

let over = false;
const all: number[] = [];
for (const [name, bytes, gated] of inputs) {
  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS + 20; i++) {
    const start = performance.now();
    await parseSlice(bytes);
    const elapsed = performance.now() - start;
    if (i >= 20) samples.push(elapsed);
  }
  samples.sort((a, b) => a - b);
  const at = (q: number) =>
    samples[Math.min(samples.length - 1, Math.floor(q * samples.length))] ?? 0;
  if (gated) all.push(...samples);
  if (gated && at(0.95) >= BUDGET_MS) over = true;
  console.log(
    `${name.padEnd(40)} median ${at(0.5).toFixed(3)} ms, p95 ${at(0.95).toFixed(3)} ms, max ${at(1).toFixed(3)} ms`,
  );
}
all.sort((a, b) => a - b);
const q = (p: number) => all[Math.min(all.length - 1, Math.floor(p * all.length))] ?? 0;
console.log(
  `gated (n=${all.length})${" ".repeat(19)} median ${q(0.5).toFixed(3)} ms, p95 ${q(0.95).toFixed(3)} ms, max ${q(1).toFixed(3)} ms`,
);
if (over) {
  console.error(`p95 at or over the ${BUDGET_MS} ms budget`);
  process.exit(1);
}
