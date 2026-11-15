// Messages generated in memory, shared by the worker tests and bench/parse.ts. Nothing here
// imports from the test runtime.

const encoder = new TextEncoder();

/** Every fixture, also read by bench/parse.ts; test/parse.spec.ts checks it against the files. */
export const FIXTURE_NAMES = [
  "alternative",
  "base64",
  "big5",
  "euc-jp",
  "gb18030",
  "gbk",
  "header-only",
  "html-only",
  "iso-2022-jp",
  "malformed-boundary",
  "mixed-attachment",
  "no-subject",
  "plain",
  "quoted-printable",
  "shift-jis",
] as const;

/**
 * A message of about `size` bytes whose bulk is one base64 attachment, generated in memory so
 * the repository holds no large file. Email Routing refuses messages over 25 MiB, so the
 * largest reachable message is about 25 MiB raw; 20 MiB stays under it.
 */
export function largeMessage(size = 20 * 1024 * 1024): Uint8Array {
  const head = encoder.encode(
    [
      "From: Big Sender <big@example.org>",
      "To: shop@example.com",
      "Subject: Large attachment",
      "Message-ID: <large@example.org>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="big"',
      "",
      "--big",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "The archive is attached.",
      "--big",
      'Content-Type: application/zip; name="archive.zip"',
      'Content-Disposition: attachment; filename="archive.zip"',
      "Content-Transfer-Encoding: base64",
      "",
      "",
    ].join("\r\n"),
  );
  const tail = encoder.encode("--big--\r\n");
  const line = encoder.encode(`${"QUJDRA".repeat(12)}QUJD\r\n`);
  const lines = Math.floor((size - head.length - tail.length) / line.length);
  const out = new Uint8Array(head.length + lines * line.length + tail.length);
  out.set(head);
  for (let i = 0; i < lines; i++) out.set(line, head.length + i * line.length);
  out.set(tail, head.length + lines * line.length);
  return out;
}

/** `depth` multiparts nested inside each other (over the parser's nesting limit at 40). */
export function deeplyNested(depth: number): string {
  let raw = "Content-Type: text/plain\r\n\r\nleaf\r\n";
  for (let i = 0; i < depth; i++) {
    raw = `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n${raw}--b${i}--\r\n`;
  }
  return `Subject: Deep\r\n${raw}`;
}

/**
 * An attachment of `lines` base64 lines (78 bytes each) before the text part. With 2500 lines
 * the text starts after the first 64 KB but inside the 256 KB slice; with 4000 lines the slice
 * holds no text at all, the bounded parse's worst case (both passes run over attachment data).
 */
export function attachmentFirst(lines = 2500): Uint8Array {
  const body = `${"QUJDRA".repeat(12)}QUJD\r\n`.repeat(lines);
  return encoder.encode(
    [
      "From: Sender Name <sender@example.org>",
      "Subject: Attachment first",
      'Content-Type: multipart/mixed; boundary="af"',
      "",
      "--af",
      'Content-Type: image/png; name="scan.png"',
      "Content-Transfer-Encoding: base64",
      "",
      `${body}--af`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "The text after the attachment.",
      "--af--",
      "",
    ].join("\r\n"),
  );
}

/**
 * HTML bodies built to make a backtracking tag-stripping regex quadratic, each about 250 KB, with
 * the text htmlToText must still give back.
 */
export function adversarialHtml(): [name: string, message: Uint8Array, text: string][] {
  const size = 250 * 1024;
  const fill = (unit: string) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const cases: [string, string, string][] = [
    ["'<' repeated, no '>'", `<p>lead</p>${fill("<")}`, "lead"],
    ["'<head' repeated", `<p>lead</p>${fill("<head")}`, "lead"],
    ["'<script ' repeated, never closed", `<p>lead</p>${fill("<script ")}`, "lead"],
    ["'<!--' repeated, no '-->'", `<p>lead</p>${fill("<!--")}`, "lead"],
    ["attribute without '>'", `<p>lead</p><a href="${fill("x")}`, "lead"],
    ["'&amp' repeated, no ';'", fill("&amp"), fill("&amp").slice(0, 8 * 1024)],
  ];
  return cases.map(([name, body, text]) => [
    name,
    encoder.encode(
      `From: Sender <sender@example.org>\r\nSubject: Adversarial\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${body}\r\n`,
    ),
    text,
  ]);
}
