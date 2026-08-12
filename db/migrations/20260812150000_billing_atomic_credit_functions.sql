-- Atomic source-aware credit operations. All functions serialize operations
-- per workspace by locking the aggregate credit_balances row first.

-- Map existing subscriptions into the versioned catalog without changing the
-- legacy subscription records that current UI and payment code still reads.
INSERT INTO public.workspace_billing_subscriptions (
  workspace_id,
  plan_version_id,
  status,
  billing_period,
  provider,
  provider_customer_id,
  provider_subscription_id,
  current_period_start,
  current_period_end,
  credit_period_start,
  credit_period_end,
  canceled_at,
  metadata
)
SELECT
  legacy.workspace_id,
  version.id,
  CASE
    WHEN legacy.current_period_end IS NOT NULL
      AND legacy.current_period_end <= now()
      AND legacy.plan <> 'free'
      THEN 'expired'
    ELSE 'active'
  END,
  legacy.billing_period::text,
  CASE
    WHEN legacy.lemon_squeezy_subscription_id IS NOT NULL THEN 'lemon_squeezy'
    WHEN legacy.stripe_subscription_id IS NOT NULL THEN 'stripe'
    ELSE NULL
  END,
  coalesce(legacy.lemon_squeezy_customer_id, legacy.stripe_customer_id),
  coalesce(legacy.lemon_squeezy_subscription_id, legacy.stripe_subscription_id),
  legacy.current_period_start,
  legacy.current_period_end,
  legacy.current_period_start,
  legacy.current_period_end,
  legacy.canceled_at,
  jsonb_build_object(
    'migrated_from', 'subscriptions',
    'legacy_plan', legacy.plan::text
  )
FROM public.subscriptions legacy
JOIN public.billing_plans plan
  ON plan.code = CASE
    WHEN legacy.plan = 'free' THEN 'free'
    WHEN legacy.plan IN ('starter', 'pro') THEN 'pro'
    ELSE 'team'
  END
JOIN public.billing_plan_versions version
  ON version.plan_id = plan.id
  AND version.version = 1
WHERE NOT EXISTS (
  SELECT 1
  FROM public.workspace_billing_subscriptions existing
  WHERE existing.workspace_id = legacy.workspace_id
    AND existing.status IN ('trialing', 'active', 'past_due', 'canceled')
);

