#!/usr/bin/env node

import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import pg from "pg";

const scrypt = promisify(scryptCallback);
const PASSWORD = "opensourceloomic";
const TEST_ACCOUNTS = [
  { credits: 50, email: "free@test.loomic.com", plan: "free" },
  { credits: 1_200, email: "starter@test.loomic.com", plan: "starter" },
  {
    credits: 5_000,
    email: "pro@test.loomic.com",
    plan: "pro",
    platformAdmin: true,
  },
  { credits: 15_000, email: "ultra@test.loomic.com", plan: "ultra" },
];

const ADMIN_DEMO_SOURCE = "scripts/seed-test-accounts.mjs:admin-demo";
const ADMIN_DEMO_AGENT_THREAD_PREFIX = "admin-demo-agent-run";

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

async function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${Buffer.from(derived).toString("base64url")}`;
}

async function seedAccount(client, account) {
  const displayName = `${account.plan[0].toUpperCase()}${account.plan.slice(1)} Tester`;
  const passwordHash = await hashPassword(PASSWORD);

  await client.query("begin");
  try {
    await client.query(
      "select set_config('app.is_service_role', 'true', true)",
    );
    const userResult = await client.query(
      `
        insert into public.app_users (email, password_hash, user_metadata)
        values ($1, $2, jsonb_build_object('display_name', $3::text))
        on conflict (email) do update
        set password_hash = excluded.password_hash,
            user_metadata = excluded.user_metadata,
            updated_at = timezone('utc', now())
        returning id, email, user_metadata
      `,
      [account.email, passwordHash, displayName],
    );
    const user = userResult.rows[0];

    const workspaceResult = await client.query(
      "select public.bootstrap_viewer($1::uuid, $2::text, $3::jsonb) as workspace_id",
      [user.id, user.email, JSON.stringify(user.user_metadata)],
    );
    const workspaceId = workspaceResult.rows[0].workspace_id;

    await client.query(
      `
        insert into public.subscriptions (workspace_id, plan)
        values ($1, $2::public.subscription_plan)
        on conflict (workspace_id) do update
        set plan = excluded.plan,
            updated_at = now()
      `,
      [workspaceId, account.plan],
    );

    const balanceResult = await client.query(
      "select balance from public.credit_balances where workspace_id = $1 for update",
      [workspaceId],
    );
    const previousBalance = balanceResult.rows[0]?.balance ?? 0;

    await client.query(
      `
        insert into public.credit_balances (workspace_id, balance, version)
        values ($1, $2, 1)
        on conflict (workspace_id) do update
        set balance = excluded.balance,
            version = public.credit_balances.version + 1,
            updated_at = now()
      `,
      [workspaceId, account.credits],
    );

    const adjustment = account.credits - previousBalance;
    if (adjustment !== 0) {
      await client.query(
        `
          insert into public.credit_transactions (
            workspace_id,
            user_id,
            transaction_type,
            amount,
            balance_after,
            description,
            metadata
          ) values ($1, $2, 'admin_adjustment', $3, $4, $5, $6::jsonb)
        `,
        [
          workspaceId,
          user.id,
          adjustment,
          account.credits,
          "Local test account seed",
          JSON.stringify({ source: "scripts/seed-test-accounts.mjs" }),
        ],
      );
    }

    if (account.plan === "free") {
      await client.query(
        `
          insert into public.daily_credit_claims (
            workspace_id,
            claim_date,
            amount
          ) values ($1, current_date, 0)
          on conflict (workspace_id, claim_date) do nothing
        `,
        [workspaceId],
      );
    }

    await client.query("commit");
    return { userId: user.id, workspaceId };
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function grantPlatformAdmins(client, seededAccounts) {
  const adminAccounts = TEST_ACCOUNTS.filter(
    (account) => account.platformAdmin,
  );
  for (const account of adminAccounts) {
    const seeded = seededAccounts.get(account.email);
    if (!seeded) continue;
    await client.query(
      `
        insert into public.platform_admins (user_id, note)
        values ($1, $2)
        on conflict (user_id) do update
        set note = excluded.note
      `,
      [seeded.userId, "Local platform administrator test account"],
    );
    console.log(`[ready] ${account.email} platform_admin=true`);
  }
}

async function ensureAdminDemoCanvas(client, account, slugSuffix, projectName) {
  const projectResult = await client.query(
    `
      insert into public.projects (
        workspace_id,
        name,
        slug,
        description,
        created_by
      )
      values ($1, $2, $3, $4, $5)
      on conflict (workspace_id, slug) do update
      set name = excluded.name,
          description = excluded.description,
          updated_at = timezone('utc', now())
      returning id
    `,
    [
      account.workspaceId,
      projectName,
      `admin-demo-${slugSuffix}`,
      "Local admin console demo project.",
      account.userId,
    ],
  );

  const projectId = projectResult.rows[0]?.id;
  if (!projectId) {
    throw new Error("Unable to seed admin demo project.");
  }

  const canvasResult = await client.query(
    `
      with existing as (
        select id
        from public.canvases
        where project_id = $1
          and name = 'Admin Demo Canvas'
        limit 1
      ),
      inserted as (
        insert into public.canvases (
          project_id,
          name,
          is_primary,
          created_by
        )
        select $1, 'Admin Demo Canvas', true, $2
        where not exists (select 1 from existing)
        returning id
      )
      select id from inserted
      union all
      select id from existing
      limit 1
    `,
    [projectId, account.userId],
  );

  const canvasId = canvasResult.rows[0]?.id;
  if (!canvasId) {
    throw new Error("Unable to seed admin demo canvas.");
  }
  return canvasId;
}

async function seedAdminDemoData(client, seededAccounts) {
  const pro = seededAccounts.get("pro@test.loomic.com");
  const starter = seededAccounts.get("starter@test.loomic.com");
  const free = seededAccounts.get("free@test.loomic.com");
  if (!pro || !starter || !free) {
    throw new Error(
      "Admin demo data requires free, starter, and pro accounts.",
    );
  }

  await client.query("begin");
  try {
    await client.query(
      "select set_config('app.is_service_role', 'true', true)",
    );
    await client.query(
      "delete from public.background_jobs where payload->>'source' = $1",
      [ADMIN_DEMO_SOURCE],
    );
    await client.query(
      "delete from public.chat_sessions where thread_id like $1",
      [`${ADMIN_DEMO_AGENT_THREAD_PREFIX}:%`],
    );
    await client.query(
      "delete from public.admin_audit_events where metadata->>'source' = $1",
      [ADMIN_DEMO_SOURCE],
    );

    await client.query(
      `
        insert into public.background_jobs (
          workspace_id,
          queue_name,
          job_type,
          status,
          payload,
          result,
          error_code,
          error_message,
          attempt_count,
          max_attempts,
          created_by,
          created_at,
          started_at,
          completed_at,
          failed_at
        )
        values
          (
            $1,
            'image_generation_jobs',
            'image_generation',
            'succeeded',
            jsonb_build_object('source', $7::text, 'prompt', 'Admin demo successful image job'),
            jsonb_build_object('artifact', 'demo-image.png'),
            null,
            null,
            1,
            3,
            $2,
            now() - interval '50 minutes',
            now() - interval '49 minutes',
            now() - interval '47 minutes',
            null
          ),
          (
            $3,
            'video_generation_jobs',
            'video_generation',
            'running',
            jsonb_build_object('source', $7::text, 'prompt', 'Admin demo running video job'),
            null,
            null,
            null,
            1,
            3,
            $4,
            now() - interval '18 minutes',
            now() - interval '16 minutes',
            null,
            null
          ),
          (
            $5,
            'image_generation_jobs',
            'image_generation',
            'failed',
            jsonb_build_object('source', $7::text, 'prompt', 'Admin demo failed image job'),
            null,
            'provider_timeout',
            'Demo provider timed out while waiting for an image result.',
            3,
            3,
            $6,
            now() - interval '9 minutes',
            now() - interval '8 minutes',
            null,
            now() - interval '6 minutes'
          )
      `,
      [
        pro.workspaceId,
        pro.userId,
        starter.workspaceId,
        starter.userId,
        free.workspaceId,
        free.userId,
        ADMIN_DEMO_SOURCE,
      ],
    );

    const proCanvasId = await ensureAdminDemoCanvas(
      client,
      pro,
      "pro",
      "Admin Demo Pro Project",
    );
    const starterCanvasId = await ensureAdminDemoCanvas(
      client,
      starter,
      "starter",
      "Admin Demo Starter Project",
    );
    const freeCanvasId = await ensureAdminDemoCanvas(
      client,
      free,
      "free",
      "Admin Demo Free Project",
    );
    const completedThreadId = `${ADMIN_DEMO_AGENT_THREAD_PREFIX}:completed`;
    const runningThreadId = `${ADMIN_DEMO_AGENT_THREAD_PREFIX}:running`;
    const failedThreadId = `${ADMIN_DEMO_AGENT_THREAD_PREFIX}:failed`;
    const sessionsResult = await client.query(
      `
        insert into public.chat_sessions (
          canvas_id,
          title,
          created_by,
          created_at,
          updated_at,
          thread_id
        )
        values
          (
            $1,
            'Admin demo brand concept',
            $2,
            now() - interval '42 minutes',
            now() - interval '38 minutes',
            $7
          ),
          (
            $3,
            'Admin demo active agent run',
            $4,
            now() - interval '14 minutes',
            now() - interval '12 minutes',
            $8
          ),
          (
            $5,
            'Admin demo failed prompt',
            $6,
            now() - interval '7 minutes',
            now() - interval '6 minutes',
            $9
          )
        returning id, thread_id
      `,
      [
        proCanvasId,
        pro.userId,
        starterCanvasId,
        starter.userId,
        freeCanvasId,
        free.userId,
        completedThreadId,
        runningThreadId,
        failedThreadId,
      ],
    );
    const sessionIds = new Map(
      sessionsResult.rows.map((row) => [row.thread_id, row.id]),
    );
    const completedSessionId = sessionIds.get(completedThreadId);
    const runningSessionId = sessionIds.get(runningThreadId);
    const failedSessionId = sessionIds.get(failedThreadId);
    if (!completedSessionId || !runningSessionId || !failedSessionId) {
      throw new Error("Unable to seed admin demo agent sessions.");
    }

    await client.query(
      `
        insert into public.agent_runs (
          session_id,
          thread_id,
          status,
          model,
          created_at,
          completed_at,
          error_code,
          error_message
        )
        values
          (
            $1,
            $2,
            'completed',
            'gpt-4.1',
            now() - interval '41 minutes',
            now() - interval '38 minutes',
            null,
            null
          ),
          (
            $3,
            $4,
            'running',
            'gpt-4.1',
            now() - interval '12 minutes',
            null,
            null,
            null
          ),
          (
            $5,
            $6,
            'failed',
            'gpt-4.1',
            now() - interval '6 minutes',
            now() - interval '5 minutes',
            'provider_timeout',
            'Demo agent run timed out while waiting for the model provider.'
          )
      `,
      [
        completedSessionId,
        completedThreadId,
        runningSessionId,
        runningThreadId,
        failedSessionId,
        failedThreadId,
      ],
    );

    await client.query(
      `
        insert into public.admin_audit_events (
          actor_user_id,
          action,
          target_user_id,
          target_workspace_id,
          metadata
        )
        values
          (
            $1,
            'admin.demo.seeded',
            $2,
            $3,
            jsonb_build_object(
              'source', $4::text,
              'reason', 'Local admin console demo data seeded',
              'amount', 0
            )
          )
      `,
      [pro.userId, free.userId, free.workspaceId, ADMIN_DEMO_SOURCE],
    );

    await client.query("commit");
    console.log("[ready] admin console demo jobs, agent runs, and audit data");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function main() {
  await loadEnv();
  const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required. Run pnpm db:migrate first.");
  }

  const client = new pg.Client({
    application_name: "loomic-seed",
    connectionString,
  });
  await client.connect();
  try {
    console.log("Seeding local PostgreSQL test accounts...");
    const seededAccounts = new Map();
    for (const account of TEST_ACCOUNTS) {
      const result = await seedAccount(client, account);
      seededAccounts.set(account.email, result);
      console.log(
        `[ready] ${account.email} plan=${account.plan} credits=${account.credits} user=${result.userId}`,
      );
    }
    await grantPlatformAdmins(client, seededAccounts);
    await seedAdminDemoData(client, seededAccounts);
  } finally {
    await client.end();
  }

  console.log(`Password for all test accounts: ${PASSWORD}`);
}

main().catch((error) => {
  console.error(`Seed failed: ${error.message}`);
  process.exitCode = 1;
});
