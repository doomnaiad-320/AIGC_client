#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";

async function loadEnv() {
  for (const envFile of [".env.local", ".env"]) {
    try {
      const content = await readFile(envFile, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const separator = trimmed.indexOf("=");
        if (separator < 1) continue;
        const key = trimmed.slice(0, separator).trim();
        let value = trimmed.slice(separator + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        process.env[key] ??= value;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function withRole(client, role, userId, operation) {
  await client.query("begin");
  try {
    await client.query(`set local role ${role}`);
    await client.query("select set_config($1, $2, true)", [
      "app.is_service_role",
      role === "service_role" ? "true" : "false",
    ]);
    await client.query("select set_config($1, $2, true)", [
      "app.user_id",
      userId ?? "",
    ]);
    const result = await operation();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

async function main() {
  await loadEnv();
  const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required.");

  const admin = new pg.Client({ connectionString });
  const userA = new pg.Client({ connectionString });
  const userB = new pg.Client({ connectionString });
  const suffix = Date.now();
  const userAId = randomUUID();
  const userBId = randomUUID();
  let workspaceAId;
  let workspaceBId;
  let projectAId;
  let projectBId;
  let canvasBId;
  let assetBId;
  let jobBId;

  await Promise.all([admin.connect(), userA.connect(), userB.connect()]);
  try {
    await withRole(admin, "service_role", null, async () => {
      await admin.query(
        `insert into public.app_users (id, email, password_hash)
         values ($1, $2, $3), ($4, $5, $6)`,
        [
          userAId,
          `rls-a-${suffix}@test.loomic.local`,
          "test-password-hash",
          userBId,
          `rls-b-${suffix}@test.loomic.local`,
          "test-password-hash",
        ],
      );
      const workspaces = await admin.query(
        `select id, owner_user_id from public.workspaces
         where owner_user_id in ($1, $2)`,
        [userAId, userBId],
      );
      workspaceAId = workspaces.rows.find(
        (row) => row.owner_user_id === userAId,
      )?.id;
      workspaceBId = workspaces.rows.find(
        (row) => row.owner_user_id === userBId,
      )?.id;
      if (!workspaceAId || !workspaceBId) {
        throw new Error("Test users did not receive personal workspaces.");
      }

      projectAId = randomUUID();
      projectBId = randomUUID();
      canvasBId = randomUUID();
      assetBId = randomUUID();
      jobBId = randomUUID();
      await admin.query(
        `insert into public.projects (id, workspace_id, name, slug, created_by)
         values ($1, $2, 'RLS A', $3, $4), ($5, $6, 'RLS B', $7, $8)`,
        [
          projectAId,
          workspaceAId,
          `rls-a-${suffix}`,
          userAId,
          projectBId,
          workspaceBId,
          `rls-b-${suffix}`,
          userBId,
        ],
      );
      await admin.query(
        `insert into public.canvases (id, project_id, name, is_primary, created_by)
         values ($1, $2, 'RLS B Canvas', true, $3)`,
        [canvasBId, projectBId, userBId],
      );
      await admin.query(
        `insert into public.asset_objects
           (id, workspace_id, project_id, bucket, object_path, created_by)
         values ($1, $2, $3, 'project-assets', $4, $5)`,
        [assetBId, workspaceBId, projectBId, `rls/${suffix}.png`, userBId],
      );
      await admin.query(
        `insert into public.background_jobs
           (id, workspace_id, project_id, canvas_id, queue_name, job_type, payload, created_by)
         values ($1, $2, $3, $4, 'image_generation_jobs', 'image_generation', '{}'::jsonb, $5)`,
        [jobBId, workspaceBId, projectBId, canvasBId, userBId],
      );
    });

    await withRole(userA, "authenticated", userAId, async () => {
      const ownProject = await userA.query(
        "select id from public.projects where id = $1",
        [projectAId],
      );
      if (ownProject.rowCount !== 1)
        throw new Error("User A cannot read own project.");

      for (const [table, id] of [
        ["projects", projectBId],
        ["canvases", canvasBId],
        ["asset_objects", assetBId],
        ["background_jobs", jobBId],
      ]) {
        const hidden = await userA.query(
          `select id from public.${table} where id = $1`,
          [id],
        );
        if (hidden.rowCount !== 0) {
          throw new Error(`User A can read User B's ${table} row.`);
        }
      }

      const projectUpdate = await userA.query(
        "update public.projects set name = 'forbidden' where id = $1 returning id",
        [projectBId],
      );
      if (projectUpdate.rowCount !== 0)
        throw new Error("User A can update User B's project.");

      const jobCancel = await userA.query(
        `update public.background_jobs
         set status = 'canceled', canceled_at = now()
         where id = $1 returning id`,
        [jobBId],
      );
      if (jobCancel.rowCount !== 0)
        throw new Error("User A can cancel User B's job.");
    });

    await withRole(userB, "authenticated", userBId, async () => {
      const visible = await userB.query(
        `select
           (select count(*) from public.projects where id = $1) as projects,
           (select count(*) from public.canvases where id = $2) as canvases,
           (select count(*) from public.asset_objects where id = $3) as assets,
           (select count(*) from public.background_jobs where id = $4) as jobs`,
        [projectBId, canvasBId, assetBId, jobBId],
      );
      const row = visible.rows[0];
      if (
        [row.projects, row.canvases, row.assets, row.jobs].some(
          (count) => Number(count) !== 1,
        )
      ) {
        throw new Error("User B cannot read all owned tenant rows.");
      }
    });

    console.log(
      JSON.stringify(
        {
          crossTenantAssetRead: "blocked",
          crossTenantJobCancel: "blocked",
          crossTenantJobRead: "blocked",
          crossTenantProjectRead: "blocked",
          crossTenantProjectUpdate: "blocked",
          ownTenantRead: "ok",
          runtimeRoles: "ok",
        },
        null,
        2,
      ),
    );
  } finally {
    if (workspaceAId && workspaceBId) {
      await withRole(admin, "service_role", null, async () => {
        await admin.query(
          "delete from public.background_jobs where workspace_id in ($1, $2)",
          [workspaceAId, workspaceBId],
        );
        await admin.query("delete from public.workspaces where id in ($1, $2)", [
          workspaceAId,
          workspaceBId,
        ]);
        await admin.query("delete from public.app_users where id in ($1, $2)", [
          userAId,
          userBId,
        ]);
      }).catch((error) => {
        console.error(`RLS test cleanup failed: ${error.message}`);
      });
    }
    await Promise.all([admin.end(), userA.end(), userB.end()]);
  }
}

main().catch((error) => {
  console.error(`Runtime RLS isolation test failed: ${error.message}`);
  process.exitCode = 1;
});
