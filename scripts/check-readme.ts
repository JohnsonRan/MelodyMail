#!/usr/bin/env bun
/**
 * Fail when the three READMEs drift apart (docs/M7-ops.md, "README in three languages"): they
 * must have the same sequence of heading levels, the same fenced code blocks (commands are never
 * translated), and the same link targets in the same order. A link to one of the three README
 * files counts as the same target, so each file can link to the other two languages.
 *
 * Exit codes: 0 in sync, 1 violations found, 2 could not run (a file missing, empty or without
 * a heading).
 * Usage: bun scripts/check-readme.ts [dir]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const FILES = ["README.md", "README.zh-CN.md", "README.ja-JP.md"];
const LANGUAGE_LINK = "<README>";

export type Outline = { headings: number[]; blocks: string[]; links: string[] };

export class CannotRun extends Error {}

/** Heading levels, fenced code blocks and link targets of one Markdown file, in order. */
export function outline(text: string): Outline {
  const headings: number[] = [];
  const blocks: string[] = [];
  const prose: string[] = [];
  let fence: { marker: string; indent: number; lines: string[] } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const open = /^( *)(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (open?.[2]?.startsWith(fence.marker) && open[3]?.trim() === "") {
        blocks.push(fence.lines.join("\n"));
        fence = null;
      } else {
        fence.lines.push(line.slice(Math.min(fence.indent, line.search(/\S|$/))));
      }
      continue;
    }
    if (open) {
      const indent = open[1]?.length ?? 0;
      fence = { marker: open[2] as string, indent, lines: [(open[3] ?? "").trim()] };
      continue;
    }
    const heading = /^(#{1,6})\s/.exec(line);
    if (heading) headings.push(heading[1]?.length ?? 0);
    prose.push(line);
  }
  if (fence) blocks.push(fence.lines.join("\n"));
  const body = prose.join("\n").replace(/`[^`\n]*`/g, "");
  const links: string[] = [];
  const link =
    /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|<(https?:\/\/[^>\s]+)>|^\s*\[[^\]]+\]:\s*(\S+)/gm;
  for (const m of body.matchAll(link)) {
    const target = (m[1] ?? m[2] ?? m[3]) as string;
    links.push(FILES.includes(target.replace(/^\.\//, "")) ? LANGUAGE_LINK : target);
  }
  return { headings, blocks, links };
}

/** Differences between the reference outline (the first file) and each other file. */
export function compare(files: Map<string, Outline>): string[] {
  const [[refName, ref] = [], ...rest] = [...files];
  if (!refName || !ref || rest.length === 0) throw new CannotRun("need at least two files");
  const problems: string[] = [];
  for (const [name, other] of rest) {
    if (other.headings.join(",") !== ref.headings.join(",")) {
      problems.push(
        `${name}: heading levels ${other.headings.join(",")} differ from ${refName} ${ref.headings.join(",")}`,
      );
    }
    if (other.blocks.length !== ref.blocks.length) {
      problems.push(
        `${name}: ${other.blocks.length} code blocks, ${refName} has ${ref.blocks.length}`,
      );
    } else {
      ref.blocks.forEach((block, i) => {
        if (other.blocks[i] !== block) problems.push(`${name}: code block ${i + 1} differs`);
      });
    }
    if (other.links.length !== ref.links.length) {
      problems.push(`${name}: ${other.links.length} links, ${refName} has ${ref.links.length}`);
    } else {
      ref.links.forEach((target, i) => {
        if (other.links[i] !== target) {
          problems.push(`${name}: link ${i + 1} is ${other.links[i]}, ${refName} has ${target}`);
        }
      });
    }
  }
  return problems;
}

/** Reads the three READMEs from `dir`; refuses a missing or empty file, or one with no heading. */
export function load(dir: string): Map<string, Outline> {
  const files = new Map<string, Outline>();
  for (const name of FILES) {
    const path = join(dir, name);
    if (!existsSync(path)) throw new CannotRun(`${name} is missing`);
    const text = readFileSync(path, "utf8");
    if (text.trim() === "") throw new CannotRun(`${name} is empty`);
    const parsed = outline(text);
    if (parsed.headings.length === 0) throw new CannotRun(`${name} has no heading`);
    files.set(name, parsed);
  }
  return files;
}

export function main(dir: string): number {
  try {
    const problems = compare(load(dir));
    for (const p of problems) console.error(p);
    if (problems.length > 0) return 1;
    console.log(`READMEs in sync: ${FILES.join(", ")}`);
    return 0;
  } catch (err) {
    if (!(err instanceof CannotRun)) throw err;
    console.error(`check-readme could not run: ${err.message}`);
    return 2;
  }
}

if (import.meta.main) process.exit(main(process.argv[2] ?? join(import.meta.dir, "..")));
