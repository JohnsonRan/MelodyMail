import { expect } from "vitest";
import doc from "../src/api/openapi.json";

// A JSON Schema subset checker written for the tests (owner ruling 2, docs/M6-rules-api.md):
// type (a type list with "null" is OpenAPI 3.1's nullable), required, properties,
// additionalProperties: false, items, enum, allOf and local $ref. Every /api/v1/ response the
// tests receive goes through `expectDocumented`, so a response shape that drifts from
// worker/src/api/openapi.json turns the suite red.

type Schema = {
  $ref?: string;
  type?: string | string[];
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean;
  items?: Schema;
  enum?: unknown[];
  allOf?: Schema[];
};

type Operation = {
  security?: Record<string, string[]>[];
  responses: Record<string, { $ref?: string; content?: Record<string, { schema?: Schema }> }>;
};

const PREFIX = "/api/v1";

function resolve<T>(node: T & { $ref?: string }): T {
  if (!node.$ref) return node;
  let target: unknown = doc;
  for (const part of node.$ref.replace(/^#\//, "").split("/")) {
    target = (target as Record<string, unknown>)[part];
  }
  if (target === undefined) throw new Error(`unresolved ${node.$ref}`);
  return resolve(target as T & { $ref?: string });
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

/** The problems of `value` against `schema`; empty when it conforms. */
export function check(schema: Schema, value: unknown, at = "$"): string[] {
  const s = resolve(schema);
  const errors: string[] = [];
  for (const part of s.allOf ?? []) errors.push(...check(part, value, at));
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const actual = typeOf(value);
    const ok = types.includes(actual) || (actual === "integer" && types.includes("number"));
    if (!ok) return [...errors, `${at}: ${actual} is not ${types.join(" or ")}`];
  }
  if (s.enum && !s.enum.includes(value)) errors.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if (typeOf(value) === "object") {
    const record = value as Record<string, unknown>;
    for (const name of s.required ?? []) {
      if (!Object.hasOwn(record, name)) errors.push(`${at}.${name}: required`);
    }
    for (const [name, field] of Object.entries(record)) {
      const sub = s.properties?.[name];
      if (sub) errors.push(...check(sub, field, `${at}.${name}`));
      else if (s.additionalProperties === false) errors.push(`${at}.${name}: not documented`);
    }
  }
  if (Array.isArray(value) && s.items) {
    value.forEach((item, i) => {
      errors.push(...check(s.items as Schema, item, `${at}[${i}]`));
    });
  }
  return errors;
}

const paths = doc.paths as unknown as Record<string, Record<string, Operation | unknown>>;
const METHODS = ["get", "post", "patch", "put", "delete"];

/** Every documented operation as `METHOD /api/v1/path/:param` with its scopes. */
export function documentedOperations(): { key: string; scopes: string[] }[] {
  return Object.entries(paths).flatMap(([path, item]) =>
    METHODS.filter((m) => item[m]).map((m) => ({
      key: `${m.toUpperCase()} ${PREFIX}${path.replaceAll(/\{(\w+)\}/g, ":$1")}`,
      scopes: ((item[m] as Operation).security ?? []).flatMap((s) => Object.values(s).flat()),
    })),
  );
}

function operationFor(method: string, url: string): Operation | undefined {
  const pathname = new URL(url, "https://x").pathname;
  for (const [template, item] of Object.entries(paths)) {
    const pattern = new RegExp(`^${PREFIX}${template.replaceAll(/\{\w+\}/g, "[^/]+")}$`);
    const operation = item[method.toLowerCase()] as Operation | undefined;
    if (operation && pattern.test(pathname)) return operation;
  }
  return undefined;
}

/** Fails unless the response's status and body are what the document says for this request. */
export async function expectDocumented(method: string, url: string, res: Response) {
  const label = `${method} ${url} ${res.status}`;
  const operation = operationFor(method, url);
  expect(operation, `${label}: no operation`).toBeDefined();
  const entry = operation?.responses[String(res.status)];
  expect(entry, `${label}: status not documented`).toBeDefined();
  const content = resolve(entry ?? {}).content ?? {};
  const type = (res.headers.get("content-type") ?? "").split(";")[0] ?? "";
  expect(Object.keys(content), label).toContain(type);
  const schema = content[type]?.schema;
  if (type === "application/json" && schema) {
    expect(check(schema, await res.clone().json()), label).toEqual([]);
  }
}
