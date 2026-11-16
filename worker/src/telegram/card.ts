import { senderLabel } from "../push/send";

// What a Telegram card carries (docs/M5b-telegram.md, "Sending"): the sender label, the subject,
// the arrival address and the app's link in chat_data, which the widget writes with textContent;
// the same sender and subject in the caption. Never the message text.

export type Language = "zh-CN" | "en" | "ja-JP";

/** Copy the Worker writes to the chat; the card's own copy is in card.html. */
const COPY: Record<
  Language,
  { connected: string; invalidCode: string; noSubject: string; open: string; testSubject: string }
> = {
  en: {
    connected: "Connected. New mail will appear here.",
    invalidCode:
      "This code is invalid or expired. Create a new one in MelodyMail: Settings > Notifications.",
    noSubject: "(no subject)",
    open: "Open",
    testSubject: "Test notification",
  },
  "zh-CN": {
    connected: "已连接。新邮件会显示在这里。",
    invalidCode: "此代码无效或已过期。请在 MelodyMail 中重新创建：设置 > 通知。",
    noSubject: "（无主题）",
    open: "打开",
    testSubject: "测试通知",
  },
  "ja-JP": {
    connected: "接続しました。新着メールはここに表示されます。",
    invalidCode:
      "このコードは無効か期限切れです。MelodyMail の [設定] > [通知] で新しいコードを作成してください。",
    noSubject: "(件名なし)",
    open: "開く",
    testSubject: "テスト通知",
  },
};

export function copy(language: string | null) {
  return COPY[(language ?? "en") as Language] ?? COPY.en;
}

/** Telegram's language_code mapped to the app's three locales; anything else is English. */
export function languageOf(code: unknown): Language {
  const value = typeof code === "string" ? code.toLowerCase() : "";
  if (value.startsWith("zh")) return "zh-CN";
  if (value.startsWith("ja")) return "ja-JP";
  return "en";
}

/** Byte budgets of the text fields, measured on their JSON-escaped UTF-8 form. */
const BUDGET = { f: 200, s: 400, t: 200 };
export const CHAT_DATA_MAX = 1024;
export const CAPTION_MAX = 1024;

const encoder = new TextEncoder();

/** Cuts by code point so that the JSON-escaped value stays within `max` bytes. */
export function cutEscaped(value: string, max: number): string {
  let used = 0;
  let out = "";
  for (const char of value) {
    used += encoder.encode(JSON.stringify(char)).byteLength - 2;
    if (used > max) break;
    out += char;
  }
  return out;
}

export type CardMail = {
  subject: string | null;
  fromHdr: string | null;
  envelopeFrom: string;
  envelopeTo: string;
  read: number;
  archived: number;
  starred: number;
};

export function messageLink(origin: string, id: string): string {
  return `${origin}/?m=${encodeURIComponent(id)}`;
}

/** The card's state: content, the app link and the three flags the buttons toggle. */
export function chatData(mail: CardMail, origin: string, id: string): string {
  return JSON.stringify({
    v: 1,
    f: cutEscaped(senderLabel(mail.fromHdr, mail.envelopeFrom), BUDGET.f),
    s: mail.subject === null ? null : cutEscaped(mail.subject, BUDGET.s),
    t: cutEscaped(mail.envelopeTo, BUDGET.t),
    u: messageLink(origin, id),
    r: mail.read ? 1 : 0,
    a: mail.archived ? 1 : 0,
    st: mail.starred ? 1 : 0,
  });
}

/** The state of a card whose mail is gone: the card drops its content. */
export const GONE = JSON.stringify({ v: 1, g: 1 });

/** The test card: sample content; its buttons explain themselves without a request. */
export function testChatData(origin: string, language: string | null): string {
  return JSON.stringify({
    v: 1,
    x: 1,
    f: "MelodyMail",
    s: copy(language).testSubject,
    t: null,
    u: `${origin}/`,
  });
}

/** Plain caption text (no parse_mode): sender, then subject. Cut to 1024 UTF-16 units. */
export function caption(sender: string, subject: string | null, language: string | null): string {
  const text = `${sender}\n${subject ?? copy(language).noSubject}`;
  let out = "";
  for (const char of text) {
    if (out.length + char.length > CAPTION_MAX) break;
    out += char;
  }
  return out;
}
