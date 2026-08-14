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

async function scalar(client, sql, values = []) {
  return (await client.query(sql, values)).rows[0];
}

async function main() {
  await loadEnv();
  const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for the local subscription test.");
  }

  const client = new pg.Client({
    application_name: "loomic-local-subscription-test",
    connectionString,
  });

  await client.connect();
  try {
    await client.query("begin");

    const ids = await scalar(
      client,
      `select gen_random_uuid() as user_id, gen_random_uuid() as workspace_id`,
    );
    await client.query(
      `insert into public.app_users (id, email, password_hash)
       values ($1, $2, 'subscription-test')`,
      [ids.user_id, `subscription-${ids.user_id}@test.local`],
    );
    await client.query(
      `insert into public.workspaces (id, type, name, owner_user_id)
       values ($1, 'team', 'Local Subscription Test', $2)`,
      [ids.workspace_id, ids.user_id],
    );
    await client.query(
      `insert into public.workspace_members (workspace_id, user_id, role)
       values ($1, $2, 'owner')`,
      [ids.workspace_id, ids.user_id],
    );
    await client.query(
      `insert into public.credit_balances (workspace_id, balance, version)
       values ($1, 0, 0)
       on conflict (workspace_id) do nothing`,
      [ids.workspace_id],
    );

    const planCredits = Object.fromEntries(
      (
        await client.query(`
          select plan.code, version.monthly_subscription_credits as credits
          from public.billing_plans plan
          join public.billing_plan_versions version
            on version.plan_id = plan.id and version.status = 'published'
          where plan.code in ('free', 'pro', 'team')
        `)
      ).rows.map((row) => [row.code, Number(row.credits)]),
    );
    assert(planCredits.free != null, "Published Free plan is required.");
    assert(planCredits.pro > 0, "Published Pro plan with credits is required.");
    assert(planCredits.team > 0, "Published Team plan with credits is required.");

    const firstActivation = (
      await client.query(
        `select public.billing_local_activate_subscription(
           $1, $2, 'pro', 'monthly', 'test:activate-pro'
         ) as result`,
        [ids.workspace_id, ids.user_id],
      )
    ).rows[0].result;
    assert(firstActivation.action === "activated", "Pro activation did not start a subscription.");

    const firstBalance = Number(
      (
        await scalar(
          client,
          `select balance from public.credit_balances where workspace_id = $1`,
          [ids.workspace_id],
        )
      ).balance,
    );
    assert(firstBalance === planCredits.pro, "Pro credits were not granted exactly once.");

    const duplicateActivation = (
      await client.query(
        `select public.billing_local_activate_subscription(
           $1, $2, 'pro', 'monthly', 'test:activate-pro'
         ) as result`,
        [ids.workspace_id, ids.user_id],
      )
    ).rows[0].result;
    assert(duplicateActivation.action === "idempotent", "Duplicate activation was not idempotent.");

    const samePlanActivation = (
      await client.query(
        `select public.billing_local_activate_subscription(
           $1, $2, 'pro', 'monthly', 'test:activate-pro-again'
         ) as result`,
        [ids.workspace_id, ids.user_id],
      )
    ).rows[0].result;
    assert(samePlanActivation.action === "unchanged", "Same-plan activation should not grant again.");

    const unchangedBalance = Number(
      (
        await scalar(
          client,
          `select balance from public.credit_balances where workspace_id = $1`,
          [ids.workspace_id],
        )
      ).balance,
    );
    assert(unchangedBalance === planCredits.pro, "Idempotent activation changed the balance.");

    const canceled = (
      await client.query(
        `select public.billing_local_cancel_subscription($1, $2) as result`,
        [ids.workspace_id, ids.user_id],
      )
    ).rows[0].result;
    assert(canceled.cancel_at_period_end === true, "Cancellation was not scheduled for period end.");

    const resumed = (
      await client.query(
        `select public.billing_local_resume_subscription($1, $2) as result`,
        [ids.workspace_id, ids.user_id],
      )
    ).rows[0].result;
    assert(resumed.action === "resumed", "Canceled subscription was not resumed.");

    const teamActivation = (
      await client.query(
        `select public.billing_local_activate_subscription(
           $1, $2, 'team', 'yearly', 'test:activate-team'
         ) as result`,
        [ids.workspace_id, ids.user_id],
      )
    ).rows[0].result;
    assert(teamActivation.action === "changed", "Plan change did not replace the subscription.");

    const teamBalance = Number(
      (
        await scalar(
          client,
          `select balance from public.credit_balances where workspace_id = $1`,
          [ids.workspace_id],
        )
      ).balance,
    );
    assert(
      teamBalance === planCredits.team,
      `Plan change balance should equal Team credits, got ${teamBalance}.`,
    );

    const ledgerCounts = await scalar(
      client,
      `select
         count(*) filter (where entry_type = 'grant')::int as grants,
         count(*) filter (where entry_type = 'expire')::int as expirations
       from public.credit_ledger
       where workspace_id = $1`,
      [ids.workspace_id],
    );
    assert(Number(ledgerCounts.grants) === 2, "Expected one Pro and one Team grant.");
    assert(Number(ledgerCounts.expirations) === 1, "Plan change did not expire old subscription credits.");

    await client.query(
      `select public.billing_local_cancel_subscription($1, $2)`,
      [ids.workspace_id, ids.user_id],
    );
    await client.query(
      `update public.workspace_billing_subscriptions
       set current_period_start = now() - interval '1 year',
           current_period_end = now() - interval '1 second',
           credit_period_start = now() - interval '1 month',
           credit_period_end = now() - interval '1 second'
       where id = $1`,
      [teamActivation.subscription_id],
    );
    await client.query(
      `update public.credit_grant_batches
       set valid_from = now() - interval '1 month',
           expires_at = now() - interval '1 second'
       where subscription_id = $1`,
      [teamActivation.subscription_id],
    );

    const reconciliation = (
      await client.query(
        `select public.billing_reconcile_local_subscription($1) as result`,
        [ids.workspace_id],
      )
    ).rows[0].result;
    assert(reconciliation.action === "expired", "Canceled subscription did not expire at period end.");

    const finalStatus = (
      await client.query(
        `select public.billing_local_get_subscription_status($1, $2) as result`,
        [ids.workspace_id, ids.user_id],
      )
    ).rows[0].result;
    assert(finalStatus.plan === "free", "Expired subscription did not fall back to Free.");

    const finalBalance = Number(
      (
        await scalar(
          client,
          `select balance from public.credit_balances where workspace_id = $1`,
          [ids.workspace_id],
        )
      ).balance,
    );
    assert(finalBalance === 0, "Expired subscription credits remained in the balance.");

    console.log(
      JSON.stringify(
        {
          activation: firstActivation.action,
          cancellationAtPeriodEnd: canceled.cancel_at_period_end,
          duplicateActivation: duplicateActivation.action,
          finalPlan: finalStatus.plan,
          planChange: teamActivation.action,
          resumed: resumed.action,
          subscriptionCreditsReplaced: teamBalance === planCredits.team,
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
  console.error("Local subscription lifecycle test failed:", error);
  process.exitCode = 1;
});
