import { describe, expect, it } from "vitest";

import { loadServerEnv } from "./env.js";

describe("loadServerEnv PostgreSQL configuration", () => {
  it("prefers DATABASE_URL over POSTGRES_URL", () => {
    const env = loadServerEnv(
      {},
      {
        DATABASE_URL: "postgresql://localhost/primary",
        POSTGRES_URL: "postgresql://localhost/postgres-url",
      } as NodeJS.ProcessEnv,
    );

    expect(env.databaseUrl).toBe("postgresql://localhost/primary");
  });

  it("accepts POSTGRES_URL when DATABASE_URL is absent", () => {
    const env = loadServerEnv(
      {},
      {
        POSTGRES_URL: "postgresql://localhost/postgres-url",
      } as NodeJS.ProcessEnv,
    );

    expect(env.databaseUrl).toBe("postgresql://localhost/postgres-url");
  });

  it("loads app JWT and local storage settings", () => {
    const env = loadServerEnv(
      {},
      {
        APP_JWT_SECRET: "dev-secret",
        LOOMIC_SERVER_PUBLIC_URL: "http://localhost:3001",
        LOOMIC_STORAGE_ROOT: ".loomic-storage",
      } as NodeJS.ProcessEnv,
    );

    expect(env.appJwtSecret).toBe("dev-secret");
    expect(env.serverPublicUrl).toBe("http://localhost:3001");
    expect(env.storageRoot).toBe(".loomic-storage");
  });
});
