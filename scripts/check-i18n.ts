#!/usr/bin/env bun
/**
 * Fail when the locale catalogs under web/src/locales disagree: every locale must have the same
 * namespaces and the same keys as the reference locale (en), and no value may be empty.
 *
 * Exit codes: 0 clean, 1 violations found, 2 could not run (fewer than two locales, or no keys).
 * Usage: bun scripts/check-i18n.ts [locales-dir]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REFERENCE = "en";

type Catalog = Map<string, string>;

function flatten(value: unknown, prefix: string, out: Catalog): void {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
  } else {
    out.set(prefix, typeof value === "string" ? value : "");
  }
}

export function load(dir: string): Map<string, Catalog> {
  const locales = new Map<string, Catalog>();
  for (const locale of readdirSync(dir, { withFileTypes: true })) {
    if (!locale.isDirectory()) continue;
    const catalog: Catalog = new Map();
    for (const file of readdirSync(join(dir, locale.name))) {
      if (!file.endsWith(".json")) continue;
      const ns = file.slice(0, -".json".length);
      flatten(JSON.parse(readFileSync(join(dir, locale.name, file), "utf8")), ns, catalog);
    }
    locales.set(locale.name, catalog);
  }
  return locales;
}

export class CannotRun extends Error {}

export function check(locales: Map<string, Catalog>): string[] {
  const reference = locales.get(REFERENCE);
  if (locales.size < 2 || !reference) {
    throw new CannotRun(`need "${REFERENCE}" and at least one other locale`);
  }
  if (reference.size === 0) throw new CannotRun(`"${REFERENCE}" has no keys`);
  const problems: string[] = [];
  for (const [name, catalog] of locales) {
    for (const key of reference.keys()) {
      if (!catalog.has(key)) problems.push(`${name}: missing ${key}`);
    }
    for (const [key, value] of catalog) {
      if (!reference.has(key)) problems.push(`${name}: ${key} is not in ${REFERENCE}`);
      else if (value.trim() === "") problems.push(`${name}: ${key} is empty`);
    }
  }
  return problems;
}

if (import.meta.main) {
  const dir = process.argv[2] ?? join(import.meta.dir, "..", "web", "src", "locales");
  try {
    const problems = check(load(dir));
    for (const p of problems) console.log(p);
    process.exit(problems.length ? 1 : 0);
  } catch (err) {
    console.error(`check-i18n: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