-- A daily claim made before this ledger was introduced is already included in
-- the migrated legacy balance. Represent it as a consumed batch so it cannot
-- be granted a second time on the migration day.
INSERT INTO public.credit_grant_batches (
  workspace_id,
  source_type,
  original_amount,
  remaining_amount,
  valid_from,
  expires_at,
  idempotency_key,
  metadata
)
SELECT
  claim.workspace_id,
  'daily',
  claim.amount,
  0,
  claim.claim_date::timestamp AT TIME ZONE 'Asia/Shanghai',
  (claim.claim_date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai',
  'daily:' || claim.claim_date::text,
  jsonb_build_object(
    'migrated_from', 'daily_credit_claims',
    'legacy_claim_id', claim.id,
    'migration_state', 'already_in_legacy_balance'
  )
FROM public.daily_credit_claims claim
WHERE claim.amount > 0
ON CONFLICT (workspace_id, idempotency_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.billing_reconcile_expired_credits(
  p_workspace_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance integer;
  v_expired_total integer := 0;
  v_ledger_id uuid;
  v_batch_ids uuid[] := ARRAY[]::uuid[];
  v_batch_amounts integer[] := ARRAY[]::integer[];
  v_index integer;
  v_batch record;
BEGIN
  INSERT INTO public.credit_balances (workspace_id, balance, version)
  VALUES (p_workspace_id, 0, 0)
  ON CONFLICT (workspace_id) DO NOTHING;

  SELECT balance
  INTO v_balance
  FROM public.credit_balances
  WHERE workspace_id = p_workspace_id
  FOR UPDATE;

  FOR v_batch IN
    SELECT id, remaining_amount
    FROM public.credit_grant_batches
    WHERE workspace_id = p_workspace_id
      AND remaining_amount > 0
      AND expires_at IS NOT NULL
      AND expires_at <= now()
    ORDER BY expires_at, created_at, id
    FOR UPDATE
  LOOP
    v_batch_ids := array_append(v_batch_ids, v_batch.id);
    v_batch_amounts := array_append(v_batch_amounts, v_batch.remaining_amount);
    v_expired_total := v_expired_total + v_batch.remaining_amount;
  END LOOP;

  IF v_expired_total = 0 THEN
    RETURN 0;
  END IF;

  IF v_balance < v_expired_total THEN
    RAISE EXCEPTION 'CREDIT_PROJECTION_MISMATCH: balance %, expired %',
      v_balance, v_expired_total;
  END IF;

  UPDATE public.credit_grant_batches
  SET remaining_amount = 0
  WHERE id = ANY(v_batch_ids);

  UPDATE public.credit_balances
  SET balance = balance - v_expired_total,
      version = version + 1,
      updated_at = now()
  WHERE workspace_id = p_workspace_id;

  INSERT INTO public.credit_ledger (
    workspace_id,
    entry_type,
    amount,
    balance_after,
    idempotency_key,
    description,
    metadata
  ) VALUES (
    p_workspace_id,
    'expire',
    -v_expired_total,
    v_balance - v_expired_total,
    'expire:' || gen_random_uuid()::text,
    '到期点数失效',
    jsonb_build_object('expired_batch_count', cardinality(v_batch_ids))
  )
  RETURNING id INTO v_ledger_id;

  FOR v_index IN 1..cardinality(v_batch_ids)
  LOOP
    INSERT INTO public.credit_ledger_allocations (
      ledger_id,
      grant_batch_id,
      amount
    ) VALUES (
      v_ledger_id,
      v_batch_ids[v_index],
      v_batch_amounts[v_index]
    );
  END LOOP;

  RETURN v_expired_total;
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_ensure_daily_credit_grant(
  p_workspace_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan_code text;
  v_daily_credits integer;
  v_day date;
  v_valid_from timestamptz;
  v_expires_at timestamptz;
  v_balance integer;
  v_new_balance integer;
  v_batch_id uuid;
  v_ledger_id uuid;
BEGIN
  PERFORM public.billing_reconcile_expired_credits(p_workspace_id);

  SELECT plan.code, version.daily_credits
  INTO v_plan_code, v_daily_credits
  FROM public.workspace_billing_subscriptions subscription
  JOIN public.billing_plan_versions version
    ON version.id = subscription.plan_version_id
  JOIN public.billing_plans plan
    ON plan.id = version.plan_id
  WHERE subscription.workspace_id = p_workspace_id
    AND subscription.status IN ('trialing', 'active', 'past_due', 'canceled')
    AND (
      subscription.status <> 'canceled'
      OR subscription.current_period_end IS NULL
      OR subscription.current_period_end > now()
    )
  ORDER BY subscription.created_at DESC
  LIMIT 1;

  IF v_plan_code IS NULL THEN
    SELECT plan.code, version.daily_credits
    INTO v_plan_code, v_daily_credits
    FROM public.billing_plans plan
    JOIN public.billing_plan_versions version
      ON version.plan_id = plan.id
      AND version.version = 1
    WHERE plan.code = 'free';
  END IF;

  IF v_plan_code NOT IN ('free', 'pro', 'team') OR coalesce(v_daily_credits, 0) <= 0 THEN
    SELECT balance INTO v_balance
    FROM public.credit_balances
    WHERE workspace_id = p_workspace_id;

    RETURN jsonb_build_object(
      'created', false,
      'balance', coalesce(v_balance, 0),
      'daily_credits', 0
    );
  END IF;

  v_day := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_valid_from := v_day::timestamp AT TIME ZONE 'Asia/Shanghai';
  v_expires_at := (v_day + 1)::timestamp AT TIME ZONE 'Asia/Shanghai';

  SELECT balance
  INTO v_balance
  FROM public.credit_balances
  WHERE workspace_id = p_workspace_id
  FOR UPDATE;

  INSERT INTO public.credit_grant_batches (
    workspace_id,
    source_type,
    original_amount,
    remaining_amount,
    valid_from,
    expires_at,
    idempotency_key,
    metadata
  ) VALUES (
    p_workspace_id,
    'daily',
    v_daily_credits,
    v_daily_credits,
    v_valid_from,
    v_expires_at,
    'daily:' || v_day::text,
    jsonb_build_object('plan_code', v_plan_code, 'timezone', 'Asia/Shanghai')
  )
  ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_batch_id;

  IF v_batch_id IS NULL THEN
    RETURN jsonb_build_object(
      'created', false,
      'balance', v_balance,
      'daily_credits', v_daily_credits
    );
  END IF;

  v_new_balance := v_balance + v_daily_credits;

  UPDATE public.credit_balances
  SET balance = v_new_balance,
      version = version + 1,
      updated_at = now()
  WHERE workspace_id = p_workspace_id;

  INSERT INTO public.credit_ledger (
    workspace_id,
    entry_type,
    amount,
    balance_after,
    idempotency_key,
    description,
    metadata
  ) VALUES (
    p_workspace_id,
    'grant',
    v_daily_credits,
    v_new_balance,
    'daily:' || v_day::text,
    '每日赠送点数',
    jsonb_build_object(
      'source_type', 'daily',
      'transaction_type', 'daily_grant',
      'plan_code', v_plan_code,
      'expires_at', v_expires_at
    )
  )
  RETURNING id INTO v_ledger_id;

  INSERT INTO public.credit_ledger_allocations (
    ledger_id,
    grant_batch_id,
    amount
  ) VALUES (
    v_ledger_id,
    v_batch_id,
    v_daily_credits
  );

  INSERT INTO public.daily_credit_claims (workspace_id, claim_date, amount)
  VALUES (p_workspace_id, v_day, v_daily_credits)
  ON CONFLICT (workspace_id, claim_date) DO NOTHING;

  INSERT INTO public.credit_transactions (
    workspace_id,
    transaction_type,
    amount,
    balance_after,
    description,
    metadata
  ) VALUES (
    p_workspace_id,
    'daily_grant',
    v_daily_credits,
    v_new_balance,
    '每日赠送点数',
    jsonb_build_object('credit_ledger_id', v_ledger_id, 'expires_at', v_expires_at)
  );

  RETURN jsonb_build_object(
    'created', true,
    'balance', v_new_balance,
    'daily_credits', v_daily_credits,
    'expires_at', v_expires_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_get_credit_balance(
  p_workspace_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_daily_result jsonb;
  v_balance integer;
  v_daily integer;
  v_subscription integer;
  v_top_up integer;
  v_permanent integer;
BEGIN
  v_daily_result := public.billing_ensure_daily_credit_grant(p_workspace_id);

  SELECT balance
  INTO v_balance
  FROM public.credit_balances
  WHERE workspace_id = p_workspace_id;

  SELECT
    coalesce(sum(remaining_amount) FILTER (WHERE source_type = 'daily'), 0)::integer,
    coalesce(sum(remaining_amount) FILTER (WHERE source_type = 'subscription'), 0)::integer,
    coalesce(sum(remaining_amount) FILTER (WHERE source_type = 'top_up'), 0)::integer,
    coalesce(sum(remaining_amount) FILTER (WHERE source_type IN ('admin', 'bonus', 'legacy')), 0)::integer
  INTO v_daily, v_subscription, v_top_up, v_permanent
  FROM public.credit_grant_batches
  WHERE workspace_id = p_workspace_id
    AND remaining_amount > 0
    AND valid_from <= now()
    AND (expires_at IS NULL OR expires_at > now());

  RETURN jsonb_build_object(
    'balance', coalesce(v_balance, 0),
    'daily_balance', v_daily,
    'subscription_balance', v_subscription,
    'top_up_balance', v_top_up,
    'permanent_balance', v_permanent,
    'daily_created', coalesce((v_daily_result ->> 'created')::boolean, false)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_deduct_credits(
  p_workspace_id uuid,
  p_user_id uuid,
  p_amount integer,
  p_job_id uuid,
  p_description text,
  p_idempotency_key text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance integer;
  v_new_balance integer;
  v_remaining integer;
  v_take integer;
  v_ledger_id uuid;
  v_existing_id uuid;
  v_batch record;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'CREDIT_AMOUNT_INVALID';
  END IF;
  IF nullif(btrim(p_idempotency_key), '') IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;

  PERFORM public.billing_ensure_daily_credit_grant(p_workspace_id);

  SELECT balance
  INTO v_balance
  FROM public.credit_balances
  WHERE workspace_id = p_workspace_id
  FOR UPDATE;

  SELECT id
  INTO v_existing_id
  FROM public.credit_ledger
  WHERE workspace_id = p_workspace_id
    AND idempotency_key = p_idempotency_key;

  IF v_existing_id IS NOT NULL THEN
    RETURN v_existing_id;
  END IF;

  IF v_balance < p_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_CREDITS: have %, need %', v_balance, p_amount;
  END IF;

  v_new_balance := v_balance - p_amount;

  INSERT INTO public.credit_ledger (
    workspace_id,
    user_id,
    entry_type,
    amount,
    balance_after,
    job_id,
    idempotency_key,
    description,
    metadata
  ) VALUES (
    p_workspace_id,
    p_user_id,
    'deduct',
    -p_amount,
    v_new_balance,
    p_job_id,
    p_idempotency_key,
    p_description,
    jsonb_build_object('transaction_type', 'generation_deduct')
  )
  RETURNING id INTO v_ledger_id;

  v_remaining := p_amount;

  FOR v_batch IN
    SELECT id, source_type, remaining_amount
    FROM public.credit_grant_batches
    WHERE workspace_id = p_workspace_id
      AND remaining_amount > 0
      AND valid_from <= now()
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY
      CASE source_type
        WHEN 'daily' THEN 1
        WHEN 'subscription' THEN 2
        WHEN 'top_up' THEN 3
        WHEN 'admin' THEN 4
        WHEN 'bonus' THEN 5
        WHEN 'legacy' THEN 6
        ELSE 7
      END,
      expires_at NULLS LAST,
      valid_from,
      created_at,
      id
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining = 0;
    v_take := least(v_remaining, v_batch.remaining_amount);

    UPDATE public.credit_grant_batches
    SET remaining_amount = remaining_amount - v_take
    WHERE id = v_batch.id;

    INSERT INTO public.credit_ledger_allocations (
      ledger_id,
      grant_batch_id,
      amount
    ) VALUES (
      v_ledger_id,
      v_batch.id,
      v_take
    );

    v_remaining := v_remaining - v_take;
  END LOOP;

  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'CREDIT_BATCH_PROJECTION_MISMATCH: missing %', v_remaining;
  END IF;

  UPDATE public.credit_balances
  SET balance = v_new_balance,
      version = version + 1,
      updated_at = now()
  WHERE workspace_id = p_workspace_id;

  INSERT INTO public.credit_transactions (
    workspace_id,
    user_id,
    transaction_type,
    amount,
    balance_after,
    job_id,
    description,
    metadata
  ) VALUES (
    p_workspace_id,
    p_user_id,
    'generation_deduct',
    -p_amount,
    v_new_balance,
    p_job_id,
    p_description,
    jsonb_build_object('credit_ledger_id', v_ledger_id)
  );

  RETURN v_ledger_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_refund_credits(
  p_workspace_id uuid,
  p_user_id uuid,
  p_amount integer,
  p_job_id uuid,
  p_description text,
  p_idempotency_key text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance integer;
  v_intermediate_balance integer;
  v_final_balance integer;
  v_original_ledger_id uuid;
  v_original_amount integer;
  v_already_refunded integer;
  v_existing_id uuid;
  v_refund_ledger_id uuid;
  v_expire_ledger_id uuid;
  v_remaining integer;
  v_available integer;
  v_restore integer;
  v_expired_total integer := 0;
  v_allocation record;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'CREDIT_AMOUNT_INVALID';
  END IF;
  IF p_job_id IS NULL THEN
    RAISE EXCEPTION 'REFUND_JOB_REQUIRED';
  END IF;
  IF nullif(btrim(p_idempotency_key), '') IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;

  PERFORM public.billing_reconcile_expired_credits(p_workspace_id);

  SELECT balance
  INTO v_balance
  FROM public.credit_balances
  WHERE workspace_id = p_workspace_id
  FOR UPDATE;

  SELECT id
  INTO v_existing_id
  FROM public.credit_ledger
  WHERE workspace_id = p_workspace_id
    AND idempotency_key = p_idempotency_key;

  IF v_existing_id IS NOT NULL THEN
    RETURN v_existing_id;
  END IF;

  SELECT id, -amount
  INTO v_original_ledger_id, v_original_amount
  FROM public.credit_ledger
  WHERE workspace_id = p_workspace_id
    AND job_id = p_job_id
    AND entry_type = 'deduct'
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_original_ledger_id IS NULL THEN
    RAISE EXCEPTION 'ORIGINAL_CREDIT_DEDUCTION_NOT_FOUND';
  END IF;

  SELECT coalesce(sum(amount), 0)::integer
  INTO v_already_refunded
  FROM public.credit_ledger
  WHERE reverses_ledger_id = v_original_ledger_id
    AND entry_type = 'refund';

  IF p_amount > v_original_amount - v_already_refunded THEN
    RAISE EXCEPTION 'REFUND_AMOUNT_EXCEEDS_DEDUCTION';
  END IF;

  v_intermediate_balance := v_balance + p_amount;

  INSERT INTO public.credit_ledger (
    workspace_id,
    user_id,
    entry_type,
    amount,
    balance_after,
    job_id,
    reverses_ledger_id,
    idempotency_key,
    description,
    metadata
  ) VALUES (
    p_workspace_id,
    p_user_id,
    'refund',
    p_amount,
    v_intermediate_balance,
    p_job_id,
    v_original_ledger_id,
    p_idempotency_key,
    p_description,
    jsonb_build_object('transaction_type', 'generation_refund')
  )
  RETURNING id INTO v_refund_ledger_id;

  v_remaining := p_amount;

  FOR v_allocation IN
    SELECT
      original.grant_batch_id,
      original.amount AS deducted_amount,
      batch.remaining_amount,
      batch.original_amount,
      batch.expires_at,
      coalesce((
        SELECT sum(refunded.amount)
        FROM public.credit_ledger refund
        JOIN public.credit_ledger_allocations refunded
          ON refunded.ledger_id = refund.id
        WHERE refund.reverses_ledger_id = v_original_ledger_id
          AND refund.entry_type = 'refund'
          AND refunded.grant_batch_id = original.grant_batch_id
      ), 0)::integer AS refunded_amount
    FROM public.credit_ledger_allocations original
    JOIN public.credit_grant_batches batch
      ON batch.id = original.grant_batch_id
    WHERE original.ledger_id = v_original_ledger_id
    ORDER BY batch.id
    FOR UPDATE OF batch
  LOOP
    EXIT WHEN v_remaining = 0;
    v_available := v_allocation.deducted_amount - v_allocation.refunded_amount;
    IF v_available <= 0 THEN
      CONTINUE;
    END IF;

    v_restore := least(v_remaining, v_available);

    IF v_allocation.remaining_amount + v_restore > v_allocation.original_amount THEN
      RAISE EXCEPTION 'CREDIT_BATCH_REFUND_OVERFLOW';
    END IF;

    UPDATE public.credit_grant_batches
    SET remaining_amount = remaining_amount + v_restore
    WHERE id = v_allocation.grant_batch_id;

    INSERT INTO public.credit_ledger_allocations (
      ledger_id,
      grant_batch_id,
      amount
    ) VALUES (
      v_refund_ledger_id,
      v_allocation.grant_batch_id,
      v_restore
    );

    IF v_allocation.expires_at IS NOT NULL AND v_allocation.expires_at <= now() THEN
      v_expired_total := v_expired_total + v_restore;
    END IF;

    v_remaining := v_remaining - v_restore;
  END LOOP;

  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'REFUND_ALLOCATION_MISMATCH: missing %', v_remaining;
  END IF;

  UPDATE public.credit_balances
  SET balance = v_intermediate_balance,
      version = version + 1,
      updated_at = now()
  WHERE workspace_id = p_workspace_id;

  v_final_balance := v_intermediate_balance;

  IF v_expired_total > 0 THEN
    UPDATE public.credit_grant_batches batch
    SET remaining_amount = remaining_amount - allocation.amount
    FROM public.credit_ledger_allocations allocation
    WHERE allocation.ledger_id = v_refund_ledger_id
      AND allocation.grant_batch_id = batch.id
      AND batch.expires_at IS NOT NULL
      AND batch.expires_at <= now();

    v_final_balance := v_intermediate_balance - v_expired_total;

    UPDATE public.credit_balances
    SET balance = v_final_balance,
        version = version + 1,
        updated_at = now()
    WHERE workspace_id = p_workspace_id;

    INSERT INTO public.credit_ledger (
      workspace_id,
      user_id,
      entry_type,
      amount,
      balance_after,
      job_id,
      idempotency_key,
      description,
      metadata
    ) VALUES (
      p_workspace_id,
      p_user_id,
      'expire',
      -v_expired_total,
      v_final_balance,
      p_job_id,
      p_idempotency_key || ':expired',
      '退款恢复至已到期批次后立即失效',
      jsonb_build_object('refund_ledger_id', v_refund_ledger_id)
    )
    RETURNING id INTO v_expire_ledger_id;

    INSERT INTO public.credit_ledger_allocations (
      ledger_id,
      grant_batch_id,
      amount
    )
    SELECT
      v_expire_ledger_id,
      allocation.grant_batch_id,
      allocation.amount
    FROM public.credit_ledger_allocations allocation
    JOIN public.credit_grant_batches batch
      ON batch.id = allocation.grant_batch_id
    WHERE allocation.ledger_id = v_refund_ledger_id
      AND batch.expires_at IS NOT NULL
      AND batch.expires_at <= now();
  END IF;

  INSERT INTO public.credit_transactions (
    workspace_id,
    user_id,
    transaction_type,
    amount,
    balance_after,
    job_id,
    description,
    metadata
  ) VALUES (
    p_workspace_id,
    p_user_id,
    'generation_refund',
    p_amount,
    v_final_balance,
    p_job_id,
    p_description,
    jsonb_build_object(
      'credit_ledger_id', v_refund_ledger_id,
      'expired_on_refund', v_expired_total
    )
  );

  RETURN v_refund_ledger_id;
END;
$$;

REVOKE ALL ON FUNCTION public.billing_reconcile_expired_credits(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_ensure_daily_credit_grant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_get_credit_balance(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_deduct_credits(uuid, uuid, integer, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_refund_credits(uuid, uuid, integer, uuid, text, text) FROM PUBLIC;

COMMENT ON FUNCTION public.billing_deduct_credits(uuid, uuid, integer, uuid, text, text) IS
  'Atomically consumes daily, subscription, top-up, admin, bonus, then legacy batches.';
COMMENT ON FUNCTION public.billing_refund_credits(uuid, uuid, integer, uuid, text, text) IS
  'Restores the exact source allocations of a job deduction without extending their expiry.';
