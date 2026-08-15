import type { CanvasContent, CanvasDetail, Json } from "@loomic/shared";

import type { AuthenticatedUser, UserDbClient } from "../../auth/user.js";

export class CanvasServiceError extends Error {
  readonly statusCode: number;
  readonly code: "canvas_not_found" | "canvas_save_failed";

  constructor(
    code: "canvas_not_found" | "canvas_save_failed",
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type CanvasService = {
  getCanvas(user: AuthenticatedUser, canvasId: string): Promise<CanvasDetail>;
  saveCanvasContent(
    user: AuthenticatedUser,
    canvasId: string,
    content: CanvasContent,
  ): Promise<void>;
};

/**
 * Marker prefix for files that have been extracted to local asset storage.
 * Format: `oss://bucket/objectPath`
 */
const OSS_MARKER_PREFIX = "oss://";
const ASSET_MARKER_PREFIX = "asset://";
const CANVAS_FILES_BUCKET = "project-assets";
const SIGNED_URL_EXPIRY_SECONDS = 3600;

export function createCanvasService(options: {
  createUserClient: (accessToken: string) => UserDbClient;
}): CanvasService {
  return {
    async getCanvas(user, canvasId) {
      const client = options.createUserClient(user.accessToken);
      const { data, error } = await client
        .from("canvases")
        .select("id, name, project_id, content")
        .eq("id", canvasId)
        .single();

      if (error || !data) {
        throw new CanvasServiceError("canvas_not_found", "Canvas not found.", 404);
      }

      const content = (data.content as CanvasContent) ?? { elements: [], appState: {} };

      // Resolve OSS-stored files back to base64 dataURLs for the frontend
      const resolvedContent = await resolveStorageReferences(client, content);

      return {
        id: data.id,
        name: data.name,
        projectId: data.project_id,
        content: resolvedContent,
      };
    },

    async saveCanvasContent(user, canvasId, content) {
      const client = options.createUserClient(user.accessToken);

      // Extract base64 files to Storage, replacing dataURLs with oss:// markers
      const markerContent = normalizeElementStorageMarkers(content);
      const leanContent = await extractFilesToStorage(
        client,
        canvasId,
        markerContent,
      );

      const { error } = await client
        .from("canvases")
        .update({ content: leanContent as unknown as Json })
        .eq("id", canvasId);

      if (error) {
        throw new CanvasServiceError("canvas_save_failed", "Unable to save canvas.", 500);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// File extraction (save path): base64 dataURL -> local storage + oss:// marker
// ---------------------------------------------------------------------------

type CanvasFileRecord = Record<string, Record<string, unknown>>;
type CanvasElementRecord = Record<string, unknown>;

function normalizeElementStorageMarkers(content: CanvasContent): CanvasContent {
  const elements = (content.elements as CanvasElementRecord[]).map((element) => {
    if (element.type !== "embeddable") return element;
    const customData = (element.customData ?? {}) as Record<string, unknown>;
    const assetId = customData.assetId;
    if (typeof assetId === "string" && assetId.length > 0) {
      return { ...element, link: `${ASSET_MARKER_PREFIX}${assetId}` };
    }

    const bucket = customData.storageBucket;
    const objectPath = customData.storageObjectPath;
    if (
      typeof bucket === "string" &&
      typeof objectPath === "string" &&
      bucket.length > 0 &&
      objectPath.length > 0
    ) {
      return {
        ...element,
        link: `${OSS_MARKER_PREFIX}${bucket}/${objectPath}`,
      };
    }

    const legacyReference = parseLegacyProjectAssetUrl(element.link);
    if (!legacyReference) return element;
    return {
      ...element,
      link: `${OSS_MARKER_PREFIX}${legacyReference.bucket}/${legacyReference.objectPath}`,
      customData: {
        ...customData,
        storageBucket: legacyReference.bucket,
        storageObjectPath: legacyReference.objectPath,
      },
    };
  });

  return { ...content, elements } as CanvasContent;
}

async function extractFilesToStorage(
  client: UserDbClient,
  canvasId: string,
  content: CanvasContent,
): Promise<CanvasContent> {
  const files = (content as { files?: CanvasFileRecord }).files;
  if (!files || Object.keys(files).length === 0) {
    return content;
  }

  const updatedFiles: CanvasFileRecord = {};

  await Promise.all(
    Object.entries(files).map(async ([fileId, fileData]) => {
      const dataURL = fileData.dataURL as string | undefined;

      // Already extracted to storage — keep marker
      if (dataURL?.startsWith(OSS_MARKER_PREFIX)) {
        updatedFiles[fileId] = fileData;
        return;
      }

      // Only process base64 data URLs
      if (!dataURL?.startsWith("data:")) {
        updatedFiles[fileId] = fileData;
        return;
      }

      try {
        const { buffer, mimeType } = parseDataURL(dataURL);
        const ext = mimeToExt(mimeType);
        const objectPath = `canvas-files/${canvasId}/${fileId}.${ext}`;

        // Upsert: the same file ID may be re-saved
        const { error: uploadError } = await client.storage
          .from(CANVAS_FILES_BUCKET)
          .upload(objectPath, buffer, { contentType: mimeType, upsert: true });

        if (uploadError) {
          // On upload failure, keep the original base64 (graceful degradation)
          updatedFiles[fileId] = fileData;
          return;
        }

        updatedFiles[fileId] = {
          ...fileData,
          dataURL: `${OSS_MARKER_PREFIX}${CANVAS_FILES_BUCKET}/${objectPath}`,
        };
      } catch {
        // Unparseable dataURL — keep as-is
        updatedFiles[fileId] = fileData;
      }
    }),
  );

  return {
    ...content,
    files: updatedFiles,
  } as CanvasContent;
}

// ---------------------------------------------------------------------------
// File resolution (load path): oss:// marker → base64 dataURL
// ---------------------------------------------------------------------------

async function resolveFilesFromStorage(
  client: UserDbClient,
  content: CanvasContent,
): Promise<CanvasContent> {
  const files = (content as { files?: CanvasFileRecord }).files;
  if (!files || Object.keys(files).length === 0) {
    return content;
  }

  // Separate OSS files from inline files
  const updatedFiles: CanvasFileRecord = {};
  const ossEntries: Array<{ fileId: string; fileData: Record<string, unknown>; bucket: string; objectPath: string }> = [];

  for (const [fileId, fileData] of Object.entries(files)) {
    const dataURL = fileData.dataURL as string | undefined;
    if (!dataURL?.startsWith(OSS_MARKER_PREFIX)) {
      updatedFiles[fileId] = fileData;
      continue;
    }

    const ref = dataURL.slice(OSS_MARKER_PREFIX.length);
    const slashIdx = ref.indexOf("/");
    if (slashIdx === -1) continue;
    ossEntries.push({
      fileId,
      fileData,
      bucket: ref.slice(0, slashIdx),
      objectPath: ref.slice(slashIdx + 1),
    });
  }

  if (ossEntries.length === 0) {
    return content;
  }

  // Resolve short-lived signed URLs instead of exposing tenant asset paths.
  // Group by bucket (normally all in one bucket)
  const byBucket = new Map<string, typeof ossEntries>();
  for (const entry of ossEntries) {
    const list = byBucket.get(entry.bucket) ?? [];
    list.push(entry);
    byBucket.set(entry.bucket, list);
  }

  for (const [bucket, entries] of byBucket) {
    for (const entry of entries) {
      const { data, error } = await client.storage
        .from(bucket)
        .createSignedUrl(entry.objectPath, SIGNED_URL_EXPIRY_SECONDS);
      if (error || !data?.signedUrl) continue;
      updatedFiles[entry.fileId] = {
        ...entry.fileData,
        dataURL: undefined,
        storageUrl: data.signedUrl,
      };
    }
  }

  return {
    ...content,
    files: updatedFiles,
  } as CanvasContent;
}

async function resolveStorageReferences(
  client: UserDbClient,
  content: CanvasContent,
): Promise<CanvasContent> {
  const withFiles = await resolveFilesFromStorage(client, content);
  const elements = await Promise.all(
    (withFiles.elements as CanvasElementRecord[]).map(async (element) => {
      if (element.type !== "embeddable") return element;
      const link = element.link;
      if (typeof link !== "string") return element;

      let bucket: string | null = null;
      let objectPath: string | null = null;
      let assetId: string | null = null;

      if (link.startsWith(ASSET_MARKER_PREFIX)) {
        assetId = link.slice(ASSET_MARKER_PREFIX.length);
        const { data: asset } = await client
          .from("asset_objects")
          .select("bucket, object_path")
          .eq("id", assetId)
          .maybeSingle();
        if (asset) {
          bucket = asset.bucket;
          objectPath = asset.object_path;
        }
      } else if (link.startsWith(OSS_MARKER_PREFIX)) {
        const reference = parseOssMarker(link);
        bucket = reference?.bucket ?? null;
        objectPath = reference?.objectPath ?? null;
      } else {
        const reference = parseLegacyProjectAssetUrl(link);
        bucket = reference?.bucket ?? null;
        objectPath = reference?.objectPath ?? null;
      }

      if (!bucket || !objectPath) return element;
      const { data, error } = await client.storage
        .from(bucket)
        .createSignedUrl(objectPath, SIGNED_URL_EXPIRY_SECONDS);
      if (error || !data?.signedUrl) return element;

      return {
        ...element,
        link: data.signedUrl,
        customData: {
          ...((element.customData ?? {}) as Record<string, unknown>),
          ...(assetId ? { assetId } : {}),
          storageBucket: bucket,
          storageObjectPath: objectPath,
        },
      };
    }),
  );

  return { ...withFiles, elements } as CanvasContent;
}

function parseOssMarker(
  link: string,
): { bucket: string; objectPath: string } | null {
  const reference = link.slice(OSS_MARKER_PREFIX.length);
  const slashIndex = reference.indexOf("/");
  if (slashIndex <= 0) return null;
  return {
    bucket: reference.slice(0, slashIndex),
    objectPath: reference.slice(slashIndex + 1),
  };
}

function parseLegacyProjectAssetUrl(
  value: unknown,
): { bucket: "project-assets"; objectPath: string } | null {
  if (typeof value !== "string" || value.startsWith(ASSET_MARKER_PREFIX)) {
    return null;
  }
  try {
    const url = new URL(value, "http://loomic.local");
    const prefix = "/assets/project-assets/";
    if (!url.pathname.startsWith(prefix)) return null;
    const encodedPath = url.pathname.slice(prefix.length);
    const objectPath = encodedPath
      .split("/")
      .map((part) => decodeURIComponent(part))
      .join("/");
    return objectPath ? { bucket: "project-assets", objectPath } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function parseDataURL(dataURL: string): { buffer: Buffer; mimeType: string } {
  // Format: data:[<mediatype>][;base64],<data>
  const match = dataURL.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) {
    throw new Error("Invalid data URL");
  }
  return {
    mimeType: match[1]!,
    buffer: Buffer.from(match[2]!, "base64"),
  };
}

function mimeToExt(mimeType: string): string {
  switch (mimeType) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
    case "image/svg+xml": return "svg";
    case "image/gif": return "gif";
    default: return "bin";
  }
}
