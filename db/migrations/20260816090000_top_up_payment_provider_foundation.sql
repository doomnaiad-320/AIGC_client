-- Configurable top-up catalog and payment-provider foundation.
-- Canonical product prices remain USD. Provider prices are stored separately
-- so CNY-only gateways such as DuluPay never introduce an implicit FX rate.

ALTER TABLE public.billing_top_up_packs
  ADD COLUMN IF NOT EXISTS description_zh text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;

CREATE TABLE public.payment_provider_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_code text NOT NULL UNIQUE,
  display_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  api_base_url text NOT NULL,
  merchant_id text,
  merchant_private_key_ciphertext text,
  platform_public_key text,
  allowed_methods text[] NOT NULL DEFAULT ARRAY['alipay', 'wxpay']::text[],
  callback_tolerance_seconds integer NOT NULL DEFAULT 86400,
  updated_by uuid REFERENCES public.app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_provider_configs_provider_check
    CHECK (provider_code = 'dulupay'),
  CONSTRAINT payment_provider_configs_display_name_check
    CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 100),
  CONSTRAINT payment_provider_configs_api_url_check
    CHECK (api_base_url ~ '^https://'),
  CONSTRAINT payment_provider_configs_methods_check
    CHECK (
      cardinality(allowed_methods) > 0
      AND allowed_methods <@ ARRAY['alipay', 'wxpay']::text[]
    ),
  CONSTRAINT payment_provider_configs_callback_tolerance_check
    CHECK (callback_tolerance_seconds BETWEEN 60 AND 604800)
);

CREATE TABLE public.billing_top_up_pack_provider_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  top_up_pack_id uuid NOT NULL
    REFERENCES public.billing_top_up_packs(id) ON DELETE CASCADE,
  provider_code text NOT NULL
    REFERENCES public.payment_provider_configs(provider_code) ON DELETE RESTRICT,
  currency text NOT NULL,
  amount_minor integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_top_up_pack_provider_prices_unique
    UNIQUE (top_up_pack_id, provider_code),
  CONSTRAINT billing_top_up_pack_provider_prices_currency_check
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT billing_top_up_pack_provider_prices_amount_check
    CHECK (amount_minor > 0),
  CONSTRAINT billing_top_up_pack_provider_prices_dulupay_currency_check
    CHECK (provider_code <> 'dulupay' OR currency = 'CNY')
);

ALTER TABLE public.billing_payment_orders
  ADD COLUMN IF NOT EXISTS provider_currency text,
  ADD COLUMN IF NOT EXISTS provider_amount_minor integer,
  ADD COLUMN IF NOT EXISTS provider_payment_method text,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.app_users(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'billing_payment_orders_provider_amount_check'
      AND conrelid = 'public.billing_payment_orders'::regclass
  ) THEN
    ALTER TABLE public.billing_payment_orders
      ADD CONSTRAINT billing_payment_orders_provider_amount_check
      CHECK (
        (provider_currency IS NULL AND provider_amount_minor IS NULL)
        OR (
          provider_currency ~ '^[A-Z]{3}$'
          AND provider_amount_minor IS NOT NULL
          AND provider_amount_minor > 0
        )
      );
  END IF;
END
$$;

CREATE INDEX billing_payment_orders_provider_status_created_idx
  ON public.billing_payment_orders(provider, status, created_at DESC);

CREATE INDEX billing_top_up_pack_provider_prices_provider_idx
  ON public.billing_top_up_pack_provider_prices(provider_code, top_up_pack_id);

ALTER TABLE public.payment_provider_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_top_up_pack_provider_prices ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.payment_provider_configs FROM PUBLIC;
REVOKE ALL ON public.billing_top_up_pack_provider_prices FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.payment_provider_configs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.billing_top_up_pack_provider_prices TO service_role;

INSERT INTO public.payment_provider_configs (
  provider_code,
  display_name,
  enabled,
  api_base_url,
  allowed_methods
) VALUES (
  'dulupay',
  'DuluPay',
  false,
  'https://api.dulupay.com/api',
  ARRAY['alipay', 'wxpay']::text[]
)
ON CONFLICT (provider_code) DO NOTHING;

