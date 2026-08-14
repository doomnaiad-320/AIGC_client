import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";

import { SERVICE_ROLE_CONNECTION_OPTIONS } from "../../db/postgres.js";
import { LANGGRAPH_PERSISTENCE_SCHEMA } from "./postgres-checkpointer.js";

/**
 * Default pool size for the store connection pool.
 * Kept low to avoid exhausting Postgres connection limits.
 */
const DEFAULT_POOL_MAX = 3;

export async function createPostgresStore(options: {
  connectionString: string;
  poolMax?: number;
}) {
  const store = new PostgresStore({
    connectionOptions: {
      connectionString: options.connectionString,
      options: SERVICE_ROLE_CONNECTION_OPTIONS,
      max: options.poolMax ?? DEFAULT_POOL_MAX,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    },
    schema: LANGGRAPH_PERSISTENCE_SCHEMA,
  });
  await store.setup();
  return store;
}
