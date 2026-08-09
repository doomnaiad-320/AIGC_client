import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  createLocalStorageClient,
  registerLocalStorageRoutes,
} from "./storage.js";

describe("local storage routes", () => {
  let storageRoot: string | undefined;

  afterEach(async () => {
    if (storageRoot) await rm(storageRoot, { force: true, recursive: true });
    storageRoot = undefined;
  });

  it("serves public assets with their media type", async () => {
    storageRoot = await mkdtemp(path.join(tmpdir(), "loomic-storage-"));
    const env = {
      appJwtSecret: "test-secret",
      serverPublicUrl: "http://localhost:3001",
      storageRoot,
    };
    const storage = createLocalStorageClient(env);
    const uploaded = await storage
      .from("project-assets")
      .upload("canvas-files/test/image.png", Buffer.from("png"));
    expect(uploaded.error).toBeNull();

    const app = Fastify();
    registerLocalStorageRoutes(app, env);

    try {
      const response = await app.inject({
        method: "GET",
        url: "/assets/project-assets/canvas-files/test/image.png",
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("image/png");
      expect(response.body).toBe("png");
    } finally {
      await app.close();
    }
  });
});
