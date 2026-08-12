#!/usr/bin/env node

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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  await loadEnv();
  const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for the billing ledger test.");
  }

  const client = new pg.Client({
    application_name: "loomic-billing-ledger-test",
    connectionString,
  });

  await client.connect();
  try {
    await client.query("begin");

    const ids = (
      await client.query(`
        select
          gen_random_uuid() as user_id,
          gen_random_uuid() as workspace_id,
          gen_random_uuid() as job_id
      `)
    ).rows[0];

    await client.query(
      `insert into public.app_users (id, email, password_hash)
       values ($1, $2, 'billing-test')`,
      [ids.user_id, `billing-${ids.user_id}@test.local`],
    );
    await client.query(
      `insert into public.workspaces (id, type, name, owner_user_id)
       values ($1, 'team', 'Billing Ledger Test', $2)`,
      [ids.workspace_id, ids.user_id],
    );
    await client.query(
      `insert into public.workspace_members (workspace_id, user_id, role)
       values ($1, $2, 'owner')`,
      [ids.workspace_id, ids.user_id],
    );

    const proVersionId = (
      await client.query(`
        select version.id
        from public.billing_plan_versions version
        join public.billing_plans plan on plan.id = version.plan_id
        where plan.code = 'pro' and version.version = 1
      `)
    ).rows[0].id;

    const topUpPackId = (
      await client.query(`
        select id
        from public.billing_top_up_packs
        where code = 'credits_1000' and version = 1
      `)
    ).rows[0].id;

    const subscriptionId = (
      await client.query(
        `insert into public.workspace_billing_subscriptions (
           workspace_id,
           plan_version_id,
           status,
           billing_period,
           current_period_start,
           current_period_end,
           credit_period_start,
           credit_period_end
         ) values (
           $1,
           $2,
           'active',
           'monthly',
           now(),
           now() + interval '1 month',
           now(),
           now() + interval '1 month'
         ) returning id`,
        [ids.workspace_id, proVersionId],
      )
    ).rows[0].id;

    const paymentOrderId = (
      await client.query(
        `insert into public.billing_payment_orders (
           workspace_id,
           order_type,
           status,
           top_up_pack_id,
           provider,
           provider_order_id,
           currency,
           amount_minor,
           idempotency_key,
           paid_at
         ) values (
           $1,
           'top_up',
           'paid',
           $2,
           'test',
           $3,
           'USD',
           100,
           'test:topup-order',
           now()
         ) returning id`,
        [ids.workspace_id, topUpPackId, `test-${ids.workspace_id}`],
      )
    ).rows[0].id;

    await client.query(
      `insert into public.credit_grant_batches (
         workspace_id,
         source_type,
         original_amount,
         remaining_amount,
         valid_from,
         expires_at,
         subscription_id,
         subscription_period_key,
         idempotency_key
       ) values (
         $1,
         'subscription',
         30,
         30,
         now(),
         now() + interval '1 month',
         $2,
         'test-period',
         'test:subscription-grant'
       )`,
      [ids.workspace_id, subscriptionId],
    );
    await client.query(
      `insert into public.credit_grant_batches (
         workspace_id,
         source_type,
         original_amount,
         remaining_amount,
         payment_order_id,
         idempotency_key
       ) values ($1, 'top_up', 40, 40, $2, 'test:topup-grant')`,
      [ids.workspace_id, paymentOrderId],
    );
    await client.query(
      `insert into public.credit_grant_batches (
         workspace_id,
         source_type,
         original_amount,
         remaining_amount,
         idempotency_key
       ) values ($1, 'admin', 100, 100, 'test:admin-grant')`,
      [ids.workspace_id],
    );
    await client.query(
      `update public.credit_balances
       set balance = balance + 170, version = version + 1
       where workspace_id = $1`,
      [ids.workspace_id],
    );

    await client.query(
      `insert into public.background_jobs (
         id,
         workspace_id,
         queue_name,
         job_type,
         created_by
       ) values ($1, $2, 'image_generation_jobs', 'image_generation', $3)`,
      [ids.job_id, ids.workspace_id, ids.user_id],
    );

    const firstBalance = (
      await client.query(
        "select public.billing_get_credit_balance($1) as result",
        [ids.workspace_id],
      )
    ).rows[0].result;
    const secondBalance = (
      await client.query(
        "select public.billing_get_credit_balance($1) as result",
        [ids.workspace_id],
      )
    ).rows[0].result;

    const deductId = (
      await client.query(
        `select public.billing_deduct_credits(
           $1, $2, 140, $3, 'billing test', 'test:deduct'
         ) as id`,
        [ids.workspace_id, ids.user_id, ids.job_id],
      )
    ).rows[0].id;
    const duplicateDeductId = (
      await client.query(
        `select public.billing_deduct_credits(
           $1, $2, 140, $3, 'billing test', 'test:deduct'
         ) as id`,
        [ids.workspace_id, ids.user_id, ids.job_id],
      )
    ).rows[0].id;

    const deductions = (
      await client.query(
        `select batch.source_type, allocation.amount
         from public.credit_ledger_allocations allocation
         join public.credit_grant_batches batch
           on batch.id = allocation.grant_batch_id
         where allocation.ledger_id = $1
         order by case batch.source_type
           when 'daily' then 1
           when 'subscription' then 2
           when 'top_up' then 3
           when 'admin' then 4
           else 5
         end`,
        [deductId],
      )
    ).rows;

    const refundId = (
      await client.query(
        `select public.billing_refund_credits(
           $1, $2, 140, $3, 'billing test refund', 'test:refund'
         ) as id`,
        [ids.workspace_id, ids.user_id, ids.job_id],
      )
    ).rows[0].id;
    const duplicateRefundId = (
      await client.query(
        `select public.billing_refund_credits(
           $1, $2, 140, $3, 'billing test refund', 'test:refund'
         ) as id`,
        [ids.workspace_id, ids.user_id, ids.job_id],
      )
    ).rows[0].id;

    const finalBalance = (
      await client.query(
        "select public.billing_get_credit_balance($1) as result",
        [ids.workspace_id],
      )
    ).rows[0].result;

    assert(firstBalance.balance === 220, "Daily grant did not produce the expected balance.");
    assert(firstBalance.daily_balance === 50, "Daily grant should be 50 credits.");
    assert(secondBalance.balance === 220, "Daily credits accumulated on a repeated query.");
    assert(deductId === duplicateDeductId, "Credit deduction is not idempotent.");
    assert(refundId === duplicateRefundId, "Credit refund is not idempotent.");
    assert(
      JSON.stringify(deductions) ===
        JSON.stringify([
          { source_type: "daily", amount: 50 },
          { source_type: "subscription", amount: 30 },
          { source_type: "top_up", amount: 40 },
          { source_type: "admin", amount: 20 },
        ]),
      `Unexpected deduction order: ${JSON.stringify(deductions)}`,
    );
    assert(finalBalance.balance === 220, "Refund did not restore the full balance.");
    assert(finalBalance.daily_balance === 50, "Refund did not restore daily credits.");
    assert(finalBalance.subscription_balance === 30, "Refund did not restore subscription credits.");
    assert(finalBalance.top_up_balance === 40, "Refund did not restore top-up credits.");
    assert(finalBalance.permanent_balance === 100, "Refund did not restore permanent credits.");

    console.log(
      JSON.stringify(
        {
          dailyGrantIdempotent: firstBalance.balance === secondBalance.balance,
          deductionIdempotent: deductId === duplicateDeductId,
          deductionOrder: deductions.map((row) => row.source_type),
          refundIdempotent: refundId === duplicateRefundId,
          sourceBalancesRestored: true,
        },
        null,
        2,
      ),
    );

    await client.query("rollback");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Billing ledger test failed: ${error.message}`);
  process.exitCode = 1;
});
