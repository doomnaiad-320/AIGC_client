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
  { credits: 5_000, email: "pro@test.loomic.com", plan: "pro" },
  { credits: 15_000, email: "ultra@test.loomic.com", plan: "ultra" },
];

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
          (value.startsWith("\"") && value.endsWith("\"")) ||
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
    await client.query("select set_config('app.is_service_role', 'true', true)");
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
    for (const account of TEST_ACCOUNTS) {
      const result = await seedAccount(client, account);
      console.log(
        `[ready] ${account.email} plan=${account.plan} credits=${account.credits} user=${result.userId}`,
      );
    }
  } finally {
    await client.end();
  }

  console.log(`Password for all test accounts: ${PASSWORD}`);
}

main().catch((error) => {
  console.error(`Seed failed: ${error.message}`);
  process.exitCode = 1;
});
