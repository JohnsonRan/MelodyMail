/** An error answer from the API: `code` is the `error` field, or "network" when none arrived. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryAfter?: number,
  ) {
    super(code);
  }
}

export async function api<T = Record<string, unknown>>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("network", 0);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const retryAfter = typeof data.retryAfter === "number" ? data.retryAfter : undefined;
    throw new ApiError(
      typeof data.error === "string" ? data.error : "internal",
      res.status,
      retryAfter,
    );
  }
  return data as T;
}

export type AuthState = { initialized: boolean; authenticated: boolean };

export function getAuthState(): Promise<AuthState> {
  return api<AuthState>("GET", "/auth/state");
}
