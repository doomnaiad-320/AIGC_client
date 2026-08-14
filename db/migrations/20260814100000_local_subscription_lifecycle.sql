-- Provider-neutral local subscription lifecycle for development and product
-- validation before a payment adapter is enabled. Paid plan activation remains
-- server-only and all credit mutations use the source-aware ledger.

ALTER TABLE public.workspace_billing_subscriptions
  ADD COLUMN IF NOT EXISTS activation_idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS workspace_billing_subscriptions_activation_key_idx
  ON public.workspace_billing_subscriptions(workspace_id, activation_idempotency_key)
  WHERE activation_idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION private.billing_legacy_plan_code(
  p_plan_code text
) RETURNS public.subscription_plan
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE p_plan_code
    WHEN 'free' THEN 'free'::public.subscription_plan
    WHEN 'pro' THEN 'pro'::public.subscription_plan
    WHEN 'team' THEN 'ultra'::public.subscription_plan
    WHEN 'enterprise' THEN 'business'::public.subscription_plan
    ELSE 'free'::public.subscription_plan
  END;
$$;

CREATE OR REPLACE FUNCTION private.billing_assert_workspace_billing_admin(
  p_workspace_id uuid,
  p_actor_user_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.workspace_members member
    WHERE member.workspace_id = p_workspace_id
      AND member.user_id = p_actor_user_id
      AND member.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'SUBSCRIPTION_WORKSPACE_ADMIN_REQUIRED';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.billing_sync_legacy_subscription_projection(
  p_workspace_id uuid,
  p_plan_code text,
  p_billing_period text,
  p_current_period_start timestamptz,
  p_current_period_end timestamptz,
  p_canceled_at timestamptz
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.subscriptions (
    workspace_id,
    plan,
    billing_period,
    current_period_start,
    current_period_end,
    canceled_at,
    updated_at
  ) VALUES (
    p_workspace_id,
    private.billing_legacy_plan_code(p_plan_code),
    CASE
      WHEN p_plan_code = 'free' OR p_billing_period IS NULL THEN NULL
      ELSE p_billing_period::public.billing_period
    END,
    CASE WHEN p_plan_code = 'free' THEN NULL ELSE p_current_period_start END,
    CASE WHEN p_plan_code = 'free' THEN NULL ELSE p_current_period_end END,
    CASE WHEN p_plan_code = 'free' THEN NULL ELSE p_canceled_at END,
    now()
  )
  ON CONFLICT (workspace_id) DO UPDATE
  SET plan = EXCLUDED.plan,
      billing_period = EXCLUDED.billing_period,
      stripe_customer_id = NULL,
      stripe_subscription_id = NULL,
      lemon_squeezy_customer_id = NULL,
      lemon_squeezy_subscription_id = NULL,
      lemon_squeezy_variant_id = NULL,
      lemon_squeezy_order_id = NULL,
      current_period_start = EXCLUDED.current_period_start,
      current_period_end = EXCLUDED.current_period_end,
      canceled_at = EXCLUDED.canceled_at,
      updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION private.billing_grant_subscription_period(
  p_workspace_id uuid,
  p_subscription_id uuid,
  p_plan_version_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance integer;
  v_batch_id uuid;
  v_credits integer;
  v_idempotency_key text;
  v_ledger_id uuid;
  v_new_balance integer;
  v_period_key text;
  v_plan_code text;
BEGIN
  SELECT
    version.monthly_subscription_credits,
    plan.code
  INTO v_credits, v_plan_code
  FROM public.billing_plan_versions version
  JOIN public.billing_plans plan ON plan.id = version.plan_id
  WHERE version.id = p_plan_version_id;

  IF v_plan_code IS NULL THEN
    RAISE EXCEPTION 'BILLING_PLAN_VERSION_NOT_FOUND';
  END IF;

  IF p_period_end <= p_period_start THEN
    RAISE EXCEPTION 'SUBSCRIPTION_CREDIT_PERIOD_INVALID';
  END IF;

  v_period_key := to_char(p_period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  v_idempotency_key := 'subscription:' || p_subscription_id::text || ':' || v_period_key;

  INSERT INTO public.credit_balances (workspace_id, balance, version)
  VALUES (p_workspace_id, 0, 0)
  ON CONFLICT (workspace_id) DO NOTHING;

  SELECT balance
  INTO v_balance
  FROM public.credit_balances
  WHERE workspace_id = p_workspace_id
  FOR UPDATE;

  IF v_credits <= 0 THEN
    RETURN jsonb_build_object(
      'created', false,
      'credits', 0,
      'balance', v_balance
    );
  END IF;

  INSERT INTO public.credit_grant_batches (
    workspace_id,
    source_type,
    original_amount,
    remaining_amount,
    valid_from,
    expires_at,
    subscription_id,
    subscription_period_key,
    idempotency_key,
    metadata
  ) VALUES (
    p_workspace_id,
    'subscription',
    v_credits,
    v_credits,
    p_period_start,
    p_period_end,
    p_subscription_id,
    v_period_key,
    v_idempotency_key,
    jsonb_build_object(
      'plan_code', v_plan_code,
      'plan_version_id', p_plan_version_id,
      'period_start', p_period_start,
      'period_end', p_period_end,
      'provider', 'local'
    )
  )
  ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_batch_id;

  IF v_batch_id IS NULL THEN
    RETURN jsonb_build_object(
      'created', false,
      'credits', v_credits,
      'balance', v_balance
    );
  END IF;

  v_new_balance := v_balance + v_credits;

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
    v_credits,
    v_new_balance,
    v_idempotency_key,
    v_plan_code || ' 套餐周期点数发放',
    jsonb_build_object(
      'source_type', 'subscription',
      'transaction_type', 'subscription_grant',
      'subscription_id', p_subscription_id,
      'plan_code', v_plan_code,
      'plan_version_id', p_plan_version_id,
      'expires_at', p_period_end,
      'provider', 'local'
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
    v_credits
  );

  INSERT INTO public.credit_transactions (
    workspace_id,
    transaction_type,
    amount,
    balance_after,
    description,
    metadata
  ) VALUES (
    p_workspace_id,
    'subscription_grant',
    v_credits,
    v_new_balance,
    v_plan_code || ' 套餐周期点数发放',
    jsonb_build_object(
      'credit_ledger_id', v_ledger_id,
      'subscription_id', p_subscription_id,
      'plan_version_id', p_plan_version_id,
      'expires_at', p_period_end,
      'provider', 'local'
    )
  );

  RETURN jsonb_build_object(
    'created', true,
    'credits', v_credits,
    'balance', v_new_balance,
    'ledger_id', v_ledger_id,
    'grant_batch_id', v_batch_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.billing_expire_subscription_credits(
  p_workspace_id uuid,
  p_subscription_id uuid,
  p_description text,
  p_idempotency_key text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance integer;
  v_batch record;
  v_batch_amounts integer[] := ARRAY[]::integer[];
  v_batch_ids uuid[] := ARRAY[]::uuid[];
  v_expired_total integer := 0;
  v_existing_id uuid;
  v_index integer;
  v_ledger_id uuid;
BEGIN
  SELECT id
  INTO v_existing_id
  FROM public.credit_ledger
  WHERE workspace_id = p_workspace_id
    AND idempotency_key = p_idempotency_key;

  IF v_existing_id IS NOT NULL THEN
    RETURN 0;
  END IF;

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
      AND subscription_id = p_subscription_id
      AND source_type = 'subscription'
      AND remaining_amount > 0
    ORDER BY created_at, id
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
    RAISE EXCEPTION 'CREDIT_PROJECTION_MISMATCH: balance %, subscription credits %',
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
    p_idempotency_key,
    p_description,
    jsonb_build_object(
      'subscription_id', p_subscription_id,
      'expired_batch_count', cardinality(v_batch_ids),
      'provider', 'local'
    )
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

CREATE OR REPLACE FUNCTION public.billing_reconcile_local_subscription(
  p_workspace_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_credit_end timestamptz;
  v_credit_start timestamptz;
  v_grant jsonb;
  v_now timestamptz := now();
  v_period_end timestamptz;
  v_period_start timestamptz;
  v_plan_code text;
  v_subscription public.workspace_billing_subscriptions;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_workspace_id::text, 0)
  );

  PERFORM public.billing_reconcile_expired_credits(p_workspace_id);

  SELECT subscription.*
  INTO v_subscription
  FROM public.workspace_billing_subscriptions subscription
  WHERE subscription.workspace_id = p_workspace_id
    AND subscription.provider = 'local'
    AND subscription.status IN ('trialing', 'active', 'past_due', 'canceled')
  ORDER BY subscription.created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_subscription.id IS NULL THEN
    RETURN jsonb_build_object('action', 'none');
  END IF;

  SELECT plan.code
  INTO v_plan_code
  FROM public.billing_plan_versions version
  JOIN public.billing_plans plan ON plan.id = version.plan_id
  WHERE version.id = v_subscription.plan_version_id;

  IF v_subscription.current_period_end IS NOT NULL
    AND v_subscription.current_period_end <= v_now
    AND v_subscription.cancel_at_period_end
  THEN
    PERFORM private.billing_expire_subscription_credits(
      p_workspace_id,
      v_subscription.id,
      '订阅周期结束，剩余套餐点数失效',
      'subscription:' || v_subscription.id::text || ':cancel-expire'
    );

    UPDATE public.workspace_billing_subscriptions
    SET status = 'expired',
        updated_at = v_now,
        metadata = metadata || jsonb_build_object('expired_reason', 'canceled_at_period_end')
    WHERE id = v_subscription.id;

    PERFORM private.billing_sync_legacy_subscription_projection(
      p_workspace_id,
      'free',
      NULL,
      NULL,
      NULL,
      NULL
    );

    RETURN jsonb_build_object(
      'action', 'expired',
      'subscription_id', v_subscription.id,
      'plan_code', v_plan_code
    );
  END IF;

  IF v_subscription.current_period_end IS NOT NULL
    AND v_subscription.current_period_end <= v_now
  THEN
    v_period_start := v_now;
    v_period_end := CASE v_subscription.billing_period
      WHEN 'yearly' THEN v_now + interval '1 year'
      ELSE v_now + interval '1 month'
    END;
    v_credit_start := v_now;
    v_credit_end := least(v_now + interval '1 month', v_period_end);

    UPDATE public.workspace_billing_subscriptions
    SET status = 'active',
        current_period_start = v_period_start,
        current_period_end = v_period_end,
        credit_period_start = v_credit_start,
        credit_period_end = v_credit_end,
        canceled_at = NULL,
        cancel_at_period_end = false,
        updated_at = v_now,
        metadata = metadata || jsonb_build_object('last_local_renewal_at', v_now)
    WHERE id = v_subscription.id;

    v_grant := private.billing_grant_subscription_period(
      p_workspace_id,
      v_subscription.id,
      v_subscription.plan_version_id,
      v_credit_start,
      v_credit_end
    );

    PERFORM private.billing_sync_legacy_subscription_projection(
      p_workspace_id,
      v_plan_code,
      v_subscription.billing_period,
      v_period_start,
      v_period_end,
      NULL
    );

    RETURN jsonb_build_object(
      'action', 'renewed',
      'subscription_id', v_subscription.id,
      'grant', v_grant
    );
  END IF;

  IF v_subscription.credit_period_end IS NOT NULL
    AND v_subscription.credit_period_end <= v_now
    AND (
      v_subscription.current_period_end IS NULL
      OR v_subscription.current_period_end > v_now
    )
  THEN
    v_credit_start := v_now;
    v_credit_end := least(
      v_now + interval '1 month',
      coalesce(v_subscription.current_period_end, v_now + interval '1 month')
    );

    UPDATE public.workspace_billing_subscriptions
    SET credit_period_start = v_credit_start,
        credit_period_end = v_credit_end,
        updated_at = v_now,
        metadata = metadata || jsonb_build_object('last_local_credit_renewal_at', v_now)
    WHERE id = v_subscription.id;

    v_grant := private.billing_grant_subscription_period(
      p_workspace_id,
      v_subscription.id,
      v_subscription.plan_version_id,
      v_credit_start,
      v_credit_end
    );

    RETURN jsonb_build_object(
      'action', 'credits_renewed',
      'subscription_id', v_subscription.id,
      'grant', v_grant
    );
  END IF;

  RETURN jsonb_build_object(
    'action', 'unchanged',
    'subscription_id', v_subscription.id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_local_activate_subscription(
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_plan_code text,
  p_billing_period text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_action text := 'activated';
  v_credit_end timestamptz;
  v_current public.workspace_billing_subscriptions;
  v_existing public.workspace_billing_subscriptions;
  v_grant jsonb;
  v_now timestamptz := now();
  v_period_end timestamptz;
  v_plan_version_id uuid;
  v_subscription_id uuid;
BEGIN
  PERFORM private.billing_assert_workspace_billing_admin(
    p_workspace_id,
    p_actor_user_id
  );

  IF p_plan_code NOT IN ('pro', 'team', 'enterprise') THEN
    RAISE EXCEPTION 'SUBSCRIPTION_PLAN_INVALID';
  END IF;
  IF p_billing_period NOT IN ('monthly', 'yearly') THEN
    RAISE EXCEPTION 'SUBSCRIPTION_BILLING_PERIOD_INVALID';
  END IF;
  IF nullif(btrim(p_idempotency_key), '') IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_workspace_id::text, 0)
  );

  PERFORM public.billing_reconcile_local_subscription(p_workspace_id);

  SELECT subscription.*
  INTO v_existing
  FROM public.workspace_billing_subscriptions subscription
  WHERE subscription.workspace_id = p_workspace_id
    AND subscription.activation_idempotency_key = p_idempotency_key
  LIMIT 1;

  IF v_existing.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'action', 'idempotent',
      'subscription_id', v_existing.id,
      'plan_version_id', v_existing.plan_version_id,
      'billing_period', v_existing.billing_period,
      'current_period_start', v_existing.current_period_start,
      'current_period_end', v_existing.current_period_end,
      'credit_period_start', v_existing.credit_period_start,
      'credit_period_end', v_existing.credit_period_end,
      'cancel_at_period_end', v_existing.cancel_at_period_end,
      'canceled_at', v_existing.canceled_at,
      'provider', v_existing.provider
    );
  END IF;

  SELECT version.id
  INTO v_plan_version_id
  FROM public.billing_plans plan
  JOIN public.billing_plan_versions version
    ON version.plan_id = plan.id
    AND version.status = 'published'
  WHERE plan.code = p_plan_code
    AND plan.is_active
    AND plan.is_public
  LIMIT 1;

  IF v_plan_version_id IS NULL THEN
    RAISE EXCEPTION 'SUBSCRIPTION_PLAN_UNAVAILABLE';
  END IF;

  SELECT subscription.*
  INTO v_current
  FROM public.workspace_billing_subscriptions subscription
  WHERE subscription.workspace_id = p_workspace_id
    AND subscription.status IN ('trialing', 'active', 'past_due', 'canceled')
  ORDER BY subscription.created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_current.id IS NOT NULL
    AND v_current.provider IS NOT NULL
    AND v_current.provider <> 'local'
  THEN
    RAISE EXCEPTION 'SUBSCRIPTION_MANAGED_EXTERNALLY';
  END IF;

  IF v_current.id IS NOT NULL
    AND v_current.plan_version_id = v_plan_version_id
    AND v_current.billing_period = p_billing_period
  THEN
    IF v_current.cancel_at_period_end OR v_current.canceled_at IS NOT NULL THEN
      UPDATE public.workspace_billing_subscriptions
      SET cancel_at_period_end = false,
          canceled_at = NULL,
          status = 'active',
          updated_at = v_now,
          metadata = metadata || jsonb_build_object(
            'last_resumed_at', v_now,
            'last_resumed_by', p_actor_user_id
          )
      WHERE id = v_current.id;
      v_action := 'resumed';

      PERFORM private.billing_sync_legacy_subscription_projection(
        p_workspace_id,
        p_plan_code,
        p_billing_period,
        v_current.current_period_start,
        v_current.current_period_end,
        NULL
      );
    ELSE
      v_action := 'unchanged';
    END IF;

    RETURN jsonb_build_object(
      'action', v_action,
      'subscription_id', v_current.id,
      'plan_version_id', v_current.plan_version_id,
      'billing_period', v_current.billing_period,
      'current_period_start', v_current.current_period_start,
      'current_period_end', v_current.current_period_end,
      'credit_period_start', v_current.credit_period_start,
      'credit_period_end', v_current.credit_period_end,
      'cancel_at_period_end', false,
      'canceled_at', NULL,
      'provider', 'local',
      'grant', jsonb_build_object('created', false, 'credits', 0)
    );
  END IF;

  IF v_current.id IS NOT NULL THEN
    PERFORM private.billing_expire_subscription_credits(
      p_workspace_id,
      v_current.id,
      '切换套餐，原套餐剩余点数失效',
      'subscription:' || v_current.id::text || ':plan-change:' || p_idempotency_key
    );

    UPDATE public.workspace_billing_subscriptions
    SET status = 'expired',
        current_period_end = least(coalesce(current_period_end, v_now), v_now),
        updated_at = v_now,
        metadata = metadata || jsonb_build_object(
          'changed_at', v_now,
          'changed_by', p_actor_user_id,
          'changed_to_plan_code', p_plan_code
        )
    WHERE id = v_current.id;
    v_action := 'changed';
  END IF;

  v_period_end := CASE p_billing_period
    WHEN 'yearly' THEN v_now + interval '1 year'
    ELSE v_now + interval '1 month'
  END;
  v_credit_end := least(v_now + interval '1 month', v_period_end);

  INSERT INTO public.workspace_billing_subscriptions (
    workspace_id,
    plan_version_id,
    status,
    billing_period,
    provider,
    provider_subscription_id,
    current_period_start,
    current_period_end,
    credit_period_start,
    credit_period_end,
    cancel_at_period_end,
    canceled_at,
    activation_idempotency_key,
    metadata
  ) VALUES (
    p_workspace_id,
    v_plan_version_id,
    'active',
    p_billing_period,
    'local',
    'local:' || gen_random_uuid()::text,
    v_now,
    v_period_end,
    v_now,
    v_credit_end,
    false,
    NULL,
    p_idempotency_key,
    jsonb_build_object(
      'source', 'local_subscription_simulator',
      'activated_by', p_actor_user_id,
      'activated_at', v_now
    )
  )
  RETURNING id INTO v_subscription_id;

  v_grant := private.billing_grant_subscription_period(
    p_workspace_id,
    v_subscription_id,
    v_plan_version_id,
    v_now,
    v_credit_end
  );

  PERFORM private.billing_sync_legacy_subscription_projection(
    p_workspace_id,
    p_plan_code,
    p_billing_period,
    v_now,
    v_period_end,
    NULL
  );

  RETURN jsonb_build_object(
    'action', v_action,
    'subscription_id', v_subscription_id,
    'plan_version_id', v_plan_version_id,
    'plan_code', p_plan_code,
    'billing_period', p_billing_period,
    'current_period_start', v_now,
    'current_period_end', v_period_end,
    'credit_period_start', v_now,
    'credit_period_end', v_credit_end,
    'cancel_at_period_end', false,
    'canceled_at', NULL,
    'provider', 'local',
    'grant', v_grant
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_local_cancel_subscription(
  p_workspace_id uuid,
  p_actor_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_plan_code text;
  v_subscription public.workspace_billing_subscriptions;
BEGIN
  PERFORM private.billing_assert_workspace_billing_admin(
    p_workspace_id,
    p_actor_user_id
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_workspace_id::text, 0)
  );
  PERFORM public.billing_reconcile_local_subscription(p_workspace_id);

  SELECT subscription.*
  INTO v_subscription
  FROM public.workspace_billing_subscriptions subscription
  WHERE subscription.workspace_id = p_workspace_id
    AND subscription.status IN ('trialing', 'active', 'past_due', 'canceled')
  ORDER BY subscription.created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_subscription.id IS NULL THEN
    RAISE EXCEPTION 'SUBSCRIPTION_NOT_FOUND';
  END IF;
  IF v_subscription.provider <> 'local' THEN
    RAISE EXCEPTION 'SUBSCRIPTION_MANAGED_EXTERNALLY';
  END IF;

  SELECT plan.code
  INTO v_plan_code
  FROM public.billing_plan_versions version
  JOIN public.billing_plans plan ON plan.id = version.plan_id
  WHERE version.id = v_subscription.plan_version_id;

  UPDATE public.workspace_billing_subscriptions
  SET cancel_at_period_end = true,
      canceled_at = coalesce(canceled_at, v_now),
      updated_at = v_now,
      metadata = metadata || jsonb_build_object(
        'cancel_requested_at', v_now,
        'cancel_requested_by', p_actor_user_id
      )
  WHERE id = v_subscription.id;

  PERFORM private.billing_sync_legacy_subscription_projection(
    p_workspace_id,
    v_plan_code,
    v_subscription.billing_period,
    v_subscription.current_period_start,
    v_subscription.current_period_end,
    coalesce(v_subscription.canceled_at, v_now)
  );

  RETURN jsonb_build_object(
    'action', CASE WHEN v_subscription.cancel_at_period_end THEN 'unchanged' ELSE 'canceled' END,
    'subscription_id', v_subscription.id,
    'plan_code', v_plan_code,
    'billing_period', v_subscription.billing_period,
    'current_period_start', v_subscription.current_period_start,
    'current_period_end', v_subscription.current_period_end,
    'credit_period_start', v_subscription.credit_period_start,
    'credit_period_end', v_subscription.credit_period_end,
    'cancel_at_period_end', true,
    'canceled_at', coalesce(v_subscription.canceled_at, v_now),
    'provider', 'local'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_local_resume_subscription(
  p_workspace_id uuid,
  p_actor_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan_code text;
  v_subscription public.workspace_billing_subscriptions;
BEGIN
  PERFORM private.billing_assert_workspace_billing_admin(
    p_workspace_id,
    p_actor_user_id
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_workspace_id::text, 0)
  );
  PERFORM public.billing_reconcile_local_subscription(p_workspace_id);

  SELECT subscription.*
  INTO v_subscription
  FROM public.workspace_billing_subscriptions subscription
  WHERE subscription.workspace_id = p_workspace_id
    AND subscription.provider = 'local'
    AND subscription.status IN ('trialing', 'active', 'past_due', 'canceled')
  ORDER BY subscription.created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_subscription.id IS NULL THEN
    RAISE EXCEPTION 'SUBSCRIPTION_NOT_FOUND';
  END IF;

  SELECT plan.code
  INTO v_plan_code
  FROM public.billing_plan_versions version
  JOIN public.billing_plans plan ON plan.id = version.plan_id
  WHERE version.id = v_subscription.plan_version_id;

  UPDATE public.workspace_billing_subscriptions
  SET cancel_at_period_end = false,
      canceled_at = NULL,
      status = 'active',
      updated_at = now(),
      metadata = metadata || jsonb_build_object(
        'last_resumed_at', now(),
        'last_resumed_by', p_actor_user_id
      )
  WHERE id = v_subscription.id;

  PERFORM private.billing_sync_legacy_subscription_projection(
    p_workspace_id,
    v_plan_code,
    v_subscription.billing_period,
    v_subscription.current_period_start,
    v_subscription.current_period_end,
    NULL
  );

  RETURN jsonb_build_object(
    'action', CASE WHEN v_subscription.cancel_at_period_end THEN 'resumed' ELSE 'unchanged' END,
    'subscription_id', v_subscription.id,
    'plan_code', v_plan_code,
    'billing_period', v_subscription.billing_period,
    'current_period_start', v_subscription.current_period_start,
    'current_period_end', v_subscription.current_period_end,
    'credit_period_start', v_subscription.credit_period_start,
    'credit_period_end', v_subscription.credit_period_end,
    'cancel_at_period_end', false,
    'canceled_at', NULL,
    'provider', 'local'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_local_get_subscription_status(
  p_workspace_id uuid,
  p_actor_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.workspace_members member
    WHERE member.workspace_id = p_workspace_id
      AND member.user_id = p_actor_user_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'SUBSCRIPTION_WORKSPACE_ACCESS_DENIED';
  END IF;

  PERFORM public.billing_reconcile_local_subscription(p_workspace_id);

  SELECT jsonb_build_object(
    'plan', plan.code,
    'planName', plan.name_zh,
    'billingPeriod', subscription.billing_period,
    'status', subscription.status,
    'provider', subscription.provider,
    'currentPeriodStart', subscription.current_period_start,
    'currentPeriodEnd', subscription.current_period_end,
    'creditPeriodStart', subscription.credit_period_start,
    'creditPeriodEnd', subscription.credit_period_end,
    'cancelAtPeriodEnd', subscription.cancel_at_period_end,
    'canceledAt', subscription.canceled_at,
    'monthlyCredits', version.monthly_subscription_credits,
    'currency', version.currency,
    'customerPortalUrl', NULL,
    'lemonSqueezySubscriptionId', NULL
  )
  INTO v_result
  FROM public.workspace_billing_subscriptions subscription
  JOIN public.billing_plan_versions version ON version.id = subscription.plan_version_id
  JOIN public.billing_plans plan ON plan.id = version.plan_id
  WHERE subscription.workspace_id = p_workspace_id
    AND subscription.status IN ('trialing', 'active', 'past_due', 'canceled')
    AND (
      subscription.current_period_end IS NULL
      OR subscription.current_period_end > now()
    )
  ORDER BY subscription.created_at DESC
  LIMIT 1;

  IF v_result IS NOT NULL THEN
    RETURN v_result;
  END IF;

  SELECT jsonb_build_object(
    'plan', plan.code,
    'planName', plan.name_zh,
    'billingPeriod', NULL,
    'status', 'active',
    'provider', NULL,
    'currentPeriodStart', NULL,
    'currentPeriodEnd', NULL,
    'creditPeriodStart', NULL,
    'creditPeriodEnd', NULL,
    'cancelAtPeriodEnd', false,
    'canceledAt', NULL,
    'monthlyCredits', version.monthly_subscription_credits,
    'currency', version.currency,
    'customerPortalUrl', NULL,
    'lemonSqueezySubscriptionId', NULL
  )
  INTO v_result
  FROM public.billing_plans plan
  JOIN public.billing_plan_versions version
    ON version.plan_id = plan.id
    AND version.status = 'published'
  WHERE plan.code = 'free'
  LIMIT 1;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'FREE_BILLING_PLAN_UNAVAILABLE';
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.billing_reconcile_local_subscription(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_local_activate_subscription(uuid, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_local_cancel_subscription(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_local_resume_subscription(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_local_get_subscription_status(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.billing_reconcile_local_subscription(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_local_activate_subscription(uuid, uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_local_cancel_subscription(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_local_resume_subscription(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_local_get_subscription_status(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.billing_local_activate_subscription(uuid, uuid, text, text, text) IS
  'Development-only subscription activation. Atomically changes the versioned subscription, replaces subscription credit lots, and updates the legacy projection.';
COMMENT ON FUNCTION public.billing_reconcile_local_subscription(uuid) IS
  'Lazily renews local subscription and credit periods or expires a canceled subscription.';
