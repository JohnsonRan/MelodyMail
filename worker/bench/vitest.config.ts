import { defineConfig, mergeConfig } from "vitest/config";
import base from "../vitest.config";

// The D1 benchmarks run in workerd against a local D1, like the worker suite, but apart from the
// merge gate: seeding 5,000 messages with search text takes seconds. `bun run bench:folders`.
export default mergeConfig(
  base,
  defineConfig({ test: { include: ["bench/*.d1.ts"], testTimeout: 300_000, silent: false } }),
);
