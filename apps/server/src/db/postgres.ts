import pg from "pg";

import type { ServerEnv } from "../config/env.js";

export type PostgresPool = pg.Pool;

export function getDatabaseUrl(
  env: Pick<ServerEnv, "databaseUrl">,
): string | undefined {
  return env.databaseUrl;
}

export function createPostgresPool(
  env: Pick<ServerEnv, "databaseUrl" | "postgresPoolMax">,
  options: { applicationName?: string } = {},
): PostgresPool | null {
  const connectionString = getDatabaseUrl(env);
  if (!connectionString) {
    return null;
  }

  const pool = new pg.Pool({
    application_name: options.applicationName ?? "loomic-server",
    connectionString,
    max: env.postgresPoolMax ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });

  pool.on("error", (err) => {
    console.error("[postgres] Pool error (non-fatal):", err.message);
  });

  return pool;
}

export async function checkPostgresConnection(pool: PostgresPool | null) {
  if (!pool) {
    return { configured: false, ok: false } as const;
  }

  try {
    const { rows } = await pool.query<{ ok: number }>("select 1 as ok");
    return { configured: true, ok: rows[0]?.ok === 1 } as const;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { configured: true, ok: false, error: message } as const;
  }
}
