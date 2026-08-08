import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FastifyInstance } from "fastify";

import type { ServerEnv } from "../config/env.js";

export type StorageError = {
  message: string;
};

export type StorageResult<T> = {
  data: T | null;
  error: StorageError | null;
};

type UploadOptions = {
  contentType?: string;
  upsert?: boolean;
};

export type LocalStorageBucket = {
  upload(
    objectPath: string,
    buffer: Buffer,
    options?: UploadOptions,
  ): Promise<StorageResult<{ path: string }>>;
  remove(objectPaths: string[]): Promise<StorageResult<{ path: string }[]>>;
  download(objectPath: string): Promise<StorageResult<Blob>>;
  getPublicUrl(objectPath: string): { data: { publicUrl: string } };
  createSignedUrl(
    objectPath: string,
    expiresInSeconds: number,
  ): Promise<StorageResult<{ signedUrl: string }>>;
  createSignedUrls(
    objectPaths: string[],
    expiresInSeconds: number,
  ): Promise<StorageResult<Array<{ error: StorageError | null; path: string; signedUrl: string | null }>>>;
  copy(sourcePath: string, targetPath: string): Promise<StorageResult<{ path: string }>>;
};

export type LocalStorageClient = {
  from(bucket: string): LocalStorageBucket;
};

const DEFAULT_STORAGE_ROOT = ".loomic-storage";
const PUBLIC_BUCKETS = new Set(["project-assets", "canvas-screenshots"]);

export function createLocalStorageClient(
  env: Pick<ServerEnv, "appJwtSecret" | "serverPublicUrl" | "storageRoot">,
): LocalStorageClient {
  const root = path.resolve(env.storageRoot ?? DEFAULT_STORAGE_ROOT);
  const publicBaseUrl =
    env.serverPublicUrl?.replace(/\/+$/, "") ?? "http://localhost:3001";

  return {
    from(bucket) {
      return createBucketClient({
        bucket,
        publicBaseUrl,
        root,
        signingSecret: env.appJwtSecret ?? "loomic-local-dev-secret-change-me",
      });
    },
  };
}

export function registerLocalStorageRoutes(
  app: FastifyInstance,
  env: Pick<ServerEnv, "appJwtSecret" | "storageRoot">,
) {
  const root = path.resolve(env.storageRoot ?? DEFAULT_STORAGE_ROOT);
  const signingSecret = env.appJwtSecret ?? "loomic-local-dev-secret-change-me";

  app.get("/assets/:bucket/*", async (request, reply) => {
    const params = request.params as { bucket: string; "*": string };
    const bucket = params.bucket;
    const objectPath = params["*"];

    if (!PUBLIC_BUCKETS.has(bucket)) {
      const token = (request.query as { token?: string }).token;
      if (!token || !isValidSignature(signingSecret, bucket, objectPath, token)) {
        return reply.code(403).send({ message: "Asset URL expired or invalid." });
      }
    }

    const filePath = resolveObjectPath(root, bucket, objectPath);
    if (!filePath) {
      return reply.code(400).send({ message: "Invalid asset path." });
    }

    try {
      await stat(filePath);
    } catch {
      return reply.code(404).send({ message: "Asset not found." });
    }

    return reply.send(createReadStream(filePath));
  });
}

