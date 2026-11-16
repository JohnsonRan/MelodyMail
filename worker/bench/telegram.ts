#!/usr/bin/env bun
/**
 * JS time of the Telegram work per input (docs/M5b-telegram.md, "CPU"), measured under Bun as
 * workerd does not advance performance.now() during computation:
 * - the webhook: hashing the secret header and comparing it, decoding and parsing a 64 KB update
 *   (the cap), and checking a tap's data;
 * - the Hub: building a worst-case card (chat_data with the cuts, the caption) and the sendWidget
 *   request body with the template.
 * Exits 1 when the p95 of any input reaches the 3 ms budget.
 *
 * Usage: bun bench/telegram.ts [iterations]
 */
import { hashMatches, sha256Hex } from "../src/auth/crypto";
import { caption, chatData } from "../src/telegram/card";

const ITERATIONS = Number(process.argv[2] ?? 200);
const BUDGET_MS = 3;
/** UPDATE_MAX in src/telegram/webhook.ts, which imports cloudflare:workers and cannot load here. */
const UPDATE_MAX = 64 * 1024;
const html = await (await fetch(new URL("../src/telegram/card.html", import.meta.url))).text();
const secret = "s".repeat(43);
const secretHash = await sha256Hex(secret);

// A text message padded with entities up to the cap: the largest update the webhook parses.
function bigUpdate(): Uint8Array {
  const entities: unknown[] = [];
  const update = {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: 1, type: "private" },
      from: { id: 1, first_name: "Owner" },
      text: "x".repeat(4096),
      entities,
    },
  };
  while (JSON.stringify(update).length < UPDATE_MAX - 64) {
    entities.push({ type: "bold", offset: entities.length, length: 1 });
  }
  return new TextEncoder().encode(JSON.stringify(update));
}

const tap = new TextEncoder().encode(
  JSON.stringify({
    update_id: 2,
    widget_query: {
      id: "1",
      from: { id: 1 },
      chat: { id: 1, type: "private" },
      message_id: 42,
      data: "star:1",
    },
  }),
);

const mail = {
  subject: "長い件名の「テスト」".repeat(120),
  fromHdr: `"${'山田 "太郎" \\'.repeat(60)}" <yamada@example.jp>`,
  envelopeFrom: "yamada@example.jp",
  envelopeTo: `${"a".repeat(64)}@${"b".repeat(13)}.jp`,
  read: 0,
  archived: 0,
  starred: 0,
};

async function webhookWork(body: Uint8Array) {
  if (!(await hashMatches(secret, secretHash))) throw new Error("hash");
  const update = JSON.parse(new TextDecoder().decode(body));
  const data = update.widget_query?.data;
  return typeof data === "string" && /^(read|arch|star):([01])$/.test(data);
}

function cardWork() {
  const id = crypto.randomUUID();
  return JSON.stringify({
    chat_id: 1,
    html,
    chat_data: chatData(mail, "https://mail.example.com", id),
    caption: caption("山田 太郎".repeat(200), mail.subject, "ja-JP"),
    allow_queries: true,
    protect_content: true,
  });
}

const big = bigUpdate();
const inputs: [string, () => unknown][] = [
  ["webhook: 64 KB update", () => webhookWork(big)],
  ["webhook: a tap", () => webhookWork(tap)],
  ["hub: worst-case card", cardWork],
];

let over = false;
for (const [name, work] of inputs) {
  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS + 20; i++) {
    const start = performance.now();
    await work();
    if (i >= 20) samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const at = (q: number) =>
    samples[Math.min(samples.length - 1, Math.floor(q * samples.length))] ?? 0;
  if (at(0.95) >= BUDGET_MS) over = true;
  console.log(
    `${name.padEnd(26)} median ${at(0.5).toFixed(3)} ms, p95 ${at(0.95).toFixed(3)} ms, max ${at(1).toFixed(3)} ms`,
  );
}
console.log(`card body ${cardWork().length} bytes; 64 KB update ${big.byteLength} bytes`);
if (over) {
  console.error(`p95 at or over the ${BUDGET_MS} ms budget`);
  process.exit(1);
}
