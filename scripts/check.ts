#!/usr/bin/env bun
/**
 * The merge gate (`bun run check`). The steps do not depend on each other, so they run at the
 * same time; each step's output is printed in one block when it ends, with its exit code. Exits 1
 * when any step fails, 0 when all pass.
 */

const STEPS = [
  "lint",
  "typecheck",
  "test",
  "test:scripts",
  "check:i18n",
  "build",
  "check:requirements",
];

const started = performance.now();

async function run(step: string): Promise<number> {
  const start = performance.now();
  const child = Bun.spawn([process.execPath, "run", step], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? "1" },
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const seconds = ((performance.now() - start) / 1000).toFixed(1);
  const output = `${out}${err}`.trimEnd();
  console.log(`\n=== ${step}: exit ${code} (${seconds} s)\n${output}`);
  return code;
}

const codes = await Promise.all(STEPS.map(run));
const failed = STEPS.filter((_, i) => codes[i] !== 0);
const total = ((performance.now() - started) / 1000).toFixed(1);
if (failed.length > 0) {
  console.error(`\ncheck failed in ${total} s: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`\ncheck passed in ${total} s: ${STEPS.join(", ")}`);
