import type { Stored } from "./stub-app";

// The sending routes of the API stand-in (docs/M5-sending.md, "Routes"), answering like
// worker/src/send. It records what the app sent so a test can assert the requests.

const json = (data: unknown, status = 200) => Response.json(data, { status });

/** A sent message as the Worker stores it: the row and the JSON copy the reader shows. */
export function sentMessage(id: string, body: Record<string, unknown>, status = "sent"): Stored {
  const to = (body.to as string[]) ?? [];
  const copy = {
    from: "Shop <shop@example.com>",
    to,
    cc: body.cc ?? [],
    bcc: body.bcc ?? [],
    subject: body.subject,
    text: body.text,
    html: body.html,
    attachments: [],
  };
  return {
    item: {
      id,
      addressId: 1,
      tag: null,
      from: copy.from,
      subject: body.subject,
      snippet: String(body.text).slice(0, 200),
      receivedAt: Date.now(),
      date: null,
      size: 1,
      read: true,
      starred: false,
      archived: false,
      trashed: false,
      hasAttachments: false,
      status,
      threadKey: id,
      direction: "out",
      to: to.join(", "),
      error: null,
      cc: null,
      bcc: null,
      idempotencyKey: body.idempotencyKey,
      firstAttemptAt: Date.now(),
      maybeAccepted: 0,
      envelopeFrom: "shop@example.com",
      envelopeTo: to.join(", "),
      forwardFailed: 0,
    },
    raw: JSON.stringify(copy),
  };
}

type Upload = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  draftId: string | null;
};

export class SendStub {
  setup = {
    configured: true,
    attachments: true,
    addresses: [{ id: 1, address: "shop@example.com", displayName: "Shop" }],
  };
  quota = { daily: { used: 12, limit: 100 }, monthly: { used: 340, limit: 3000 }, seenAt: 1 };
  drafts = new Map<string, Record<string, unknown>>();
  draftSaves: Record<string, unknown>[] = [];
  uploads = new Map<string, Upload>();
  sends: Record<string, unknown>[] = [];
  /** Answers for the next sends, in order; "ok" when empty. */
  answers: ("ok" | "fail" | "quota" | "rejected" | "inProgress" | "unknown")[] = [];
  /** Milliseconds each send waits before it answers. */
  sendDelay = 0;

  async handle(req: Request, url: URL, store: Map<string, Stored>): Promise<Response | null> {
    const path = url.pathname;
    const method = req.method;
    if (path === "/api/send/from") return json(this.setup);
    if (path === "/api/send/quota") return json(this.quota);
    if (path === "/api/drafts" && method === "GET") {
      const drafts = [...this.drafts.values()].map(({ text, ...d }) => ({
        ...d,
        snippet: String(text ?? "").slice(0, 200),
        updatedAt: Date.now(),
      }));
      return json({ drafts });
    }
    const draft = /^\/api\/drafts\/([^/]+)$/.exec(path);
    if (draft) return this.draft(req, draft[1] ?? "");
    if (path === "/api/uploads" && method === "PUT") {
      const body = await req.arrayBuffer();
      const id = `upload-${this.uploads.size + 1}`;
      const upload = {
        id,
        filename: decodeURIComponent(req.headers.get("x-filename") ?? ""),
        contentType: req.headers.get("content-type") ?? "application/octet-stream",
        size: body.byteLength,
        draftId: req.headers.get("x-draft-id"),
      };
      this.uploads.set(id, upload);
      return json({ upload });
    }
    const upload = /^\/api\/uploads\/([^/]+)$/.exec(path);
    if (upload && method === "DELETE") {
      this.uploads.delete(upload[1] ?? "");
      return json({ ok: true });
    }
    // A sent message's attachment, as the owner downloads it.
    if (upload && method === "GET")
      return new Response("hello", { headers: { "content-type": "text/plain" } });
    if (path === "/api/messages/send" && method === "POST") return this.send(req, store);
    return null;
  }

  private async draft(req: Request, id: string): Promise<Response> {
    if (req.method === "PUT") {
      const body = (await req.json()) as Record<string, unknown>;
      this.draftSaves.push(body);
      this.drafts.set(id, { id, ...body });
      return json({ ok: true, updatedAt: Date.now() });
    }
    if (req.method === "DELETE") {
      this.drafts.delete(id);
      return json({ ok: true });
    }
    const found = this.drafts.get(id);
    if (!found) return json({ error: "not_found" }, 404);
    const attachments = [...this.uploads.values()].filter((u) => u.draftId === id);
    return json({ draft: { sourceId: null, sourceKind: null, ...found, attachments } });
  }

  private async send(req: Request, store: Map<string, Stored>): Promise<Response> {
    const body = (await req.json()) as Record<string, unknown>;
    this.sends.push(body);
    if (this.sendDelay) await Bun.sleep(this.sendDelay);
    const answer = this.answers.shift() ?? "ok";
    if (answer === "fail") return json({ error: "send_failed", id: "failed-1" }, 502);
    if (answer === "quota") return json({ error: "daily_quota_exceeded", id: "failed-1" }, 429);
    if (answer === "rejected") return json({ error: "send_rejected", id: "failed-1" }, 422);
    if (answer === "inProgress") return json({ error: "send_in_progress" }, 409);
    if (answer === "unknown") return json({ error: "send_status_unknown", id: "failed-1" }, 409);
    const id = `sent-${this.sends.length}`;
    store.set(id, sentMessage(id, body));
    for (const [key, d] of this.drafts) {
      if (d.idempotencyKey === body.idempotencyKey) this.drafts.delete(key);
    }
    return json({ message: { id, status: "sent" } });
  }
}
