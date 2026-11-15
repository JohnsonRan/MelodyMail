// The committed .eml fixtures, loaded as text through Vite (workerd has no file system).

const FIXTURES = import.meta.glob<string>("./*.eml", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** A committed fixture from test/fixtures (all of them are ASCII). */
export function fixture(name: string): string {
  const raw = FIXTURES[`./${name}.eml`];
  if (raw === undefined) throw new Error(`no fixture ${name}`);
  return raw;
}

export function fixtureNames(): string[] {
  return Object.keys(FIXTURES)
    .map((k) => k.slice(2, -4))
    .sort();
}
