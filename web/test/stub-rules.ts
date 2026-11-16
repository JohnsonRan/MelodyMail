// The rule routes of the API stand-in (worker/src/rules/routes.ts) and the forwarding targets the
// editor offers. It keeps rules in memory, records every request, and answers a test with
// `testAnswer`; the Worker's own suite proves the evaluation.

const json = (data: unknown, status = 200) => Response.json(data, { status });

type Rule = Record<string, unknown> & { id: number; targetIds: number[] };

export type RulesCall = { method: string; path: string; body: unknown };

export class RulesStub {
  rules: Rule[] = [];
  targets = [
    { id: 7, email: "me@out.test", note: "", addressCount: 0, ruleCount: 0, createdAt: 0 },
  ];
  calls: RulesCall[] = [];
  testAnswer: Record<string, unknown> = {
    matched: true,
    conditions: [{ matched: true }],
    markRead: false,
    star: false,
    archive: true,
    trash: false,
    stop: false,
    targets: [],
  };
  private nextId = 1;

  async handle(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    const method = req.method;
    if (path === "/api/forward-targets" && method === "GET") return json({ targets: this.targets });
    if (!path.startsWith("/api/rules")) return null;
    const body = method === "GET" || method === "DELETE" ? null : await req.json();
    this.calls.push({ method, path, body });
    if (path === "/api/rules" && method === "GET") {
      return json({ rules: this.rules.map((r, i) => ({ ...r, position: i + 1 })) });
    }
    if (path === "/api/rules" && method === "POST") {
      const rule = { ...(body as object), id: this.nextId++ } as Rule;
      this.rules.push(rule);
      return json({ rule }, 201);
    }
    if (path === "/api/rules/order") {
      const ids = (body as { ids: number[] }).ids;
      this.rules = ids.map((id) => this.rules.find((r) => r.id === id) as Rule);
      return json({ ok: true });
    }
    if (path === "/api/rules/test") return json(this.testAnswer);
    const id = Number(path.split("/").pop());
    const index = this.rules.findIndex((r) => r.id === id);
    if (index === -1) return json({ error: "not_found" }, 404);
    if (method === "PUT") this.rules[index] = { ...(body as object), id } as Rule;
    if (method === "DELETE") this.rules.splice(index, 1);
    return json({ ok: true });
  }
}
