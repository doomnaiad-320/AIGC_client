-- Idempotent Lemon Squeezy webhook processing backed by the canonical billing
-- subscription projection and source-aware credit ledger.

ALTER TABLE public.payment_events
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS provider_event_id text,
  ADD COLUMN IF NOT EXISTS provider_resource_id text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE public.payment_events
SET provider = coalesce(provider, 'lemon_squeezy'),
    provider_event_id = coalesce(provider_event_id, 'legacy:' || id::text),
    provider_resource_id = coalesce(provider_resource_id, lemon_squeezy_event_id),
    status = coalesce(
      status,
      CASE
        WHEN processed THEN 'processed'
        WHEN error_message IS NOT NULL THEN 'failed'
        ELSE 'failed'
      END
    ),
    attempt_count = greatest(attempt_count, 1),
    processed_at = CASE
      WHEN processed THEN coalesce(processed_at, created_at)
      ELSE processed_at
    END,
    updated_at = coalesce(updated_at, created_at);

ALTER TABLE public.payment_events
  ALTER COLUMN provider SET NOT NULL,
  ALTER COLUMN provider_event_id SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ADD CONSTRAINT payment_events_status_check
    CHECK (status IN ('processing', 'processed', 'failed')),
  ADD CONSTRAINT payment_events_attempt_count_check
    CHECK (attempt_count >= 1);

CREATE UNIQUE INDEX payment_events_provider_event_unique_idx
  ON public.payment_events(provider, provider_event_id);
CREATE INDEX payment_events_status_updated_idx
  ON public.payment_events(status, updated_at DESC);