function createBucketClient(options: {
  bucket: string;
  publicBaseUrl: string;
  root: string;
  signingSecret: string;
}): LocalStorageBucket {
  return {
    async upload(objectPath, buffer, uploadOptions = {}) {
      const filePath = resolveObjectPath(options.root, options.bucket, objectPath);
      if (!filePath) {
        return { data: null, error: { message: "Invalid object path." } };
      }

      try {
        if (!uploadOptions.upsert) {
          try {
            await stat(filePath);
            return { data: null, error: { message: "Object already exists." } };
          } catch {
            // Missing file is the expected path for a non-upsert upload.
          }
        }

        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, buffer);
        return { data: { path: objectPath }, error: null };
      } catch (error) {
        return { data: null, error: { message: toErrorMessage(error) } };
      }
    },

    async remove(objectPaths) {
      const removed: { path: string }[] = [];
      for (const objectPath of objectPaths) {
        const filePath = resolveObjectPath(options.root, options.bucket, objectPath);
        if (!filePath) continue;
        await rm(filePath, { force: true });
        removed.push({ path: objectPath });
      }
      return { data: removed, error: null };
    },

    async download(objectPath) {
      const filePath = resolveObjectPath(options.root, options.bucket, objectPath);
      if (!filePath) {
        return { data: null, error: { message: "Invalid object path." } };
      }
      try {
        const fs = await import("node:fs/promises");
        const buffer = await fs.readFile(filePath);
        return { data: new Blob([buffer]), error: null };
      } catch (error) {
        return { data: null, error: { message: toErrorMessage(error) } };
      }
    },

    getPublicUrl(objectPath) {
      const encodedPath = objectPath
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/");
      return {
        data: {
          publicUrl: `${options.publicBaseUrl}/assets/${encodeURIComponent(
            options.bucket,
          )}/${encodedPath}`,
        },
      };
    },

    async createSignedUrl(objectPath, expiresInSeconds) {
      const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
      const signature = signAssetUrl(
        options.signingSecret,
        options.bucket,
        objectPath,
        expiresAt,
      );
      const publicUrl = this.getPublicUrl(objectPath).data.publicUrl;
      return {
        data: {
          signedUrl: `${publicUrl}?token=${encodeURIComponent(
            `${expiresAt}.${signature}`,
          )}`,
        },
       error: null,
     };
   },

    async createSignedUrls(objectPaths, expiresInSeconds) {
      const rows: Array<{ error: StorageError | null; path: string; signedUrl: string | null }> = [];
      for (const objectPath of objectPaths) {
        const result = await this.createSignedUrl(objectPath, expiresInSeconds);
        rows.push({
          error: result.error,
          path: objectPath,
          signedUrl: result.data?.signedUrl ?? null,
        });
      }
      return { data: rows, error: null };
    },

    async copy(sourcePath, targetPath) {
      const sourceFilePath = resolveObjectPath(options.root, options.bucket, sourcePath);
      if (!sourceFilePath) {
        return { data: null, error: { message: "Invalid source path." } };
      }
      try {
        const buffer = await readFile(sourceFilePath);
        const uploaded = await this.upload(targetPath, buffer, { upsert: false });
        if (uploaded.error) return uploaded;
        return { data: { path: targetPath }, error: null };
      } catch (error) {
        return { data: null, error: { message: toErrorMessage(error) } };
      }
    },
  };
}

function resolveObjectPath(root: string, bucket: string, objectPath: string) {
  const safeBucket = bucket.trim();
  if (!safeBucket || safeBucket.includes("/") || safeBucket.includes("..")) {
    return null;
  }

  const normalized = path.normalize(objectPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const fullPath = path.resolve(root, safeBucket, normalized);
  const bucketRoot = path.resolve(root, safeBucket);
  if (!fullPath.startsWith(`${bucketRoot}${path.sep}`) && fullPath !== bucketRoot) {
    return null;
  }
  return fullPath;
}

function signAssetUrl(
  secret: string,
  bucket: string,
  objectPath: string,
  expiresAt: number,
) {
  return createHmac("sha256", secret)
    .update(`${bucket}:${objectPath}:${expiresAt}`)
    .digest("base64url");
}

function isValidSignature(
  secret: string,
  bucket: string,
  objectPath: string,
  token: string,
) {
  const [expiresAtRaw, signature] = token.split(".", 2);
  const expiresAt = Number.parseInt(expiresAtRaw ?? "", 10);
  if (!Number.isInteger(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) {
    return false;
  }
  const expected = signAssetUrl(secret, bucket, objectPath, expiresAt);
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(signature ?? "");
  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
