import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILES, main } from "./check-readme";

const EN = `# MelodyMail

[简体中文](README.zh-CN.md) · [日本語](README.ja-JP.md)

A mail service.

## Deploy

1. Install:

   \`\`\`sh
   bun install
   \`\`\`

See [the runbook](docs/RUNBOOK.md), set \`UPLOAD_URL_KEY\` and \`[not](a-link)\`.

\`\`\`sh
bun run deploy:prod
\`\`\`
`;

const ZH = `# MelodyMail

[English](README.md) · [日本語](README.ja-JP.md)

一个邮件服务。

## 部署

1. 安装：

   \`\`\`sh
   bun install
   \`\`\`

请参阅[运行手册](docs/RUNBOOK.md)，设置 \`UPLOAD_URL_KEY\` 和 \`[not](a-link)\`。

\`\`\`sh
bun run deploy:prod
\`\`\`
`;

const JA = ZH.replace("[日本語](README.ja-JP.md)", "[简体中文](README.zh-CN.md)");

const dirs: string[] = [];

/** Writes the three READMEs (EN, ZH, JA unless replaced) and runs the check on them. */
function run(files: Partial<Record<string, string | null>> = {}): number {
  const dir = mkdtempSync(join(tmpdir(), "check-readme-"));
  dirs.push(dir);
  const texts: Record<string, string | null> = {
    [FILES[0] as string]: EN,
    [FILES[1] as string]: ZH,
    [FILES[2] as string]: JA,
    ...files,
  };
  for (const [name, text] of Object.entries(texts)) {
    if (text !== null) writeFileSync(join(dir, name), text as string);
  }
  return main(dir);
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("check-readme", () => {
  test("files in sync pass, including the repository's own READMEs", () => {
    expect(run()).toBe(0);
    expect(main(join(import.meta.dir, ".."))).toBe(0);
  });

  test("a different heading level fails", () => {
    expect(run({ "README.ja-JP.md": JA.replace("## 部署", "### 部署") })).toBe(1);
  });

  test("a missing heading fails", () => {
    expect(run({ "README.zh-CN.md": ZH.replace("## 部署\n", "") })).toBe(1);
  });

  test("a changed command fails", () => {
    expect(run({ "README.zh-CN.md": ZH.replace("bun run deploy:prod", "bun run deploy") })).toBe(1);
  });

  test("a translated comment in a code block fails", () => {
    expect(
      run({ "README.ja-JP.md": JA.replace("bun install\n", "bun install  # 依存関係\n") }),
    ).toBe(1);
  });

  test("a missing code block fails", () => {
    expect(
      run({ "README.ja-JP.md": JA.replace(/\n```sh\nbun run deploy:prod\n```\n/, "\n") }),
    ).toBe(1);
  });

  test("a dropped or renamed inline code span fails", () => {
    expect(run({ "README.zh-CN.md": ZH.replace(" `UPLOAD_URL_KEY` 和", "") })).toBe(1);
    expect(run({ "README.ja-JP.md": JA.replace("`UPLOAD_URL_KEY`", "`UPLOAD_KEY`") })).toBe(1);
  });

  test("a different link target fails", () => {
    expect(run({ "README.zh-CN.md": ZH.replace("docs/RUNBOOK.md", "docs/REFERENCE.md") })).toBe(1);
  });

  test("an extra link fails", () => {
    expect(run({ "README.ja-JP.md": `${JA}\n[OpenAPI](worker/src/api/openapi.json)\n` })).toBe(1);
  });

  test("a missing, empty or heading-less file cannot pass", () => {
    expect(run({ "README.ja-JP.md": null })).toBe(2);
    expect(run({ "README.zh-CN.md": "" })).toBe(2);
    expect(run({ "README.md": "\n  \n" })).toBe(2);
    expect(
      run({
        "README.md": "no heading\n",
        "README.zh-CN.md": "none\n",
        "README.ja-JP.md": "none\n",
      }),
    ).toBe(2);
  });
});
