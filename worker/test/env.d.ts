import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      RESTORE_DB: D1Database;
    }
  }
  // Vite's import.meta.glob loads the .eml fixtures as text in workerd; bench/parse.ts reads them
  // from import.meta.url under Bun.
  interface ImportMeta {
    url: string;
    glob<T>(
      pattern: string,
      options: { query: "?raw"; import: "default"; eager: true },
    ): Record<string, T>;
  }
}
