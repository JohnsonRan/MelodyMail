import { senderLabel } from "../push/send";

// What a Telegram card carries (docs/M5b-telegram.md, "Sending"): the sender label, the subject,
// the arrival address and the app's link in chat_data, which the widget writes with textContent;
// the same sender and subject in the caption. Never the message text.

export type Language = "zh-CN" | "en" | "ja-JP";

/** Indexed by a flag's value: a button's label by the current one, a notice by the new one. */
type Pair = [string, string];

/**
 * Copy the Worker writes to the chat. The button labels and the gone, unbound and failed lines
 * repeat card.html word for word, so a plain message reads like the widget.
 */
const COPY: Record<
  Language,
  {
    connected: string;
    invalidCode: string;
    noSubject: string;
    open: string;
    testSubject: string;
    read: Pair;
    arch: Pair;
    star: Pair;
    done: { read: Pair; arch: Pair; star: Pair };
    gone: string;
    unbound: string;
    failed: string;
  }
> = {
  en: {
    connected: "Connected. New mail will appear here.",
    invalidCode:
      "This code is invalid or expired. Create a new one in MelodyMail: Settings > Notifications.",
    noSubject: "(no subject)",
    open: "Open",
    testSubject: "Test notification",
    read: ["Mark as read", "Mark as unread"],
    arch: ["Archive", "Move to Inbox"],
    star: ["Star", "Remove star"],
    done: {
      read: ["Marked as unread", "Marked as read"],
      arch: ["Moved to Inbox", "Archived"],
      star: ["Star removed", "Starred"],
    },
    gone: "This message was deleted in MelodyMail.",
    unbound: "Telegram is no longer connected to MelodyMail.",
    failed: "MelodyMail didn't answer. Try again.",
  },
  "zh-CN": {
    connected: "已连接。新邮件会显示在这里。",
    invalidCode: "此代码无效或已过期。请在 MelodyMail 中重新创建：设置 > 通知。",
    noSubject: "（无主题）",
    open: "打开",
    testSubject: "测试通知",
    read: ["标记为已读", "标记为未读"],
    arch: ["存档", "移到收件箱"],
    star: ["加星标", "取消星标"],
    done: {
      read: ["已标记为未读", "已标记为已读"],
      arch: ["已移到收件箱", "已存档"],
      star: ["已取消星标", "已加星标"],
    },
    gone: "这封邮件已在 MelodyMail 中删除。",
    unbound: "Telegram 已与 MelodyMail 断开连接。",
    failed: "MelodyMail 没有响应。请重试。",
  },
  "ja-JP": {
    connected: "接続しました。新着メールはここに表示されます。",
    invalidCode:
      "このコードは無効か期限切れです。MelodyMail の [設定] > [通知] で新しいコードを作成してください。",
    noSubject: "(件名なし)",
    open: "開く",
    testSubject: "テスト通知",
    read: ["既読にする", "未読にする"],
    arch: ["アーカイブ", "受信トレイに移動"],
    star: ["スターを付ける", "スターを外す"],
    done: {
      read: ["未読にしました", "既読にしました"],
      arch: ["受信トレイに移動しました", "アーカイブしました"],
      star: ["スターを外しました", "スターを付けました"],
    },
    gone: "このメールは MelodyMail で削除されました。",
    unbound: "Telegram と MelodyMail の接続は解除されています。",
    failed: "MelodyMail から応答がありません。もう一度お試しください。",
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

export type Action = "read" | "arch" | "star";
type Flags = Pick<CardMail, "read" | "archived" | "starred">;

/**
 * The plain message's inline keyboard: Open, then the three toggles. A toggle's callback data is
 * the widget's request format, `<action>:<target value>`, and names no message. Without flags
 * (the test card) only Open is shown.
 */
export function keyboard(language: string | null, url: string, flags?: Flags) {
  const words = copy(language);
  const open = { text: words.open, url };
  if (!flags) return { inline_keyboard: [[open]] };
  const toggle = (action: Action, value: number) => ({
    text: words[action][value ? 1 : 0],
    callback_data: `${action}:${value ? 0 : 1}`,
  });
  return {
    inline_keyboard: [
      [open, toggle("read", flags.read)],
      [toggle("arch", flags.archived), toggle("star", flags.starred)],
    ],
  };
}
