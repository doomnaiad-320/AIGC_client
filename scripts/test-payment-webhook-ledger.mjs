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

async function claim(client, eventId, eventName, workspaceId, subscriptionId) {
  return (
    await client.query(
      `select public.payment_claim_webhook_event(
         'lemon_squeezy', $1, $2, $3, $4, $5::jsonb
       ) as result`,
      [
        eventId,
        eventName,
        subscriptionId,
        workspaceId,
        JSON.stringify({ eventId, eventName }),
      ],
    )
  ).rows[0].result;
}

async function processEvent(client, options) {
  return (
    await client.query(
      `select public.billing_process_lemon_squeezy_webhook(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15::jsonb
       ) as result`,
      [
        options.eventId,
        options.eventName,
        options.workspaceId,
        options.subscriptionId,
        "customer-123",
        "variant-pro-monthly",
        "order-123",
        "pro",
        "monthly",
        "active",
        options.periodStart,
        options.periodEnd,
        options.cancelAtPeriodEnd ?? false,
        options.canceledAt ?? null,
        JSON.stringify({ source: "integration-test" }),
      ],
    )
  ).rows[0].result;
}

async function main() {
  await loadEnv();
  const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is required for the payment webhook ledger test.",
    );
  }

  const client = new pg.Client({
    application_name: "loomic-payment-webhook-ledger-test",
    connectionString,
  });

  await client.connect();
  try {
    await client.query("begin");

    const ids = await scalar(
      client,
      `select
         gen_random_uuid() as user_id,
         gen_random_uuid() as workspace_id,
         gen_random_uuid()::text as test_id,
         now() as period_start,
         now() + interval '1 month' as period_end`,
    );
    const subscriptionId = `ls-subscription-${ids.test_id}`;
    const createdEventId = `created:${ids.test_id}`;
    const paidEventId = `paid:${ids.test_id}`;

    await client.query(
      `insert into public.app_users (id, email, password_hash)
       values ($1, $2, 'payment-webhook-test')`,
      [ids.user_id, `payment-${ids.user_id}@test.local`],
    );
    await client.query(
      `insert into public.workspaces (id, type, name, owner_user_id)
       values ($1, 'team', 'Payment Webhook Test', $2)`,
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

    const proPlan = await scalar(
      client,
      `select version.monthly_subscription_credits as credits
       from public.billing_plan_versions version
       join public.billing_plans plan on plan.id = version.plan_id
       where plan.code = 'pro' and version.status = 'published'
       limit 1`,
    );
    assert(Number(proPlan.credits) > 0, "Published Pro credits are required.");

    await client.query("set local role service_role");

    const createdClaim = await claim(
      client,
      createdEventId,
      "subscription_created",
      ids.workspace_id,
      subscriptionId,
    );
    assert(createdClaim.claimed === true, "Creation webhook was not claimed.");
    await processEvent(client, {
      eventId: createdEventId,
      eventName: "subscription_created",
      periodEnd: ids.period_end,
      periodStart: ids.period_start,
      subscriptionId,
      workspaceId: ids.workspace_id,
    });

    const balanceAfterCreation = await scalar(
      client,
      "select balance from public.credit_balances where workspace_id = $1",
      [ids.workspace_id],
    );
    assert(
      Number(balanceAfterCreation.balance) === 0,
      "Subscription creation granted credits before payment success.",
    );

    const paidClaim = await claim(
      client,
      paidEventId,
      "subscription_payment_success",
      ids.workspace_id,
      subscriptionId,
    );
    assert(
      paidClaim.claimed === true,
      "Payment success webhook was not claimed.",
    );
    const paidResult = await processEvent(client, {
      eventId: paidEventId,
      eventName: "subscription_payment_success",
      periodEnd: ids.period_end,
      periodStart: ids.period_start,
      subscriptionId,
      workspaceId: ids.workspace_id,
    });
    assert(
      paidResult.grant.created === true,
      "Payment success did not create a credit grant.",
    );

    const duplicateClaim = await claim(
      client,
      paidEventId,
      "subscription_payment_success",
      ids.workspace_id,
      subscriptionId,
    );
    assert(
      duplicateClaim.claimed === false,
      "Identical webhook replay was reclaimed.",
    );
    assert(
      duplicateClaim.status === "processed",
      "Identical webhook was not processed.",
    );

    const semanticDuplicateEventId = `paid-duplicate:${ids.test_id}`;
    await claim(
      client,
      semanticDuplicateEventId,
      "subscription_payment_success",
      ids.workspace_id,
      subscriptionId,
    );
    const semanticDuplicate = await processEvent(client, {
      eventId: semanticDuplicateEventId,
      eventName: "subscription_payment_success",
      periodEnd: ids.period_end,
      periodStart: ids.period_start,
      subscriptionId,
      workspaceId: ids.workspace_id,
    });
    assert(
      semanticDuplicate.grant.created === false,
      "A second event for the same subscription period granted credits twice.",
    );

    const projection = await scalar(
      client,
      `select
         balance.balance,
         legacy.plan::text as legacy_plan,
         canonical.provider,
         plan.code as canonical_plan,
         (
           select count(*)::int
           from public.credit_grant_batches batch
           where batch.workspace_id = $1 and batch.source_type = 'subscription'
         ) as grant_batches,
         (
           select count(*)::int
           from public.credit_ledger ledger
           where ledger.workspace_id = $1 and ledger.entry_type = 'grant'
         ) as grant_ledger_entries
       from public.credit_balances balance
       join public.subscriptions legacy on legacy.workspace_id = balance.workspace_id
       join public.workspace_billing_subscriptions canonical
         on canonical.workspace_id = balance.workspace_id
        and canonical.status = 'active'
       join public.billing_plan_versions version on version.id = canonical.plan_version_id
       join public.billing_plans plan on plan.id = version.plan_id
       where balance.workspace_id = $1`,
      [ids.workspace_id],
    );
    assert(
      Number(projection.balance) === Number(proPlan.credits),
      "Webhook replay changed the credit balance.",
    );
    assert(
      projection.legacy_plan === "pro",
      "Legacy subscription projection is inconsistent.",
    );
    assert(
      projection.canonical_plan === "pro",
      "Canonical subscription projection is inconsistent.",
    );
    assert(
      projection.provider === "lemon_squeezy",
      "Canonical provider was not recorded.",
    );
    assert(
      Number(projection.grant_batches) === 1,
      "Expected one subscription grant batch.",
    );
    assert(
      Number(projection.grant_ledger_entries) === 1,
      "Expected one grant ledger entry.",
    );

    const canceledEventId = `canceled:${ids.test_id}`;
    await claim(
      client,
      canceledEventId,
      "subscription_cancelled",
      ids.workspace_id,
      subscriptionId,
    );
    await processEvent(client, {
      cancelAtPeriodEnd: true,
      canceledAt: ids.period_end,
      eventId: canceledEventId,
      eventName: "subscription_cancelled",
      periodEnd: ids.period_end,
      periodStart: ids.period_start,
      subscriptionId,
      workspaceId: ids.workspace_id,
    });

    const canceledProjection = await scalar(
      client,
      `select status, cancel_at_period_end, canceled_at
       from public.workspace_billing_subscriptions
       where provider_subscription_id = $1`,
      [subscriptionId],
    );
    assert(
      canceledProjection.status === "canceled",
      "Cancellation status was not projected.",
    );
    assert(
      canceledProjection.cancel_at_period_end === true,
      "Cancellation was not scheduled.",
    );
    assert(
      canceledProjection.canceled_at != null,
      "Cancellation timestamp was not recorded.",
    );

    const resumedEventId = `resumed:${ids.test_id}`;
    await claim(
      client,
      resumedEventId,
      "subscription_updated",
      ids.workspace_id,
      subscriptionId,
    );
    await processEvent(client, {
      cancelAtPeriodEnd: false,
      eventId: resumedEventId,
      eventName: "subscription_updated",
      periodEnd: ids.period_end,
      periodStart: ids.period_start,
      subscriptionId,
      workspaceId: ids.workspace_id,
    });

    const resumedProjection = await scalar(
      client,
      `select status, cancel_at_period_end, canceled_at
       from public.workspace_billing_subscriptions
       where provider_subscription_id = $1`,
      [subscriptionId],
    );
    assert(
      resumedProjection.status === "active",
      "Resumed subscription is not active.",
    );
    assert(
      resumedProjection.cancel_at_period_end === false,
      "Resume left cancellation scheduled.",
    );
    assert(
      resumedProjection.canceled_at == null,
      "Resume retained a stale cancellation timestamp.",
    );

    const retryEventId = `retry:${ids.test_id}`;
    const retryClaim = await claim(
      client,
      retryEventId,
      "subscription_updated",
      ids.workspace_id,
      subscriptionId,
    );
    assert(retryClaim.claimed === true, "Retry test webhook was not claimed.");
    await client.query(
      `select public.payment_fail_webhook_event(
         'lemon_squeezy', $1, 'simulated failure'
       )`,
      [retryEventId],
    );
    const reclaimed = await claim(
      client,
      retryEventId,
      "subscription_updated",
      ids.workspace_id,
      subscriptionId,
    );
    assert(
      reclaimed.claimed === true,
      "Failed webhook could not be reclaimed.",
    );
    assert(
      Number(reclaimed.attemptCount) === 2,
      "Webhook retry attempt was not counted.",
    );

    const expiredEventId = `expired:${ids.test_id}`;
    const expiredClaim = await claim(
      client,
      expiredEventId,
      "subscription_expired",
      ids.workspace_id,
      subscriptionId,
    );
    assert(
      expiredClaim.claimed === true,
      "Expiration webhook was not claimed.",
    );
    await processEvent(client, {
      eventId: expiredEventId,
      eventName: "subscription_expired",
      periodEnd: ids.period_end,
      periodStart: ids.period_start,
      subscriptionId,
      workspaceId: ids.workspace_id,
    });

    const expiredProjection = await scalar(
      client,
      `select
         balance.balance,
         legacy.plan::text as legacy_plan,
         canonical.status as canonical_status
       from public.credit_balances balance
       join public.subscriptions legacy on legacy.workspace_id = balance.workspace_id
       join public.workspace_billing_subscriptions canonical
         on canonical.workspace_id = balance.workspace_id
        and canonical.provider_subscription_id = $2
       where balance.workspace_id = $1`,
      [ids.workspace_id, subscriptionId],
    );
    assert(
      Number(expiredProjection.balance) === 0,
      "Expired subscription credits remained.",
    );
    assert(
      expiredProjection.legacy_plan === "free",
      "Expired legacy projection did not fall back to Free.",
    );
    assert(
      expiredProjection.canonical_status === "expired",
      "Canonical subscription did not expire.",
    );

    console.log(
      JSON.stringify(
        {
          canonicalPlan: projection.canonical_plan,
          creditsGranted: Number(projection.balance),
          expiredBalance: Number(expiredProjection.balance),
          expiredPlan: expiredProjection.legacy_plan,
          failedEventRetryable: reclaimed.claimed,
          identicalReplayClaimed: duplicateClaim.claimed,
          ledgerGrantCount: Number(projection.grant_ledger_entries),
          resumedCancellationCleared: resumedProjection.canceled_at == null,
          semanticDuplicateGranted: semanticDuplicate.grant.created,
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
  console.error("Payment webhook ledger test failed:", error);
  process.exitCode = 1;
});
