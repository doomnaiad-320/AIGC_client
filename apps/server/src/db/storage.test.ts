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

  it("serves only the public home-seed prefix without a signature", async () => {
    storageRoot = await mkdtemp(path.join(tmpdir(), "loomic-storage-"));
    const env = {
      appJwtSecret: "test-secret",
      serverPublicUrl: "http://localhost:3001",
      storageRoot,
    };
    const storage = createLocalStorageClient(env);
    const uploaded = await storage
      .from("project-assets")
      .upload("home-seeds/test/image.png", Buffer.from("png"));
    expect(uploaded.error).toBeNull();

    const app = Fastify();
    registerLocalStorageRoutes(app, env);

    try {
      const response = await app.inject({
        method: "GET",
        url: "/assets/project-assets/home-seeds/test/image.png",
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("image/png");
      expect(response.body).toBe("png");
    } finally {
      await app.close();
    }
  });

  it("requires a valid signed URL for tenant project assets", async () => {
    storageRoot = await mkdtemp(path.join(tmpdir(), "loomic-storage-"));
    const env = {
      appJwtSecret: "test-secret",
      serverPublicUrl: "http://localhost:3001",
      storageRoot,
    };
    const storage = createLocalStorageClient(env);
    const objectPath = "workspace/generated/image.png";
    await storage
      .from("project-assets")
      .upload(objectPath, Buffer.from("private-png"));

    const app = Fastify();
    registerLocalStorageRoutes(app, env);

    try {
      const unsigned = await app.inject({
        method: "GET",
        url: `/assets/project-assets/${objectPath}`,
      });
      expect(unsigned.statusCode).toBe(403);

      const traversal = await app.inject({
        method: "GET",
        url: "/assets/project-assets/home-seeds/%2e%2e/workspace/generated/image.png",
      });
      expect(traversal.statusCode).not.toBe(200);

      const { data } = await storage
        .from("project-assets")
        .createSignedUrl(objectPath, 3600);
      const signedUrl = new URL(data!.signedUrl);
      const signed = await app.inject({
        method: "GET",
        url: `${signedUrl.pathname}${signedUrl.search}`,
      });
      expect(signed.statusCode).toBe(200);
      expect(signed.body).toBe("private-png");

      const tampered = await app.inject({
        method: "GET",
        url: `${signedUrl.pathname}?token=invalid`,
      });
      expect(tampered.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
