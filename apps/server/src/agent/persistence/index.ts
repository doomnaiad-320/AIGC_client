import type { BaseCheckpointSaver, BaseStore } from "@langchain/langgraph-checkpoint";

import type { ServerEnv } from "../../config/env.js";
import { getDatabaseUrl } from "../../db/postgres.js";
import { createPostgresCheckpointer } from "./postgres-checkpointer.js";
import { createPostgresStore } from "./postgres-store.js";

export type AgentPersistence = {
  checkpointer: BaseCheckpointSaver;
  store: BaseStore;
};

export type AgentPersistenceService = {
  getPersistence(): Promise<AgentPersistence | null>;
};

export function createAgentPersistenceService(
  env: Pick<ServerEnv, "databaseUrl">,
  overrides?: {
    createCheckpointer?: typeof createPostgresCheckpointer;
    createStore?: typeof createPostgresStore;
  },
): AgentPersistenceService {
  let pendingPersistence: Promise<AgentPersistence> | null = null;

  return {
    async getPersistence() {
      const databaseUrl = getDatabaseUrl(env);
      if (!databaseUrl) {
        return null;
      }

      if (!pendingPersistence) {
        pendingPersistence = Promise.all([
          (overrides?.createCheckpointer ?? createPostgresCheckpointer)({
            connectionString: databaseUrl,
          }),
          (overrides?.createStore ?? createPostgresStore)({
            connectionString: databaseUrl,
          }),
        ])
          .then(([checkpointer, store]) => ({ checkpointer, store }))
          .catch((error) => {
            pendingPersistence = null;
            throw error;
          });
      }

      return pendingPersistence;
    },
  };
}
