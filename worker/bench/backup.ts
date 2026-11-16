#!/usr/bin/env bun
import { buildManifest, PAGE_BYTES, type PartInfo, PIECE_CHARS, partText } from "../src/backup/sql";
import { EXPORTED, type ExportTable } from "../src/backup/tables";
/**
 * JS time of one export page (docs/M7-ops.md, "Proof"), measured under Bun as workerd does not
 * advance performance.now() during computation. Each input includes decoding D1's JSON answer,
 * since the binding parses it in the Worker:
 * - a full page: 256 KB of short INSERTs (messages-sized rows), and of FTS-sized rows;
 * - an oversized row: a 512 K-character draft (CJK, quotes, surrogate pairs) as D1 returns it,
 *   split into UPDATEs;
 * - the manifest of a 300-part export, from the state row's JSON;
 * - the metadata email() adds to the raw object's put.
 * Exits 1 when the p95 of any input reaches its budget.
 *
 * Usage: bun bench/backup.ts [iterations]
 */
import { rawMetadata } from "../src/mail/inbound";

const ITERATIONS = Number(process.argv[2] ?? 200);
/**
 * Proposed (REQUIREMENTS.md, Numbers): a run writes at most 4 full pages, or one oversized row
 * alone; with the 3 times production margin both stay under the 10 ms cap beside the other jobs.
 */
const PAGE_BUDGET_MS = 1;
const OVERSIZED_BUDGET_MS = 2;
const METADATA_BUDGET_MS = 0.05;

const table = (name: string) => EXPORTED.find((t) => t.name === name) as ExportTable;

/** D1's answer to a page query: rows of { r, s } up to PAGE_BYTES of SQL. */
function pageAnswer(rowText: (i: number) => string): string {
  const results: { r: number; s: string }[] = [];
  let bytes = 0;
  for (let i = 1; bytes < PAGE_BYTES; i++) {
    const s = rowText(i);
    const n = Buffer.byteLength(s);
    if (bytes + n > PAGE_BYTES) break;
    results.push({ r: i, s });
    bytes += n;
  }
  return JSON.stringify({ results, success: true, meta: { rows_read: results.length } });
}

const messageRow = (i: number) =>
  `INSERT INTO "messages" (${table("messages")
    .columns.map((c) => `"${c}"`)
    .join(
      ",",
    )}) VALUES ('${crypto.randomUUID()}',1,'in','parsed','sender${i}@example.org','shop@example.com',NULL,'<${i}@example.org>',NULL,NULL,'t${i}','件名「テスト」${i}','Sender <s@example.org>','shop@example.com',NULL,NULL,'Mon, 16 Nov 2026 10:00:00 +0000','${"摘要".repeat(60)}',${3000 + i},0,'raw/2026/11/${i}.eml',0,1,0,0,0,0,NULL,${1794800000000 + i},NULL,NULL,NULL,NULL,0);`;
const ftsRow = (i: number) =>
  `INSERT INTO "messages_fts" ("rowid","message_id","subject","sender","body") VALUES (${i},'${crypto.randomUUID()}','件名','Sender','${"正文の検索テキスト it''s ".repeat(400)}');`;

const messagesPage = pageAnswer(messageRow);
const ftsPage = pageAnswer(ftsRow);

const LONG = "中文'草\n😀".repeat(Math.floor((512 * 1024) / 7));
/** D1's answer to the split query: the INSERT, then one UPDATE per PIECE_CHARS characters. */
function splitAnswer(): string {
  const chars = Array.from(LONG);
  const results = [
    {
      o: -1,
      k: 0,
      s: `INSERT INTO "drafts" (${table("drafts")
        .columns.map((c) => `"${c}"`)
        .join(",")}) VALUES ('d',1,'[]','[]','[]','s','','x',NULL,'key',1,1);`,
    },
  ];
  for (let k = 0; k * PIECE_CHARS < chars.length; k++) {
    const piece = chars.slice(k * PIECE_CHARS, (k + 1) * PIECE_CHARS).join("");
    results.push({
      o: 6,
      k,
      s: `UPDATE "drafts" SET "text" = "text" || '${piece.replaceAll("'", "''")}' WHERE "id" = 'd';`,
    });
  }
  return JSON.stringify({ results, success: true });
}
const oversized = splitAnswer();
const parts: PartInfo[] = Array.from({ length: 300 }, (_, i) => ({
  table: EXPORTED[i % EXPORTED.length]?.name as string,
  key: `backups/d1/2026-11-18T0300Z/part-messages-${String(i).padStart(5, "0")}.sql`,
  bytes: 524_000,
  md5: "0123456789abcdef0123456789abcdef",
}));
const state = {
  id: "2026-11-18T0300Z",
  startedAt: 1,
  rowsJson: JSON.stringify(
    Object.fromEntries(EXPORTED.map((t) => [t.name, { rows: 20_000, lastRowid: 20_000 }])),
  ),
  partsJson: JSON.stringify(parts),
};

function page(answer: string) {
  const { results } = JSON.parse(answer) as { results: { s: string }[] };
  return partText(results.map((r) => r.s)).length;
}

const inputs: [string, () => unknown, number][] = [
  ["page: 256 KB of messages rows", () => page(messagesPage), PAGE_BUDGET_MS],
  ["page: 256 KB of FTS rows", () => page(ftsPage), PAGE_BUDGET_MS],
  ["page: 512 K-character draft", () => page(oversized), OVERSIZED_BUDGET_MS],
  [
    "manifest: 300 parts",
    () => JSON.stringify(buildManifest(EXPORTED, state, 2, "0015")),
    PAGE_BUDGET_MS,
  ],
  [
    "email(): raw metadata",
    () => rawMetadata(1, "sender@example.org", "shop+tag@example.com", 1794800000000),
    METADATA_BUDGET_MS,
  ],
];

let over = false;
for (const [name, work, budget] of inputs) {
  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS + 20; i++) {
    const start = performance.now();
    work();
    if (i >= 20) samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const at = (q: number) =>
    samples[Math.min(samples.length - 1, Math.floor(q * samples.length))] ?? 0;
  if (at(0.95) >= budget) over = true;
  console.log(
    `${name.padEnd(30)} median ${at(0.5).toFixed(3)} ms, p95 ${at(0.95).toFixed(3)} ms, max ${at(1).toFixed(3)} ms (budget ${budget} ms)`,
  );
}
console.log(
  `answers (UTF-16 units): messages ${messagesPage.length}, FTS ${ftsPage.length}, draft ${oversized.length}`,
);
if (over) {
  console.error("p95 at or over the budget");
  process.exit(1);
}
