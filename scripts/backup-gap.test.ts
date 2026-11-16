import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gapConfig, parseSince } from "../worker/scripts/backup-gap";
import { parseJsonc } from "../worker/scripts/prod-config";

// The gap tool's argument handling (worker/scripts/backup-gap.ts); nothing is started.

describe("parseSince", () => {
  test("reads an export id, a zoned ISO time and milliseconds as UTC", () => {
    expect(parseSince("2026-11-18T0300Z")).toBe(Date.UTC(2026, 10, 18, 3));
    expect(parseSince("2026-11-18T03:00:00Z")).toBe(Date.UTC(2026, 10, 18, 3));
    expect(parseSince("2026-11-18T11:00:00+08:00")).toBe(Date.UTC(2026, 10, 18, 3));
    expect(parseSince("1794800000000")).toBe(1794800000000);
  });

  test("refuses a time without a zone and anything else", () => {
    expect(parseSince("2026-11-18T03:00:00")).toBeNull();
    expect(parseSince("2026-11-18")).toBeNull();
    expect(parseSince("yesterday")).toBeNull();
    expect(parseSince("2026-13-40T0300Z")).toBeNull();
  });
});

describe("gapConfig", () => {
  const base = parseJsonc(
    readFileSync(join(import.meta.dir, "..", "worker", "wrangler.jsonc"), "utf8"),
  ) as Record<string, unknown>;

  test("keeps only the DB and MAIL bindings, remote only when asked", () => {
    const local = gapConfig(base, false);
    expect(Object.keys(local).sort()).toEqual(
      [
        "compatibility_date",
        "compatibility_flags",
        "d1_databases",
        "main",
        "name",
        "r2_buckets",
      ].sort(),
    );
    expect(local.main).toEndWith(join("scripts", "gap-worker.ts"));
    expect(local.d1_databases).toEqual([
      { binding: "DB", database_name: "melodymail", migrations_dir: "migrations" },
    ]);
    expect(local.r2_buckets).toEqual([{ binding: "MAIL", bucket_name: "melodymail-mail" }]);
    const remote = gapConfig(base, true);
    expect(remote.d1_databases).toEqual([expect.objectContaining({ remote: true })]);
    expect(remote.r2_buckets).toEqual([expect.objectContaining({ remote: true })]);
  });

  test("refuses a config without the bindings", () => {
    expect(() => gapConfig({ ...base, r2_buckets: [] }, false)).toThrow("no MAIL binding");
  });
});
