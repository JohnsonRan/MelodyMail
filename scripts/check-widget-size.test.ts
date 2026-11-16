import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The widget size check (scripts/check-widget-size.py) against planted violations: it must turn
// red on each one, and exit 2 when it has nothing to measure.

const dir = mkdtempSync(join(tmpdir(), "widget-size-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function planted(name: string, content: string | Uint8Array): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

async function run(path?: string): Promise<number> {
  const script = join(import.meta.dir, "check-widget-size.py");
  const args = ["uv", "run", "--no-project", "--python", "3.13", "python", "-I", script];
  const child = Bun.spawn(path ? [...args, path] : args, { stdout: "pipe", stderr: "pipe" });
  return child.exited;
}

const random = (n: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(36)).join("");

test("passes the card and fails each planted violation", async () => {
  const card = await Bun.file(join(import.meta.dir, "../worker/src/telegram/card.html")).text();
  const codes = await Promise.all([
    run(),
    run(planted("padded.html", `${card}<!--${random(3000)}-->`)),
    run(planted("long.html", "a".repeat(32769))),
    run(planted("nul.html", `${card}\u0000`)),
    run(planted("latin1.html", new Uint8Array([0x3c, 0x70, 0x3e, 0xe9]))),
    run(planted("empty.html", "")),
    run(join(dir, "missing.html")),
  ]);
  expect(codes).toEqual([0, 1, 1, 1, 1, 2, 2]);
});
