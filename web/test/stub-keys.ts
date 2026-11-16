// The API key routes of the stand-in (worker/src/api/keys.ts). Creation answers reauth_required
// until the page has passed POST /api/auth/reauth/verify (`isFresh`), as a stale session does.
// The Worker's own suite proves the keys themselves.

const json = (data: unknown, status = 200) => Response.json(data, { status });

export const CREATED_KEY = `mmk_abcdefgh_${"S".repeat(43)}`;

export type KeyRow = Record<string, unknown> & { id: number; label: string };

export class KeysStub {
  keys: KeyRow[] = [];
  calls: { method: string; path: string; body: unknown }[] = [];

  constructor(private readonly isFresh: () => boolean) {}

  async handle(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    const method = req.method;
    if (path === "/api/openapi.json") return json({ openapi: "3.1.0" });
    if (!path.startsWith("/api/keys")) return null;
    const body = method === "POST" ? await req.json() : null;
    this.calls.push({ method, path, body });
    if (method === "GET") return json({ apiKeys: this.keys });
    if (method === "POST") {
      if (!this.isFresh()) return json({ error: "reauth_required" }, 403);
      const b = body as { label: string; scopes: string[]; expiresInDays: number | null };
      const now = Date.now();
      const apiKey = {
        id: this.keys.length + 1,
        publicId: "abcdefgh",
        label: b.label,
        scopes: b.scopes,
        createdAt: now,
        expiresAt: b.expiresInDays === null ? null : now + b.expiresInDays * 86_400_000,
        lastUsedAt: null,
        lastUsedIp: null,
      };
      this.keys.push(apiKey);
      return json({ key: CREATED_KEY, apiKey }, 201);
    }
    const id = Number(path.split("/").pop());
    const index = this.keys.findIndex((k) => k.id === id);
    if (index === -1) return json({ error: "not_found" }, 404);
    this.keys.splice(index, 1);
    return json({ ok: true });
  }
}
