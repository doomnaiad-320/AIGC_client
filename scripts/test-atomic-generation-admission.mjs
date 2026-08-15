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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  await loadEnv();
  const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required.");

  const admin = new pg.Client({ connectionString });
  const user = new pg.Client({ connectionString });
  const userId = randomUUID();
  const email = `atomic-admission-${userId}@test.loomic.local`;
  let workspaceId;
  let firstJobId;
  let firstMessageId;

  await Promise.all([admin.connect(), user.connect()]);
  try {
    await withRole(admin, "service_role", null, async () => {
      await admin.query(
        `insert into public.app_users (id, email, password_hash)
         values ($1, $2, 'atomic-admission-test')`,
        [userId, email],
      );
      workspaceId = (
        await admin.query(
          `select id from public.workspaces
           where owner_user_id = $1 and type = 'personal'
           order by created_at limit 1`,
          [userId],
        )
      ).rows[0]?.id;
      assert(workspaceId, "Test user did not receive a personal workspace.");
    });

    let insufficientRejected = false;
    try {
      await withRole(user, "authenticated", userId, async () => {
        await user.query(
          `select * from public.create_and_enqueue_generation_job(
             $1, null, null, null, null,
             'image_generation'::public.background_job_type,
             $2::jsonb, $3, 100, 'insufficient atomic admission test'
           )`,
          [workspaceId, JSON.stringify({ prompt: "insufficient" }), userId],
        );
      });
    } catch (error) {
      insufficientRejected = error?.message?.includes("INSUFFICIENT_CREDITS");
    }
    assert(insufficientRejected, "Insufficient credits did not reject admission.");

    const rejectedSideEffects = await withRole(
      admin,
      "service_role",
      null,
      async () => {
        const result = await admin.query(
          `select
             (select balance from public.credit_balances where workspace_id = $1) as balance,
             (select count(*)::int from public.background_jobs where workspace_id = $1) as jobs,
             (select count(*)::int from public.credit_ledger where workspace_id = $1) as ledger`,
          [workspaceId],
        );
        return result.rows[0];
      },
    );
    assert(Number(rejectedSideEffects.balance) === 0, "Rejected admission changed the balance.");
    assert(rejectedSideEffects.jobs === 0, "Rejected admission created a job.");
    assert(rejectedSideEffects.ledger === 0, "Rejected admission created a ledger entry.");

    const firstJob = await withRole(user, "authenticated", userId, async () => {
      const result = await user.query(
        `select * from public.create_and_enqueue_generation_job(
           $1, null, null, null, null,
           'image_generation'::public.background_job_type,
           $2::jsonb, $3, 10, 'atomic admission test'
         )`,
        [workspaceId, JSON.stringify({ prompt: "atomic admission" }), userId],
      );
      return result.rows[0];
    });
    firstJobId = firstJob.id;
    assert(
      firstJob.status === "queued",
      "Atomic admission did not queue the job.",
    );
    assert(
      firstJob.credits_cost === 10,
      "Job did not persist the credit cost.",
    );
    assert(
      firstJob.credits_transaction_id,
      "Job did not persist the credit transaction.",
    );

    let concurrencyRejected = false;
    try {
      await withRole(user, "authenticated", userId, async () => {
        await user.query(
          `select * from public.create_and_enqueue_generation_job(
             $1, null, null, null, null,
             'image_generation'::public.background_job_type,
             $2::jsonb, $3, 10, 'atomic admission test 2'
           )`,
          [workspaceId, JSON.stringify({ prompt: "should reject" }), userId],
        );
      });
    } catch (error) {
      concurrencyRejected = error?.message?.includes(
        "GENERATION_CONCURRENCY_LIMIT",
      );
    }
    assert(
      concurrencyRejected,
      "The second active job was not rejected by the concurrency limit.",
    );

    const observed = await withRole(admin, "service_role", null, async () => {
      const balance = await admin.query(
        "select balance from public.credit_balances where workspace_id = $1",
        [workspaceId],
      );
      const jobs = await admin.query(
        `select count(*)::int as count, max(credits_cost)::int as credits_cost
         from public.background_jobs where workspace_id = $1`,
        [workspaceId],
      );
      const ledger = await admin.query(
        `select count(*)::int as count
         from public.credit_ledger
         where workspace_id = $1 and entry_type = 'deduct'`,
        [workspaceId],
      );
      const messages = await admin.query(
        `select msg_id from pgmq.local_messages
         where message->>'job_id' = $1 and deleted_at is null and archived_at is null`,
        [firstJobId],
      );
      firstMessageId = messages.rows[0]?.msg_id;
      return {
        balance: Number(balance.rows[0]?.balance),
        jobs: jobs.rows[0],
        ledger: ledger.rows[0],
        messageCount: messages.rowCount,
      };
    });

    assert(
      observed.balance === 40,
      `Expected one 10-credit deduction, got ${observed.balance}.`,
    );
    assert(
      observed.jobs.count === 1,
      "Rejected admission created an extra job.",
    );
    assert(
      observed.ledger.count === 1,
      "Rejected admission created an extra deduction.",
    );
    assert(
      observed.messageCount === 1,
      "Atomic admission did not enqueue exactly one message.",
    );

    console.log(
      JSON.stringify(
        {
          creditDeductionAndJobInsert: "atomic",
          concurrencyRejection: "atomic",
          insufficientCreditRejection: "atomic",
          queuedMessages: observed.messageCount,
          remainingBalance: observed.balance,
        },
        null,
        2,
      ),
    );
  } finally {
    if (workspaceId) {
      await withRole(admin, "service_role", null, async () => {
        if (firstMessageId != null) {
          await admin.query("select pgmq.delete($1, $2)", [
            "image_generation_jobs",
            firstMessageId,
          ]);
        }
        await admin.query(
          `delete from public.credit_ledger_allocations
           where ledger_id in (
             select id from public.credit_ledger where workspace_id = $1
           )`,
          [workspaceId],
        );
        await admin.query(
          "delete from public.credit_ledger where workspace_id = $1",
          [workspaceId],
        );
        await admin.query(
          "delete from public.background_jobs where workspace_id = $1",
          [workspaceId],
        );
        await admin.query("delete from public.workspaces where id = $1", [
          workspaceId,
        ]);
        await admin.query("delete from public.app_users where id = $1", [
          userId,
        ]);
      }).catch((error) => {
        console.error(`Atomic admission test cleanup failed: ${error.message}`);
      });
    }
    await Promise.all([admin.end(), user.end()]);
  }
}

main().catch((error) => {
  console.error(`Atomic generation admission test failed: ${error.message}`);
  process.exitCode = 1;
});