CREATE INDEX payment_events_resource_idx
  ON public.payment_events(provider, provider_resource_id, created_at DESC)
  WHERE provider_resource_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.payment_claim_webhook_event(
  p_provider text,
  p_provider_event_id text,
  p_event_name text,
  p_provider_resource_id text,
  p_workspace_id uuid,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event public.payment_events;
BEGIN
  IF nullif(btrim(p_provider), '') IS NULL
    OR nullif(btrim(p_provider_event_id), '') IS NULL
    OR nullif(btrim(p_event_name), '') IS NULL
  THEN
    RAISE EXCEPTION 'PAYMENT_WEBHOOK_IDENTITY_REQUIRED';
  END IF;

  INSERT INTO public.payment_events (
    provider,
    provider_event_id,
    provider_resource_id,
    event_name,
    lemon_squeezy_event_id,
    workspace_id,
    payload,
    processed,
    status,
    attempt_count,
    processing_started_at,
    processed_at,
    error_message,
    updated_at
  ) VALUES (
    p_provider,
    p_provider_event_id,
    p_provider_resource_id,
    p_event_name,
    CASE WHEN p_provider = 'lemon_squeezy' THEN p_provider_resource_id ELSE NULL END,
    p_workspace_id,
    coalesce(p_payload, '{}'::jsonb),
    false,
    'processing',
    1,
    now(),
    NULL,
    NULL,
    now()
  )
  ON CONFLICT (provider, provider_event_id) DO UPDATE
  SET provider_resource_id = EXCLUDED.provider_resource_id,
      event_name = EXCLUDED.event_name,
      lemon_squeezy_event_id = EXCLUDED.lemon_squeezy_event_id,
      workspace_id = coalesce(EXCLUDED.workspace_id, payment_events.workspace_id),
      payload = EXCLUDED.payload,
      processed = false,
      status = 'processing',
      attempt_count = payment_events.attempt_count + 1,
      processing_started_at = now(),
      processed_at = NULL,
      error_message = NULL,
      updated_at = now()
  WHERE payment_events.status = 'failed'
     OR (
       payment_events.status = 'processing'
       AND payment_events.processing_started_at < now() - interval '5 minutes'
     )
  RETURNING * INTO v_event;

  IF v_event.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'claimed', true,
      'eventId', v_event.id,
      'status', v_event.status,
      'attemptCount', v_event.attempt_count
    );
  END IF;

  SELECT event.*
  INTO v_event
  FROM public.payment_events event
  WHERE event.provider = p_provider
    AND event.provider_event_id = p_provider_event_id;

  RETURN jsonb_build_object(
    'claimed', false,
    'eventId', v_event.id,
    'status', v_event.status,
    'attemptCount', v_event.attempt_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.payment_fail_webhook_event(
  p_provider text,
  p_provider_event_id text,
  p_error_message text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated_count integer;
BEGIN
  UPDATE public.payment_events
  SET processed = false,
      status = 'failed',
      error_message = left(coalesce(nullif(p_error_message, ''), 'Unknown processing error'), 4000),
      processed_at = NULL,
      updated_at = now()
  WHERE provider = p_provider
    AND provider_event_id = p_provider_event_id
    AND status = 'processing';

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  RETURN v_updated_count > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_process_lemon_squeezy_webhook(
  p_provider_event_id text,
  p_event_name text,
  p_workspace_id uuid,
  p_provider_subscription_id text,
  p_provider_customer_id text,
  p_provider_variant_id text,
  p_provider_order_id text,
  p_plan_code text,
  p_billing_period text,
  p_provider_status text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_canceled_at timestamptz,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_credit_end timestamptz;
  v_credit_start timestamptz;
  v_current public.workspace_billing_subscriptions;
  v_event public.payment_events;
  v_grant jsonb := jsonb_build_object('created', false, 'credits', 0);
  v_now timestamptz := now();
  v_period_end timestamptz;
  v_period_start timestamptz;
  v_plan_code text;
  v_plan_version_id uuid;
  v_status text;
  v_subscription public.workspace_billing_subscriptions;
  v_subscription_id uuid;
  v_workspace_id uuid;
BEGIN
  SELECT event.*
  INTO v_event
  FROM public.payment_events event
  WHERE event.provider = 'lemon_squeezy'
    AND event.provider_event_id = p_provider_event_id
  FOR UPDATE;

  IF v_event.id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_WEBHOOK_EVENT_NOT_CLAIMED';
  END IF;
  IF v_event.status = 'processed' THEN
    RETURN jsonb_build_object('processed', false, 'duplicate', true);
  END IF;
  IF v_event.status <> 'processing' THEN
    RAISE EXCEPTION 'PAYMENT_WEBHOOK_EVENT_NOT_PROCESSING';
  END IF;

  IF p_event_name NOT IN (
    'subscription_created',
    'subscription_updated',
    'subscription_cancelled',
    'subscription_payment_success',
    'subscription_payment_failed',
    'subscription_expired'
  ) THEN
    UPDATE public.payment_events
    SET processed = true,
        status = 'processed',
        processed_at = v_now,
        error_message = NULL,
        updated_at = v_now
    WHERE id = v_event.id;

    RETURN jsonb_build_object('processed', true, 'action', 'ignored');
  END IF;

  IF nullif(btrim(p_provider_subscription_id), '') IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_SUBSCRIPTION_ID_REQUIRED';
  END IF;

  v_workspace_id := p_workspace_id;
  IF v_workspace_id IS NULL THEN
    SELECT subscription.workspace_id
    INTO v_workspace_id
    FROM public.workspace_billing_subscriptions subscription
    WHERE subscription.provider = 'lemon_squeezy'
      AND subscription.provider_subscription_id = p_provider_subscription_id
    LIMIT 1;
  END IF;
  IF v_workspace_id IS NULL THEN
    SELECT subscription.workspace_id
    INTO v_workspace_id
    FROM public.subscriptions subscription
    WHERE subscription.lemon_squeezy_subscription_id = p_provider_subscription_id
    LIMIT 1;
  END IF;
  IF v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_WORKSPACE_NOT_FOUND';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_workspace_id::text, 0)
  );

  UPDATE public.payment_events
  SET workspace_id = v_workspace_id,
      updated_at = v_now
  WHERE id = v_event.id;

  SELECT subscription.*
  INTO v_subscription
  FROM public.workspace_billing_subscriptions subscription
  WHERE subscription.provider = 'lemon_squeezy'
    AND subscription.provider_subscription_id = p_provider_subscription_id
  LIMIT 1
  FOR UPDATE;

  IF p_event_name <> 'subscription_expired' THEN
    IF p_plan_code NOT IN ('pro', 'team', 'enterprise') THEN
      RAISE EXCEPTION 'PAYMENT_PLAN_UNRESOLVED';
    END IF;
    IF p_billing_period NOT IN ('monthly', 'yearly') THEN
      RAISE EXCEPTION 'PAYMENT_BILLING_PERIOD_UNRESOLVED';
    END IF;

    SELECT version.id
    INTO v_plan_version_id
    FROM public.billing_plans plan
    JOIN public.billing_plan_versions version
      ON version.plan_id = plan.id
     AND version.status = 'published'
    WHERE plan.code = p_plan_code
      AND plan.is_active
    LIMIT 1;

    IF v_plan_version_id IS NULL THEN
      RAISE EXCEPTION 'PAYMENT_PLAN_VERSION_UNAVAILABLE';
    END IF;
  ELSE
    v_plan_version_id := v_subscription.plan_version_id;
  END IF;

  v_period_start := coalesce(
    p_period_start,
    v_subscription.current_period_start,
    v_now
  );
  v_period_end := coalesce(
    p_period_end,
    v_subscription.current_period_end,
    CASE p_billing_period
      WHEN 'yearly' THEN v_period_start + interval '1 year'
      ELSE v_period_start + interval '1 month'
    END
  );
  IF v_period_end < v_period_start THEN
    RAISE EXCEPTION 'PAYMENT_SUBSCRIPTION_PERIOD_INVALID';
  END IF;

  v_status := CASE p_event_name
    WHEN 'subscription_cancelled' THEN 'canceled'
    WHEN 'subscription_payment_failed' THEN 'past_due'
    WHEN 'subscription_expired' THEN 'expired'
    ELSE CASE lower(coalesce(p_provider_status, 'active'))
      WHEN 'past_due' THEN 'past_due'
      WHEN 'unpaid' THEN 'past_due'
      WHEN 'cancelled' THEN 'canceled'
      WHEN 'canceled' THEN 'canceled'
      WHEN 'expired' THEN 'expired'
      ELSE 'active'
    END
  END;

  IF v_subscription.id IS NULL THEN
    SELECT subscription.*
    INTO v_current
    FROM public.workspace_billing_subscriptions subscription
    WHERE subscription.workspace_id = v_workspace_id
      AND subscription.status IN ('trialing', 'active', 'past_due', 'canceled')
    ORDER BY subscription.created_at DESC
    LIMIT 1
    FOR UPDATE;

    IF v_current.id IS NOT NULL THEN
      PERFORM private.billing_expire_subscription_credits(
        v_workspace_id,
        v_current.id,
        '启用真实支付订阅，原套餐剩余点数失效',
        'subscription:' || v_current.id::text || ':provider-replaced:' || p_provider_event_id
      );
      UPDATE public.workspace_billing_subscriptions
      SET status = 'expired',
          current_period_end = least(coalesce(current_period_end, v_now), v_now),
          updated_at = v_now,
          metadata = metadata || jsonb_build_object(
            'replaced_by_provider', 'lemon_squeezy',
            'replaced_at', v_now
          )
      WHERE id = v_current.id;
    END IF;

    IF p_event_name = 'subscription_expired' THEN
      RAISE EXCEPTION 'PAYMENT_SUBSCRIPTION_NOT_FOUND';
    END IF;

    v_credit_start := v_period_start;
    v_credit_end := least(v_credit_start + interval '1 month', v_period_end);

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
      cancel_at_period_end,
      canceled_at,
      metadata
    ) VALUES (
      v_workspace_id,
      v_plan_version_id,
      v_status,
      p_billing_period,
      'lemon_squeezy',
      p_provider_customer_id,
      p_provider_subscription_id,
      v_period_start,
      v_period_end,
      v_credit_start,
      v_credit_end,
      coalesce(p_cancel_at_period_end, false),
      p_canceled_at,
      jsonb_build_object(
        'provider_variant_id', p_provider_variant_id,
        'provider_order_id', p_provider_order_id,
        'last_provider_event_id', p_provider_event_id,
        'last_provider_event_name', p_event_name,
        'provider_payload', coalesce(p_payload, '{}'::jsonb)
      )
    )
    RETURNING id INTO v_subscription_id;
  ELSE
    v_subscription_id := v_subscription.id;

    IF v_subscription.plan_version_id IS DISTINCT FROM v_plan_version_id
      AND p_event_name IN ('subscription_updated', 'subscription_payment_success')
    THEN
      PERFORM private.billing_expire_subscription_credits(
        v_workspace_id,
        v_subscription.id,
        '支付平台切换套餐，原套餐剩余点数失效',
        'subscription:' || v_subscription.id::text || ':provider-plan-change:' || p_provider_event_id
      );
    END IF;

    v_credit_start := CASE
      WHEN p_event_name = 'subscription_payment_success' THEN v_period_start
      ELSE coalesce(v_subscription.credit_period_start, v_period_start)
    END;
    v_credit_end := CASE
      WHEN p_event_name = 'subscription_payment_success'
        THEN least(v_credit_start + interval '1 month', v_period_end)
      ELSE coalesce(
        v_subscription.credit_period_end,
        least(v_credit_start + interval '1 month', v_period_end)
      )
    END;

    UPDATE public.workspace_billing_subscriptions
    SET plan_version_id = coalesce(v_plan_version_id, plan_version_id),
        status = v_status,
        billing_period = coalesce(p_billing_period, billing_period),
        provider_customer_id = coalesce(p_provider_customer_id, provider_customer_id),
        current_period_start = v_period_start,
        current_period_end = v_period_end,
        credit_period_start = v_credit_start,
        credit_period_end = v_credit_end,
        cancel_at_period_end = coalesce(p_cancel_at_period_end, cancel_at_period_end),
        canceled_at = CASE
          WHEN p_event_name IN ('subscription_created', 'subscription_payment_success') THEN NULL
          ELSE coalesce(p_canceled_at, canceled_at)
        END,
        metadata = metadata || jsonb_build_object(
          'provider_variant_id', p_provider_variant_id,
          'provider_order_id', p_provider_order_id,
          'last_provider_event_id', p_provider_event_id,
          'last_provider_event_name', p_event_name,
          'provider_payload', coalesce(p_payload, '{}'::jsonb)
        ),
        updated_at = v_now
    WHERE id = v_subscription.id;
  END IF;

  IF p_event_name = 'subscription_payment_success' THEN
    v_grant := private.billing_grant_subscription_period(
      v_workspace_id,
      v_subscription_id,
      v_plan_version_id,
      v_credit_start,
      v_credit_end
    );

    IF coalesce((v_grant ->> 'created')::boolean, false) THEN
      UPDATE public.credit_grant_batches
      SET metadata = metadata || jsonb_build_object('provider', 'lemon_squeezy')
      WHERE id = (v_grant ->> 'grant_batch_id')::uuid;

      UPDATE public.credit_ledger
      SET metadata = metadata || jsonb_build_object('provider', 'lemon_squeezy')
      WHERE id = (v_grant ->> 'ledger_id')::uuid;

      UPDATE public.credit_transactions
      SET metadata = metadata || jsonb_build_object('provider', 'lemon_squeezy')
      WHERE metadata ->> 'credit_ledger_id' = (v_grant ->> 'ledger_id');
    END IF;
  END IF;

  IF p_event_name = 'subscription_expired' THEN
    PERFORM private.billing_expire_subscription_credits(
      v_workspace_id,
      v_subscription_id,
      '真实支付订阅已到期，剩余套餐点数失效',
      'subscription:' || v_subscription_id::text || ':provider-expired:' || p_provider_event_id
    );

    INSERT INTO public.subscriptions (
      workspace_id,
      plan,
      billing_period,
      current_period_start,
      current_period_end,
      canceled_at,
      updated_at
    ) VALUES (
      v_workspace_id,
      'free',
      NULL,
      NULL,
      NULL,
      NULL,
      v_now
    )
    ON CONFLICT (workspace_id) DO UPDATE
    SET plan = 'free',
        billing_period = NULL,
        stripe_customer_id = NULL,
        stripe_subscription_id = NULL,
        lemon_squeezy_customer_id = NULL,
        lemon_squeezy_subscription_id = NULL,
        lemon_squeezy_variant_id = NULL,
        lemon_squeezy_order_id = NULL,
        current_period_start = NULL,
        current_period_end = NULL,
        canceled_at = NULL,
        updated_at = v_now;
  ELSE
    v_plan_code := p_plan_code;
    INSERT INTO public.subscriptions (
      workspace_id,
      plan,
      billing_period,
      lemon_squeezy_subscription_id,
      lemon_squeezy_customer_id,
      lemon_squeezy_variant_id,
      lemon_squeezy_order_id,
      current_period_start,
      current_period_end,
      canceled_at,
      updated_at
    ) VALUES (
      v_workspace_id,
      private.billing_legacy_plan_code(v_plan_code),
      p_billing_period::public.billing_period,
      p_provider_subscription_id,
      p_provider_customer_id,
      p_provider_variant_id,
      p_provider_order_id,
      v_period_start,
      v_period_end,
      p_canceled_at,
      v_now
    )
    ON CONFLICT (workspace_id) DO UPDATE
    SET plan = EXCLUDED.plan,
        billing_period = EXCLUDED.billing_period,
        stripe_customer_id = NULL,
        stripe_subscription_id = NULL,
        lemon_squeezy_subscription_id = EXCLUDED.lemon_squeezy_subscription_id,
        lemon_squeezy_customer_id = EXCLUDED.lemon_squeezy_customer_id,
        lemon_squeezy_variant_id = EXCLUDED.lemon_squeezy_variant_id,
        lemon_squeezy_order_id = EXCLUDED.lemon_squeezy_order_id,
        current_period_start = EXCLUDED.current_period_start,
        current_period_end = EXCLUDED.current_period_end,
        canceled_at = EXCLUDED.canceled_at,
        updated_at = v_now;
  END IF;

  UPDATE public.payment_events
  SET processed = true,
      status = 'processed',
      processed_at = v_now,
      error_message = NULL,
      updated_at = v_now
  WHERE id = v_event.id;

  RETURN jsonb_build_object(
    'processed', true,
    'action', p_event_name,
    'workspaceId', v_workspace_id,
    'subscriptionId', v_subscription_id,
    'grant', v_grant
  );
END;
$$;

REVOKE ALL ON FUNCTION public.payment_claim_webhook_event(text, text, text, text, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_fail_webhook_event(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_process_lemon_squeezy_webhook(
  text, text, uuid, text, text, text, text, text, text, text,
  timestamptz, timestamptz, boolean, timestamptz, jsonb
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.payment_claim_webhook_event(text, text, text, text, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.payment_fail_webhook_event(text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_process_lemon_squeezy_webhook(
  text, text, uuid, text, text, text, text, text, text, text,
  timestamptz, timestamptz, boolean, timestamptz, jsonb
) TO service_role;