CREATE OR REPLACE FUNCTION public.prevent_published_top_up_provider_price_changes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_pack_status text;
BEGIN
  SELECT status
  INTO v_pack_status
  FROM public.billing_top_up_packs
  WHERE id = coalesce(NEW.top_up_pack_id, OLD.top_up_pack_id);

  IF v_pack_status IN ('published', 'retired') THEN
    RAISE EXCEPTION 'PUBLISHED_TOP_UP_PACK_IMMUTABLE';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_prevent_published_top_up_provider_price_changes
  BEFORE UPDATE OR DELETE ON public.billing_top_up_pack_provider_prices
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_published_top_up_provider_price_changes();

CREATE OR REPLACE FUNCTION public.admin_save_top_up_pack_draft(
  p_actor_user_id uuid,
  p_code text,
  p_name_zh text,
  p_description_zh text,
  p_credits integer,
  p_price_minor integer,
  p_minimum_plan_code text,
  p_sort_order integer,
  p_dulupay_amount_minor integer,
  p_reason text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pack_id uuid;
  v_reason text := nullif(btrim(p_reason), '');
  v_version integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_admins WHERE user_id = p_actor_user_id
  ) THEN
    RAISE EXCEPTION 'PLATFORM_ADMIN_REQUIRED';
  END IF;

  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'ADMIN_REASON_REQUIRED';
  END IF;
  IF p_code !~ '^[a-z][a-z0-9_-]{1,49}$' THEN
    RAISE EXCEPTION 'TOP_UP_PACK_CODE_INVALID';
  END IF;
  IF char_length(btrim(p_name_zh)) NOT BETWEEN 1 AND 100
    OR p_credits <= 0
    OR p_price_minor <= 0
    OR p_minimum_plan_code NOT IN ('pro', 'team')
    OR p_dulupay_amount_minor IS NULL
    OR p_dulupay_amount_minor <= 0
  THEN
    RAISE EXCEPTION 'TOP_UP_PACK_VALUES_INVALID';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('top-up-pack:' || p_code, 0));

  SELECT id
  INTO v_pack_id
  FROM public.billing_top_up_packs
  WHERE code = p_code AND status = 'draft'
  FOR UPDATE;

  IF v_pack_id IS NULL THEN
    SELECT coalesce(max(version), 0) + 1
    INTO v_version
    FROM public.billing_top_up_packs
    WHERE code = p_code;

    INSERT INTO public.billing_top_up_packs (
      code,
      version,
      name_zh,
      description_zh,
      credits,
      currency,
      price_minor,
      status,
      minimum_plan_code,
      sort_order
    ) VALUES (
      p_code,
      v_version,
      btrim(p_name_zh),
      coalesce(btrim(p_description_zh), ''),
      p_credits,
      'USD',
      p_price_minor,
      'draft',
      p_minimum_plan_code,
      p_sort_order
    )
    RETURNING id INTO v_pack_id;
  ELSE
    UPDATE public.billing_top_up_packs
    SET name_zh = btrim(p_name_zh),
        description_zh = coalesce(btrim(p_description_zh), ''),
        credits = p_credits,
        currency = 'USD',
        price_minor = p_price_minor,
        minimum_plan_code = p_minimum_plan_code,
        sort_order = p_sort_order
    WHERE id = v_pack_id;
  END IF;

  INSERT INTO public.billing_top_up_pack_provider_prices (
    top_up_pack_id,
    provider_code,
    currency,
    amount_minor
  ) VALUES (
    v_pack_id,
    'dulupay',
    'CNY',
    p_dulupay_amount_minor
  )
  ON CONFLICT (top_up_pack_id, provider_code)
  DO UPDATE SET
    currency = EXCLUDED.currency,
    amount_minor = EXCLUDED.amount_minor,
    updated_at = now();

  INSERT INTO public.admin_audit_events (
    actor_user_id,
    action,
    metadata
  ) VALUES (
    p_actor_user_id,
    'billing.top_up_pack_draft.saved',
    jsonb_build_object(
      'top_up_pack_id', v_pack_id,
      'code', p_code,
      'credits', p_credits,
      'usd_price_minor', p_price_minor,
      'dulupay_cny_amount_minor', p_dulupay_amount_minor,
      'reason', v_reason
    )
  );

  RETURN v_pack_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_publish_top_up_pack(
  p_actor_user_id uuid,
  p_code text,
  p_reason text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft_id uuid;
  v_reason text := nullif(btrim(p_reason), '');
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_admins WHERE user_id = p_actor_user_id
  ) THEN
    RAISE EXCEPTION 'PLATFORM_ADMIN_REQUIRED';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'ADMIN_REASON_REQUIRED';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('top-up-pack:' || p_code, 0));

  SELECT id
  INTO v_draft_id
  FROM public.billing_top_up_packs
  WHERE code = p_code AND status = 'draft'
  FOR UPDATE;

  IF v_draft_id IS NULL THEN
    RAISE EXCEPTION 'TOP_UP_PACK_DRAFT_NOT_FOUND';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.billing_top_up_pack_provider_prices
    WHERE top_up_pack_id = v_draft_id
      AND provider_code = 'dulupay'
      AND currency = 'CNY'
      AND amount_minor > 0
  ) THEN
    RAISE EXCEPTION 'TOP_UP_PACK_PROVIDER_PRICE_REQUIRED';
  END IF;

  UPDATE public.billing_top_up_packs
  SET status = 'retired',
      retired_at = now()
  WHERE code = p_code AND status = 'published';

  UPDATE public.billing_top_up_packs
  SET status = 'published',
      published_at = now(),
      retired_at = NULL
  WHERE id = v_draft_id;

  INSERT INTO public.admin_audit_events (
    actor_user_id,
    action,
    metadata
  ) VALUES (
    p_actor_user_id,
    'billing.top_up_pack.published',
    jsonb_build_object(
      'top_up_pack_id', v_draft_id,
      'code', p_code,
      'reason', v_reason
    )
  );

  RETURN v_draft_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_save_payment_provider_config(
  p_actor_user_id uuid,
  p_enabled boolean,
  p_api_base_url text,
  p_merchant_id text,
  p_merchant_private_key_ciphertext text,
  p_replace_private_key boolean,
  p_platform_public_key text,
  p_allowed_methods text[],
  p_callback_tolerance_seconds integer,
  p_reason text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_config_id uuid;
  v_reason text := nullif(btrim(p_reason), '');
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_admins WHERE user_id = p_actor_user_id
  ) THEN
    RAISE EXCEPTION 'PLATFORM_ADMIN_REQUIRED';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'ADMIN_REASON_REQUIRED';
  END IF;
  IF p_api_base_url !~ '^https://'
    OR nullif(btrim(p_merchant_id), '') IS NULL
    OR nullif(btrim(p_platform_public_key), '') IS NULL
    OR cardinality(p_allowed_methods) = 0
    OR NOT (p_allowed_methods <@ ARRAY['alipay', 'wxpay']::text[])
  THEN
    RAISE EXCEPTION 'PAYMENT_PROVIDER_CONFIG_INVALID';
  END IF;

  UPDATE public.payment_provider_configs
  SET enabled = p_enabled,
      api_base_url = regexp_replace(btrim(p_api_base_url), '/+$', ''),
      merchant_id = btrim(p_merchant_id),
      merchant_private_key_ciphertext = CASE
        WHEN p_replace_private_key THEN p_merchant_private_key_ciphertext
        ELSE merchant_private_key_ciphertext
      END,
      platform_public_key = btrim(p_platform_public_key),
      allowed_methods = p_allowed_methods,
      callback_tolerance_seconds = p_callback_tolerance_seconds,
      updated_by = p_actor_user_id,
      updated_at = now()
  WHERE provider_code = 'dulupay'
  RETURNING id INTO v_config_id;

  IF v_config_id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_PROVIDER_NOT_FOUND';
  END IF;

  IF p_enabled AND NOT EXISTS (
    SELECT 1
    FROM public.payment_provider_configs
    WHERE id = v_config_id
      AND merchant_private_key_ciphertext IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PAYMENT_PROVIDER_PRIVATE_KEY_REQUIRED';
  END IF;

  INSERT INTO public.admin_audit_events (
    actor_user_id,
    action,
    metadata
  ) VALUES (
    p_actor_user_id,
    'payments.provider_config.updated',
    jsonb_build_object(
      'provider', 'dulupay',
      'enabled', p_enabled,
      'merchant_id', btrim(p_merchant_id),
      'private_key_replaced', p_replace_private_key,
      'allowed_methods', p_allowed_methods,
      'reason', v_reason
    )
  );

  RETURN v_config_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_create_top_up_order(
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_pack_code text,
  p_provider text,
  p_payment_method text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.billing_payment_orders;
  v_pack public.billing_top_up_packs;
  v_provider_amount integer;
  v_provider_currency text;
  v_plan_code text := 'free';
  v_role text;
BEGIN
  SELECT role::text
  INTO v_role
  FROM public.workspace_members
  WHERE workspace_id = p_workspace_id
    AND user_id = p_actor_user_id;

  IF v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'TOP_UP_WORKSPACE_ADMIN_REQUIRED';
  END IF;
  IF nullif(btrim(p_idempotency_key), '') IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;

  SELECT *
  INTO v_pack
  FROM public.billing_top_up_packs
  WHERE code = p_pack_code AND status = 'published';

  IF v_pack.id IS NULL THEN
    RAISE EXCEPTION 'TOP_UP_PACK_NOT_FOUND';
  END IF;

  IF p_provider <> 'dulupay' OR p_payment_method NOT IN ('alipay', 'wxpay') THEN
    RAISE EXCEPTION 'PAYMENT_METHOD_UNAVAILABLE';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.payment_provider_configs
    WHERE provider_code = p_provider
      AND enabled
      AND p_payment_method = ANY(allowed_methods)
  ) THEN
    RAISE EXCEPTION 'PAYMENT_PROVIDER_UNAVAILABLE';
  END IF;

  SELECT currency, amount_minor
  INTO v_provider_currency, v_provider_amount
  FROM public.billing_top_up_pack_provider_prices
  WHERE top_up_pack_id = v_pack.id
    AND provider_code = p_provider;

  IF v_provider_amount IS NULL THEN
    RAISE EXCEPTION 'TOP_UP_PROVIDER_PRICE_UNAVAILABLE';
  END IF;

  SELECT plan.code
  INTO v_plan_code
  FROM public.workspace_billing_subscriptions subscription
  JOIN public.billing_plan_versions version ON version.id = subscription.plan_version_id
  JOIN public.billing_plans plan ON plan.id = version.plan_id
  WHERE subscription.workspace_id = p_workspace_id
    AND subscription.status IN ('trialing', 'active', 'past_due', 'canceled')
    AND (
      subscription.status <> 'canceled'
      OR subscription.current_period_end IS NULL
      OR subscription.current_period_end > now()
    )
  ORDER BY subscription.created_at DESC
  LIMIT 1;

  v_plan_code := coalesce(v_plan_code, 'free');
  IF (v_pack.minimum_plan_code = 'pro' AND v_plan_code NOT IN ('pro', 'team', 'enterprise'))
    OR (v_pack.minimum_plan_code = 'team' AND v_plan_code NOT IN ('team', 'enterprise'))
  THEN
    RAISE EXCEPTION 'TOP_UP_PLAN_NOT_ELIGIBLE';
  END IF;

  INSERT INTO public.billing_payment_orders (
    workspace_id,
    order_type,
    status,
    top_up_pack_id,
    provider,
    currency,
    amount_minor,
    provider_currency,
    provider_amount_minor,
    provider_payment_method,
    created_by,
    idempotency_key,
    metadata
  ) VALUES (
    p_workspace_id,
    'top_up',
    'pending',
    v_pack.id,
    p_provider,
    v_pack.currency,
    v_pack.price_minor,
    v_provider_currency,
    v_provider_amount,
    p_payment_method,
    p_actor_user_id,
    btrim(p_idempotency_key),
    jsonb_build_object('pack_code', v_pack.code, 'pack_version', v_pack.version)
  )
  ON CONFLICT (workspace_id, idempotency_key)
  DO UPDATE SET updated_at = public.billing_payment_orders.updated_at
  RETURNING * INTO v_order;

  RETURN jsonb_build_object(
    'order_id', v_order.id,
    'status', v_order.status,
    'pack_code', v_pack.code,
    'pack_name', v_pack.name_zh,
    'credits', v_pack.credits,
    'currency', v_order.currency,
    'amount_minor', v_order.amount_minor,
    'provider_currency', v_order.provider_currency,
    'provider_amount_minor', v_order.provider_amount_minor,
    'payment_method', v_order.provider_payment_method,
    'provider_order_id', v_order.provider_order_id,
    'metadata', v_order.metadata
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_complete_dulupay_top_up(
  p_order_id uuid,
  p_provider_event_id text,
  p_provider_trade_no text,
  p_provider_amount_minor integer,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.billing_payment_orders;
  v_pack public.billing_top_up_packs;
  v_balance integer;
  v_new_balance integer;
  v_batch_id uuid;
  v_ledger_id uuid;
  v_event public.payment_events;
  v_idempotency_key text;
BEGIN
  IF nullif(btrim(p_provider_event_id), '') IS NULL
    OR nullif(btrim(p_provider_trade_no), '') IS NULL
  THEN
    RAISE EXCEPTION 'PAYMENT_WEBHOOK_IDENTITY_REQUIRED';
  END IF;

  INSERT INTO public.payment_events (
    provider,
    provider_event_id,
    provider_resource_id,
    event_name,
    workspace_id,
    payload,
    processed,
    status,
    attempt_count,
    processing_started_at,
    updated_at
  ) VALUES (
    'dulupay',
    p_provider_event_id,
    p_provider_trade_no,
    'payment_success',
    NULL,
    coalesce(p_payload, '{}'::jsonb),
    false,
    'processing',
    1,
    now(),
    now()
  )
  ON CONFLICT (provider, provider_event_id)
  DO UPDATE SET
    attempt_count = public.payment_events.attempt_count + 1,
    updated_at = now()
  RETURNING * INTO v_event;

  IF v_event.status = 'processed' THEN
    RETURN jsonb_build_object('processed', false, 'duplicate', true);
  END IF;

  SELECT *
  INTO v_order
  FROM public.billing_payment_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_order.id IS NULL OR v_order.provider <> 'dulupay' OR v_order.order_type <> 'top_up' THEN
    RAISE EXCEPTION 'PAYMENT_ORDER_NOT_FOUND';
  END IF;
  IF v_order.provider_amount_minor <> p_provider_amount_minor THEN
    RAISE EXCEPTION 'PAYMENT_AMOUNT_MISMATCH';
  END IF;
  IF v_order.provider_order_id IS NOT NULL
    AND v_order.provider_order_id <> p_provider_trade_no
  THEN
    RAISE EXCEPTION 'PAYMENT_PROVIDER_ORDER_MISMATCH';
  END IF;

  UPDATE public.payment_events
  SET workspace_id = v_order.workspace_id
  WHERE id = v_event.id;

  IF v_order.status = 'paid' THEN
    UPDATE public.payment_events
    SET processed = true,
        status = 'processed',
        processed_at = now(),
        updated_at = now()
    WHERE id = v_event.id;
    RETURN jsonb_build_object('processed', false, 'duplicate', true);
  END IF;
  IF v_order.status NOT IN ('pending', 'failed') THEN
    RAISE EXCEPTION 'PAYMENT_ORDER_NOT_PENDING';
  END IF;

  SELECT *
  INTO v_pack
  FROM public.billing_top_up_packs
  WHERE id = v_order.top_up_pack_id;

  INSERT INTO public.credit_balances (workspace_id, balance, version)
  VALUES (v_order.workspace_id, 0, 0)
  ON CONFLICT (workspace_id) DO NOTHING;

  SELECT balance
  INTO v_balance
  FROM public.credit_balances
  WHERE workspace_id = v_order.workspace_id
  FOR UPDATE;

  v_idempotency_key := 'topup:' || v_order.id::text;

  INSERT INTO public.credit_grant_batches (
    workspace_id,
    source_type,
    original_amount,
    remaining_amount,
    payment_order_id,
    idempotency_key,
    metadata
  ) VALUES (
    v_order.workspace_id,
    'top_up',
    v_pack.credits,
    v_pack.credits,
    v_order.id,
    v_idempotency_key,
    jsonb_build_object(
      'provider', 'dulupay',
      'provider_trade_no', p_provider_trade_no,
      'pack_code', v_pack.code,
      'pack_version', v_pack.version
    )
  )
  ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_batch_id;

  IF v_batch_id IS NULL THEN
    UPDATE public.billing_payment_orders
    SET status = 'paid',
        provider_order_id = p_provider_trade_no,
        paid_at = coalesce(paid_at, now()),
        metadata = metadata || jsonb_build_object('callback', coalesce(p_payload, '{}'::jsonb)),
        updated_at = now()
    WHERE id = v_order.id;

    UPDATE public.payment_events
    SET processed = true,
        status = 'processed',
        processed_at = now(),
        updated_at = now()
    WHERE id = v_event.id;

    RETURN jsonb_build_object('processed', false, 'duplicate', true);
  END IF;

  v_new_balance := v_balance + v_pack.credits;

  UPDATE public.credit_balances
  SET balance = v_new_balance,
      version = version + 1,
      updated_at = now()
  WHERE workspace_id = v_order.workspace_id;

  INSERT INTO public.credit_ledger (
    workspace_id,
    user_id,
    entry_type,
    amount,
    balance_after,
    payment_order_id,
    idempotency_key,
    description,
    metadata
  ) VALUES (
    v_order.workspace_id,
    v_order.created_by,
    'grant',
    v_pack.credits,
    v_new_balance,
    v_order.id,
    v_idempotency_key,
    v_pack.name_zh || '购买到账',
    jsonb_build_object(
      'source_type', 'top_up',
      'transaction_type', 'purchase',
      'provider', 'dulupay',
      'provider_trade_no', p_provider_trade_no,
      'pack_code', v_pack.code,
      'pack_version', v_pack.version
    )
  )
  RETURNING id INTO v_ledger_id;

  INSERT INTO public.credit_ledger_allocations (ledger_id, grant_batch_id, amount)
  VALUES (v_ledger_id, v_batch_id, v_pack.credits);

  INSERT INTO public.credit_transactions (
    workspace_id,
    user_id,
    transaction_type,
    amount,
    balance_after,
    description,
    metadata
  ) VALUES (
    v_order.workspace_id,
    v_order.created_by,
    'purchase',
    v_pack.credits,
    v_new_balance,
    v_pack.name_zh || '购买到账',
    jsonb_build_object(
      'credit_ledger_id', v_ledger_id,
      'payment_order_id', v_order.id,
      'provider', 'dulupay',
      'provider_trade_no', p_provider_trade_no
    )
  );

  UPDATE public.billing_payment_orders
  SET status = 'paid',
      provider_order_id = p_provider_trade_no,
      paid_at = now(),
      metadata = metadata || jsonb_build_object('callback', coalesce(p_payload, '{}'::jsonb)),
      updated_at = now()
  WHERE id = v_order.id;

  UPDATE public.payment_events
  SET processed = true,
      status = 'processed',
      processed_at = now(),
      updated_at = now()
  WHERE id = v_event.id;

  RETURN jsonb_build_object(
    'processed', true,
    'duplicate', false,
    'credits', v_pack.credits,
    'balance', v_new_balance,
    'ledger_id', v_ledger_id,
    'grant_batch_id', v_batch_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_save_top_up_pack_draft(
  uuid, text, text, text, integer, integer, text, integer, integer, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_publish_top_up_pack(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_save_payment_provider_config(
  uuid, boolean, text, text, text, boolean, text, text[], integer, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_create_top_up_order(
  uuid, uuid, text, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_complete_dulupay_top_up(
  uuid, text, text, integer, jsonb
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_save_top_up_pack_draft(
  uuid, text, text, text, integer, integer, text, integer, integer, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_publish_top_up_pack(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_save_payment_provider_config(
  uuid, boolean, text, text, text, boolean, text, text[], integer, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_create_top_up_order(
  uuid, uuid, text, text, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_complete_dulupay_top_up(
  uuid, text, text, integer, jsonb
) TO service_role;

COMMENT ON TABLE public.payment_provider_configs IS
  'Server-only payment gateway configuration. Merchant private keys are encrypted by the application before storage.';
COMMENT ON TABLE public.billing_top_up_pack_provider_prices IS
  'Provider-specific immutable prices for a versioned top-up pack. Canonical catalog pricing remains USD.';
COMMENT ON FUNCTION public.billing_complete_dulupay_top_up(uuid, text, text, integer, jsonb) IS
  'Atomically marks a verified DuluPay order paid and grants its permanent top-up credit batch.';
