#!/usr/bin/env node

const baseUrl = (process.env.LOOMIC_SMOKE_BASE_URL ?? "http://127.0.0.1:3001").replace(
  /\/$/,
  "",
);
const startedAt = Date.now();
const email = `smoke-${startedAt}@test.loomic.local`;
const password = "local-smoke-password";

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...options.headers,
    },
  });
  const responseText = await response.text();
  let body = null;

  try {
    body = responseText ? JSON.parse(responseText) : null;
  } catch {
    body = responseText;
  }

  if (!response.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${path} returned ${response.status}: ${JSON.stringify(body)}`,
    );
  }

  return { body, status: response.status };
}

async function main() {
  const health = await request("/api/health");
  const register = await request("/api/auth/register", {
    body: JSON.stringify({ displayName: "Local Smoke", email, password }),
    method: "POST",
  });
  const accessToken = register.body?.session?.access_token;
  if (!accessToken) {
    throw new Error("Registration response did not include an access token.");
  }

  const authHeaders = { authorization: `Bearer ${accessToken}` };
  const viewer = await request("/api/viewer", { headers: authHeaders });
  const created = await request("/api/projects", {
    body: JSON.stringify({
      description: "Local PostgreSQL end-to-end check",
      name: "PostgreSQL Smoke Project",
    }),
    headers: authHeaders,
    method: "POST",
  });
  const project = created.body?.project;
  if (!project?.id || !project.primaryCanvas?.id) {
    throw new Error("Project creation response was incomplete.");
  }

  const listed = await request("/api/projects", { headers: authHeaders });
  if (!listed.body?.projects?.some((item) => item.id === project.id)) {
    throw new Error("The new project was not returned by the project list API.");
  }

  const createdAt = Date.parse(project.createdAt);
  if (!Number.isFinite(createdAt) || Math.abs(createdAt - startedAt) > 60_000) {
    throw new Error("The project timestamp is invalid or affected by session timezone drift.");
  }

  const canvasPath = `/api/canvases/${project.primaryCanvas.id}`;
  await request(canvasPath, { headers: authHeaders });
  const fileId = "smoke-file";
  await request(canvasPath, {
    body: JSON.stringify({
      content: {
        appState: { name: "PostgreSQL smoke canvas" },
        elements: [
          {
            height: 120,
            id: "smoke-rect",
            type: "rectangle",
            width: 240,
            x: 32,
            y: 48,
          },
        ],
        files: {
          [fileId]: {
            dataURL:
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            id: fileId,
            mimeType: "image/png",
          },
        },
      },
    }),
    headers: authHeaders,
    method: "PUT",
  });

  const reloaded = await request(canvasPath, { headers: authHeaders });
  const content = reloaded.body?.canvas?.content;
  if (content?.elements?.[0]?.id !== "smoke-rect") {
    throw new Error("Saved canvas elements were not persisted.");
  }

  const storageUrl = content?.files?.[fileId]?.storageUrl;
  if (!storageUrl) {
    throw new Error("The canvas file was not extracted to local asset storage.");
  }
  const storedAsset = await fetch(storageUrl);
  if (!storedAsset.ok || storedAsset.headers.get("content-type") !== "image/png") {
    throw new Error("The locally stored canvas asset could not be loaded.");
  }

  console.log(
    JSON.stringify(
      {
        canvasPersistence: "ok",
        health: health.status,
        localAssetStorage: "ok",
        plan: viewer.body?.credits?.plan,
        projectCreate: created.status,
        projectList: listed.status,
        register: register.status,
        timestampDriftSeconds: Math.round((createdAt - startedAt) / 1000),
        viewer: viewer.status,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(`Local PostgreSQL smoke test failed: ${error.message}`);
  process.exitCode = 1;
});
