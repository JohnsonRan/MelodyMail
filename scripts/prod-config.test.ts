import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mergeConfig, parseJsonc, refusal } from "../worker/scripts/prod-config";

// The production config generator (worker/scripts/prod-config.ts) with a stand-in for git and
// the example file; nothing is written and no account is contacted.

const worker = join(import.meta.dir, "..", "worker");
const base = parseJsonc(readFileSync(join(worker, "wrangler.jsonc"), "utf8")) as Record<
  string,
  unknown
>;
const example = parseJsonc(readFileSync(join(worker, "deploy.example.jsonc"), "utf8")) as Record<
  string,
  unknown
>;

const SHA = "a".repeat(40);
const gitWith =
  (answers: Record<string, string | null>) =>
  (args: string[]): string | null =>
    answers[args.join(" ")] ?? null;
const merged = {
  "rev-parse --abbrev-ref HEAD": "main",
  "status --porcelain": "",
  "rev-parse HEAD": SHA,
  "rev-parse origin/main": SHA,
};

describe("refusal", () => {
  test("allows a clean main at origin/main", () => {
    expect(refusal(gitWith(merged))).toBeNull();
  });

  test("refuses another branch, a dirty tree, an unpushed or unpulled main, and no git", () => {
    expect(refusal(gitWith({ ...merged, "rev-parse --abbrev-ref HEAD": "m7-ops" }))).toContain(
      "not main",
    );
    expect(
      refusal(gitWith({ ...merged, "status --porcelain": " M worker/src/index.ts" })),
    ).toContain("not clean");
    expect(refusal(gitWith({ ...merged, "rev-parse origin/main": "b".repeat(40) }))).toContain(
      "not origin/main",
    );
    expect(refusal(gitWith({ ...merged, "rev-parse origin/main": null }))).toContain("unknown");
    expect(refusal(() => null)).toContain("could not be run");
  });
});

describe("mergeConfig", () => {
  test("puts the database id on the DB binding and the routes beside the tracked config", () => {
    const local = { ...example, database_id: "0b0c2c1e-6a4b-4f4e-9d1a-1d2e3f405060" };
    const config = mergeConfig(base, local);
    expect(config.d1_databases).toEqual([
      {
        binding: "DB",
        database_name: "melodymail",
        migrations_dir: "migrations",
        database_id: "0b0c2c1e-6a4b-4f4e-9d1a-1d2e3f405060",
      },
    ]);
    expect(config.routes).toEqual([{ pattern: "mail.example.com", custom_domain: true }]);
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    // Everything else is the tracked file's.
    expect(config.main).toBe(base.main);
    expect(config.triggers).toEqual(base.triggers);
    // The tracked config itself stays account-free.
    expect(JSON.stringify(base)).not.toContain("database_id");
  });

  test("refuses an unknown key, a missing or malformed id, no route, and workers_dev left on", () => {
    const id = { database_id: "0b0c2c1e-6a4b-4f4e-9d1a-1d2e3f405060" };
    const good = { ...example, ...id };
    expect(() => mergeConfig(base, { ...good, main: "other.ts" })).toThrow("unknown keys main");
    expect(() => mergeConfig(base, { ...good, database_id: "abc" })).toThrow("database_id");
    expect(() => mergeConfig(base, { ...good, routes: [] })).toThrow("routes");
    expect(() => mergeConfig(base, { ...good, workers_dev: true })).toThrow("workers_dev");
    expect(() => mergeConfig({ ...base, d1_databases: [] }, good)).toThrow("no D1 binding");
  });
});

test("parseJsonc keeps // inside strings and drops comments and trailing commas", () => {
  expect(parseJsonc('{ "a": "https://x", // c\n /* d */ "b": [1, 2,], }')).toEqual({
    a: "https://x",
    b: [1, 2],
  });
});
