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

async function one(client, sql, values = []) {
  return (await client.query(sql, values)).rows[0];
}

async function expectDatabaseError(client, sql, values, marker) {
  await client.query("savepoint expected_error");
  let caught = null;
  try {
    await client.query(sql, values);
  } catch (error) {
    caught = error;
  }
  await client.query("rollback to savepoint expected_error");
  await client.query("release savepoint expected_error");
  if (!caught)
    throw new Error(`Expected ${marker} but the statement succeeded.`);
  assert(
    String(caught.message).includes(marker),
    `Expected ${marker}, received: ${caught.message}`,
  );
}

async function main() {
  await loadEnv();
  const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!connectionString)
    throw new Error("DATABASE_URL is required for the DuluPay top-up test.");

  const client = new pg.Client({
    application_name: "loomic-dulupay-top-up-test",
    connectionString,
  });
  await client.connect();
  try {
    await client.query("begin");
    const ids = await one(
      client,
      `select gen_random_uuid() as admin_user_id,
              gen_random_uuid() as member_user_id,
              gen_random_uuid() as workspace_id`,
    );
    const packCode = `test_${String(ids.workspace_id).replaceAll("-", "").slice(0, 16)}`;

    await client.query(
      `insert into public.app_users (id, email, password_hash)
       values ($1, $2, 'topup-test'), ($3, $4, 'topup-test')`,
      [
        ids.admin_user_id,
        `topup-admin-${ids.admin_user_id}@test.local`,
        ids.member_user_id,
        `topup-member-${ids.member_user_id}@test.local`,
      ],
    );
    await client.query(
      `insert into public.platform_admins (user_id, note)
       values ($1, 'DuluPay integration test')`,
      [ids.admin_user_id],
    );
    await client.query(
      `insert into public.workspaces (id, type, name, owner_user_id)
       values ($1, 'team', 'DuluPay Top-up Test', $2)`,
      [ids.workspace_id, ids.admin_user_id],
    );
    await client.query(
      `insert into public.workspace_members (workspace_id, user_id, role)
       values ($1, $2, 'owner'), ($1, $3, 'member')`,
      [ids.workspace_id, ids.admin_user_id, ids.member_user_id],
    );

    const packId = (
      await one(
        client,
        `select public.admin_save_top_up_pack_draft(
           $1, $2, 'Integration point pack', 'Permanent top-up credits',
           4321, 1299, 'pro', 90, 8800, 'create integration test pack'
         ) as id`,
        [ids.admin_user_id, packCode],
      )
    ).id;
    assert(packId, "Point-pack draft was not created.");
    await client.query(
      `select public.admin_publish_top_up_pack($1, $2, 'publish integration test pack')`,
      [ids.admin_user_id, packCode],
    );
    const published = await one(
      client,
      `select pack.status, pack.currency, price.currency as provider_currency,
              price.amount_minor as provider_amount_minor
       from public.billing_top_up_packs pack
       join public.billing_top_up_pack_provider_prices price on price.top_up_pack_id = pack.id
       where pack.id = $1`,
      [packId],
    );
    assert(
      published.status === "published",
      "Point-pack draft did not publish.",
    );
    assert(
      published.currency === "USD",
      "Point-pack catalog currency must remain USD.",
    );
    assert(
      published.provider_currency === "CNY",
      "DuluPay price must use CNY.",
    );
    assert(
      Number(published.provider_amount_minor) === 8800,
      "DuluPay CNY price changed unexpectedly.",
    );

    await client.query(
      `select public.admin_save_payment_provider_config(
         $1, true, 'https://api.dulupay.com/api', 'test-merchant',
         'encrypted-test-private-key', true, 'test-platform-public-key',
         array['alipay', 'wxpay']::text[], 300, 'enable integration test provider'
       )`,
      [ids.admin_user_id],
    );
    await client.query(
      `select public.billing_local_activate_subscription(
         $1, $2, 'pro', 'monthly', $3
       )`,
      [
        ids.workspace_id,
        ids.admin_user_id,
        `topup-test-subscription:${ids.workspace_id}`,
      ],
    );

    const balanceBefore = Number(
      (
        await one(
          client,
          "select balance from public.credit_balances where workspace_id = $1",
          [ids.workspace_id],
        )
      ).balance,
    );
    const created = (
      await one(
        client,
        `select public.billing_create_top_up_order(
           $1, $2, $3, 'dulupay', 'alipay', $4
         ) as result`,
        [
          ids.workspace_id,
          ids.admin_user_id,
          packCode,
          `topup-order:${ids.workspace_id}`,
        ],
      )
    ).result;
    assert(created.currency === "USD", "Order catalog currency must be USD.");
    assert(
      created.provider_currency === "CNY",
      "Order provider currency must be CNY.",
    );
    assert(
      Number(created.provider_amount_minor) === 8800,
      "Order provider amount is incorrect.",
    );

    const firstCallback = (
      await one(
        client,
        `select public.billing_complete_dulupay_top_up(
           $1, $2, $3, 8800, $4::jsonb
         ) as result`,
        [
          created.order_id,
          `event:${created.order_id}`,
          `trade:${created.order_id}`,
          JSON.stringify({ test: true }),
        ],
      )
    ).result;
    const duplicateCallback = (
      await one(
        client,
        `select public.billing_complete_dulupay_top_up(
           $1, $2, $3, 8800, $4::jsonb
         ) as result`,
        [
          created.order_id,
          `event:${created.order_id}`,
          `trade:${created.order_id}`,
          JSON.stringify({ test: true }),
        ],
      )
    ).result;
    assert(
      firstCallback.processed === true,
      "First callback did not apply the top-up.",
    );
    assert(
      duplicateCallback.duplicate === true,
      "Repeated callback was not recognized as duplicate.",
    );

    const projection = await one(
      client,
      `select
         balance.balance,
         count(distinct batch.id)::integer as batch_count,
         bool_and(batch.expires_at is null) as permanent,
         count(distinct ledger.id)::integer as ledger_count,
         count(distinct transaction.id)::integer as transaction_count,
         count(distinct allocation.ledger_id)::integer as allocation_count
       from public.credit_balances balance
       left join public.credit_grant_batches batch
         on batch.workspace_id = balance.workspace_id and batch.payment_order_id = $2
       left join public.credit_ledger ledger on ledger.payment_order_id = $2
       left join public.credit_transactions transaction
         on transaction.workspace_id = balance.workspace_id
        and transaction.metadata->>'payment_order_id' = $2::text
       left join public.credit_ledger_allocations allocation on allocation.ledger_id = ledger.id
       where balance.workspace_id = $1
       group by balance.balance`,
      [ids.workspace_id, created.order_id],
    );
    assert(
      Number(projection.balance) === balanceBefore + 4321,
      "Balance did not increase exactly once.",
    );
    assert(
      Number(projection.batch_count) === 1 && projection.permanent === true,
      "Top-up grant batch must be unique and permanent.",
    );
    assert(
      Number(projection.ledger_count) === 1,
      "Top-up ledger entry must be unique.",
    );
    assert(
      Number(projection.transaction_count) === 1,
      "Top-up transaction projection must be unique.",
    );
    assert(
      Number(projection.allocation_count) === 1,
      "Top-up ledger allocation is missing.",
    );

    const secondOrder = (
      await one(
        client,
        `select public.billing_create_top_up_order(
           $1, $2, $3, 'dulupay', 'wxpay', $4
         ) as result`,
        [
          ids.workspace_id,
          ids.admin_user_id,
          packCode,
          `topup-order-mismatch:${ids.workspace_id}`,
        ],
      )
    ).result;
    await expectDatabaseError(
      client,
      `select public.billing_complete_dulupay_top_up($1, $2, $3, 8799, '{}'::jsonb)`,
      [
        secondOrder.order_id,
        `event:${secondOrder.order_id}`,
        `trade:${secondOrder.order_id}`,
      ],
      "PAYMENT_AMOUNT_MISMATCH",
    );
    await expectDatabaseError(
      client,
      `select public.billing_create_top_up_order($1, $2, $3, 'dulupay', 'alipay', $4)`,
      [
        ids.workspace_id,
        ids.member_user_id,
        packCode,
        `member-order:${ids.workspace_id}`,
      ],
      "TOP_UP_WORKSPACE_ADMIN_REQUIRED",
    );

    const audit = await one(
      client,
      `select count(*)::integer as count from public.admin_audit_events
       where actor_user_id = $1 and action in (
         'billing.top_up_pack_draft.saved',
         'billing.top_up_pack.published',
         'payments.provider_config.updated'
       )`,
      [ids.admin_user_id],
    );
    assert(
      Number(audit.count) === 3,
      "Expected admin audit events were not recorded.",
    );

    console.log("DuluPay top-up ledger checks passed.");
    console.log(
      `Order ${created.order_id}: +4321 permanent credits, duplicate callback ignored.`,
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
  console.error("DuluPay top-up test failed:", error?.stack ?? error);
  process.exitCode = 1;
});
