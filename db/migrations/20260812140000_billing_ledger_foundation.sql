-- Versioned billing catalog and source-aware credit accounting foundation.
-- This migration is additive: existing credit APIs continue to work until the
-- application is switched to the new atomic ledger functions.

CREATE TABLE public.billing_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name_zh text NOT NULL,
  description_zh text NOT NULL DEFAULT '',
  is_public boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_plans_code_check
    CHECK (code IN ('free', 'pro', 'team', 'enterprise')),
  CONSTRAINT billing_plans_name_check
    CHECK (char_length(btrim(name_zh)) BETWEEN 1 AND 100)
);

CREATE TABLE public.billing_plan_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES public.billing_plans(id) ON DELETE RESTRICT,
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  currency text NOT NULL DEFAULT 'USD',
  monthly_price_minor integer NOT NULL DEFAULT 0,
  annual_price_minor integer NOT NULL DEFAULT 0,
  monthly_subscription_credits integer NOT NULL DEFAULT 0,
  daily_credits integer NOT NULL DEFAULT 50,
  top_up_eligible boolean NOT NULL DEFAULT false,
  effective_from timestamptz,
  published_at timestamptz,
  retired_at timestamptz,
  created_by uuid REFERENCES public.app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_plan_versions_plan_version_key UNIQUE (plan_id, version),
  CONSTRAINT billing_plan_versions_status_check
    CHECK (status IN ('draft', 'published', 'retired')),
  CONSTRAINT billing_plan_versions_currency_check
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT billing_plan_versions_amounts_check
    CHECK (
      monthly_price_minor >= 0
      AND annual_price_minor >= 0
      AND monthly_subscription_credits >= 0
      AND daily_credits >= 0
    ),
  CONSTRAINT billing_plan_versions_publish_state_check
    CHECK (
      (status = 'draft' AND published_at IS NULL AND retired_at IS NULL)
      OR (status = 'published' AND published_at IS NOT NULL AND retired_at IS NULL)
      OR (status = 'retired' AND published_at IS NOT NULL AND retired_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX billing_plan_versions_one_published_idx
  ON public.billing_plan_versions(plan_id)
  WHERE status = 'published';
CREATE INDEX billing_plan_versions_created_by_idx
  ON public.billing_plan_versions(created_by)
  WHERE created_by IS NOT NULL;

CREATE TABLE public.billing_plan_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_version_id uuid NOT NULL
    REFERENCES public.billing_plan_versions(id) ON DELETE CASCADE,
  entitlement_key text NOT NULL,
  entitlement_value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_plan_entitlements_version_key
    UNIQUE (plan_version_id, entitlement_key),
  CONSTRAINT billing_plan_entitlements_key_check
    CHECK (entitlement_key ~ '^[a-z][a-z0-9_.-]{1,99}$')
);

CREATE TABLE public.workspace_billing_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  plan_version_id uuid NOT NULL
    REFERENCES public.billing_plan_versions(id) ON DELETE RESTRICT,
  status text NOT NULL,
  billing_period text,
  provider text,
  provider_customer_id text,
  provider_subscription_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  credit_period_start timestamptz,
  credit_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  canceled_at timestamptz,
  grace_ends_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_billing_subscriptions_status_check
    CHECK (status IN ('trialing', 'active', 'past_due', 'canceled', 'expired')),
  CONSTRAINT workspace_billing_subscriptions_period_check
    CHECK (billing_period IS NULL OR billing_period IN ('monthly', 'yearly')),
  CONSTRAINT workspace_billing_subscriptions_current_period_check
    CHECK (
      current_period_start IS NULL
      OR current_period_end IS NULL
      OR current_period_end > current_period_start
    ),
  CONSTRAINT workspace_billing_subscriptions_credit_period_check
    CHECK (
      credit_period_start IS NULL
      OR credit_period_end IS NULL
      OR credit_period_end > credit_period_start
    )
);

CREATE UNIQUE INDEX workspace_billing_subscriptions_one_current_idx
  ON public.workspace_billing_subscriptions(workspace_id)
  WHERE status IN ('trialing', 'active', 'past_due', 'canceled');
CREATE UNIQUE INDEX workspace_billing_subscriptions_provider_idx
  ON public.workspace_billing_subscriptions(provider, provider_subscription_id)
  WHERE provider IS NOT NULL AND provider_subscription_id IS NOT NULL;
CREATE INDEX workspace_billing_subscriptions_workspace_idx
  ON public.workspace_billing_subscriptions(workspace_id, created_at DESC);
CREATE INDEX workspace_billing_subscriptions_plan_version_idx
  ON public.workspace_billing_subscriptions(plan_version_id);

CREATE TABLE public.billing_top_up_packs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  version integer NOT NULL,
  name_zh text NOT NULL,
  credits integer NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  price_minor integer NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  minimum_plan_code text NOT NULL DEFAULT 'pro',
  provider_variant_id text,
  published_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_top_up_packs_code_version_key UNIQUE (code, version),
  CONSTRAINT billing_top_up_packs_code_check
    CHECK (code ~ '^[a-z][a-z0-9_-]{1,49}$'),
  CONSTRAINT billing_top_up_packs_values_check
    CHECK (credits > 0 AND price_minor >= 0),
  CONSTRAINT billing_top_up_packs_currency_check
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT billing_top_up_packs_status_check
    CHECK (status IN ('draft', 'published', 'retired')),
  CONSTRAINT billing_top_up_packs_minimum_plan_check
    CHECK (minimum_plan_code IN ('pro', 'team')),
  CONSTRAINT billing_top_up_packs_publish_state_check
    CHECK (
      (status = 'draft' AND published_at IS NULL AND retired_at IS NULL)
      OR (status = 'published' AND published_at IS NOT NULL AND retired_at IS NULL)
      OR (status = 'retired' AND published_at IS NOT NULL AND retired_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX billing_top_up_packs_one_published_idx
  ON public.billing_top_up_packs(code)
  WHERE status = 'published';

CREATE TABLE public.billing_payment_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  order_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  plan_version_id uuid REFERENCES public.billing_plan_versions(id) ON DELETE RESTRICT,
  top_up_pack_id uuid REFERENCES public.billing_top_up_packs(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  provider_order_id text,
  provider_checkout_id text,
  currency text NOT NULL,
  amount_minor integer NOT NULL,
  idempotency_key text NOT NULL,
  paid_at timestamptz,
  refunded_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_payment_orders_workspace_idempotency_key
    UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT billing_payment_orders_type_check
    CHECK (order_type IN ('subscription', 'top_up')),
  CONSTRAINT billing_payment_orders_status_check
    CHECK (status IN ('pending', 'paid', 'failed', 'refunded', 'partially_refunded', 'canceled')),
  CONSTRAINT billing_payment_orders_currency_check
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT billing_payment_orders_amount_check
    CHECK (amount_minor >= 0),
  CONSTRAINT billing_payment_orders_product_check
    CHECK (
      (order_type = 'subscription' AND plan_version_id IS NOT NULL AND top_up_pack_id IS NULL)
      OR (order_type = 'top_up' AND top_up_pack_id IS NOT NULL AND plan_version_id IS NULL)
    )
);

CREATE UNIQUE INDEX billing_payment_orders_provider_order_idx
  ON public.billing_payment_orders(provider, provider_order_id)
  WHERE provider_order_id IS NOT NULL;
CREATE INDEX billing_payment_orders_workspace_created_idx
  ON public.billing_payment_orders(workspace_id, created_at DESC);
CREATE INDEX billing_payment_orders_plan_version_idx
  ON public.billing_payment_orders(plan_version_id)
  WHERE plan_version_id IS NOT NULL;
CREATE INDEX billing_payment_orders_top_up_pack_idx
  ON public.billing_payment_orders(top_up_pack_id)
  WHERE top_up_pack_id IS NOT NULL;

CREATE TABLE public.credit_grant_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  source_type text NOT NULL,
  original_amount integer NOT NULL,
  remaining_amount integer NOT NULL,
  valid_from timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  subscription_id uuid
    REFERENCES public.workspace_billing_subscriptions(id) ON DELETE RESTRICT,
  payment_order_id uuid
    REFERENCES public.billing_payment_orders(id) ON DELETE RESTRICT,
  subscription_period_key text,
  idempotency_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_grant_batches_workspace_idempotency_key
    UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT credit_grant_batches_source_check
    CHECK (source_type IN ('daily', 'subscription', 'top_up', 'admin', 'bonus', 'legacy')),
  CONSTRAINT credit_grant_batches_amount_check
    CHECK (
      original_amount > 0
      AND remaining_amount >= 0
      AND remaining_amount <= original_amount
    ),
  CONSTRAINT credit_grant_batches_validity_check
    CHECK (expires_at IS NULL OR expires_at > valid_from),
  CONSTRAINT credit_grant_batches_expiry_required_check
    CHECK (
      (source_type IN ('daily', 'subscription') AND expires_at IS NOT NULL)
      OR (source_type IN ('top_up', 'admin', 'bonus', 'legacy') AND expires_at IS NULL)
    ),
  CONSTRAINT credit_grant_batches_source_reference_check
    CHECK (
      (source_type = 'subscription' AND subscription_id IS NOT NULL)
      OR (source_type = 'top_up' AND payment_order_id IS NOT NULL)
      OR source_type IN ('daily', 'admin', 'bonus', 'legacy')
    )
);

CREATE INDEX credit_grant_batches_workspace_available_idx
  ON public.credit_grant_batches(
    workspace_id,
    expires_at,
    valid_from,
    created_at,
    id
  )
  WHERE remaining_amount > 0;
CREATE INDEX credit_grant_batches_subscription_idx
  ON public.credit_grant_batches(subscription_id)
  WHERE subscription_id IS NOT NULL;
CREATE INDEX credit_grant_batches_payment_order_idx
  ON public.credit_grant_batches(payment_order_id)
  WHERE payment_order_id IS NOT NULL;
CREATE UNIQUE INDEX credit_grant_batches_daily_unique_idx
  ON public.credit_grant_batches(workspace_id, ((valid_from AT TIME ZONE 'Asia/Shanghai')::date))
  WHERE source_type = 'daily';
CREATE UNIQUE INDEX credit_grant_batches_subscription_period_unique_idx
  ON public.credit_grant_batches(subscription_id, subscription_period_key)
  WHERE source_type = 'subscription';
CREATE UNIQUE INDEX credit_grant_batches_top_up_order_unique_idx
  ON public.credit_grant_batches(payment_order_id)
  WHERE source_type = 'top_up';

CREATE TABLE public.credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES public.app_users(id) ON DELETE SET NULL,
  entry_type text NOT NULL,
  amount integer NOT NULL,
  balance_after integer NOT NULL,
  job_id uuid REFERENCES public.background_jobs(id) ON DELETE SET NULL,
  payment_order_id uuid REFERENCES public.billing_payment_orders(id) ON DELETE RESTRICT,
  reverses_ledger_id uuid REFERENCES public.credit_ledger(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  description text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_ledger_workspace_idempotency_key
    UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT credit_ledger_entry_type_check
    CHECK (entry_type IN ('grant', 'deduct', 'refund', 'expire', 'admin_adjustment', 'migration')),
  CONSTRAINT credit_ledger_amount_check CHECK (amount <> 0),
  CONSTRAINT credit_ledger_balance_check CHECK (balance_after >= 0),
  CONSTRAINT credit_ledger_reversal_check
    CHECK (
      (entry_type = 'refund' AND reverses_ledger_id IS NOT NULL)
      OR (entry_type <> 'refund' AND reverses_ledger_id IS NULL)
    )
);

CREATE INDEX credit_ledger_workspace_created_idx
  ON public.credit_ledger(workspace_id, created_at DESC, id DESC);
CREATE INDEX credit_ledger_user_created_idx
  ON public.credit_ledger(user_id, created_at DESC)
  WHERE user_id IS NOT NULL;
CREATE INDEX credit_ledger_job_idx
  ON public.credit_ledger(job_id)
  WHERE job_id IS NOT NULL;
CREATE INDEX credit_ledger_payment_order_idx
  ON public.credit_ledger(payment_order_id)
  WHERE payment_order_id IS NOT NULL;
CREATE INDEX credit_ledger_reverses_idx
  ON public.credit_ledger(reverses_ledger_id)
  WHERE reverses_ledger_id IS NOT NULL;

CREATE TABLE public.credit_ledger_allocations (
  ledger_id uuid NOT NULL REFERENCES public.credit_ledger(id) ON DELETE RESTRICT,
  grant_batch_id uuid NOT NULL REFERENCES public.credit_grant_batches(id) ON DELETE RESTRICT,
  amount integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ledger_id, grant_batch_id),
  CONSTRAINT credit_ledger_allocations_amount_check CHECK (amount > 0)
);

CREATE INDEX credit_ledger_allocations_batch_idx
  ON public.credit_ledger_allocations(grant_batch_id, created_at DESC);

CREATE TABLE public.workspace_entitlement_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  entitlement_key text NOT NULL,
  entitlement_value jsonb NOT NULL,
  reason text NOT NULL,
  valid_from timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  created_by uuid NOT NULL REFERENCES public.app_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_entitlement_overrides_key
    UNIQUE (workspace_id, entitlement_key, valid_from),
  CONSTRAINT workspace_entitlement_overrides_key_check
    CHECK (entitlement_key ~ '^[a-z][a-z0-9_.-]{1,99}$'),
  CONSTRAINT workspace_entitlement_overrides_reason_check
    CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  CONSTRAINT workspace_entitlement_overrides_validity_check
    CHECK (expires_at IS NULL OR expires_at > valid_from)
);

CREATE INDEX workspace_entitlement_overrides_active_idx
  ON public.workspace_entitlement_overrides(
    workspace_id,
    entitlement_key,
    valid_from DESC,
    expires_at
  );
CREATE INDEX workspace_entitlement_overrides_created_by_idx
  ON public.workspace_entitlement_overrides(created_by);

-- Published plan versions are immutable. Retirement only changes lifecycle
-- fields and is performed through a dedicated function in a later migration.
CREATE OR REPLACE FUNCTION public.prevent_published_billing_plan_version_changes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.status = 'retired' THEN
    RAISE EXCEPTION 'PUBLISHED_PLAN_VERSION_IMMUTABLE';
  END IF;

  IF OLD.status = 'published' AND NOT (
    TG_OP = 'UPDATE'
    AND NEW.status = 'retired'
    AND NEW.retired_at IS NOT NULL
    AND NEW.plan_id = OLD.plan_id
    AND NEW.version = OLD.version
    AND NEW.currency = OLD.currency
    AND NEW.monthly_price_minor = OLD.monthly_price_minor
    AND NEW.annual_price_minor = OLD.annual_price_minor
    AND NEW.monthly_subscription_credits = OLD.monthly_subscription_credits
    AND NEW.daily_credits = OLD.daily_credits
    AND NEW.top_up_eligible = OLD.top_up_eligible
    AND NEW.effective_from IS NOT DISTINCT FROM OLD.effective_from
    AND NEW.published_at = OLD.published_at
    AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by
    AND NEW.created_at = OLD.created_at
  ) THEN
    RAISE EXCEPTION 'PUBLISHED_PLAN_VERSION_IMMUTABLE';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_prevent_published_billing_plan_version_changes
  BEFORE UPDATE OR DELETE ON public.billing_plan_versions
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_published_billing_plan_version_changes();

CREATE OR REPLACE FUNCTION public.prevent_published_top_up_pack_changes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.status = 'retired' THEN
    RAISE EXCEPTION 'PUBLISHED_TOP_UP_PACK_IMMUTABLE';
  END IF;

  IF OLD.status = 'published' AND NOT (
    TG_OP = 'UPDATE'
    AND NEW.status = 'retired'
    AND NEW.retired_at IS NOT NULL
    AND NEW.code = OLD.code
    AND NEW.version = OLD.version
    AND NEW.name_zh = OLD.name_zh
    AND NEW.credits = OLD.credits
    AND NEW.currency = OLD.currency
    AND NEW.price_minor = OLD.price_minor
    AND NEW.minimum_plan_code = OLD.minimum_plan_code
    AND NEW.provider_variant_id IS NOT DISTINCT FROM OLD.provider_variant_id
    AND NEW.published_at = OLD.published_at
    AND NEW.created_at = OLD.created_at
  ) THEN
    RAISE EXCEPTION 'PUBLISHED_TOP_UP_PACK_IMMUTABLE';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_prevent_published_top_up_pack_changes
  BEFORE UPDATE OR DELETE ON public.billing_top_up_packs
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_published_top_up_pack_changes();

ALTER TABLE public.billing_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_plan_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_plan_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_billing_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_top_up_packs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_payment_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_grant_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_ledger_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_entitlement_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Published billing plans are readable"
  ON public.billing_plans FOR SELECT
  USING (is_active = true);
CREATE POLICY "Published billing plan versions are readable"
  ON public.billing_plan_versions FOR SELECT
  USING (status = 'published');
CREATE POLICY "Published plan entitlements are readable"
  ON public.billing_plan_entitlements FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.billing_plan_versions version
      WHERE version.id = plan_version_id
        AND version.status = 'published'
    )
  );
CREATE POLICY "Published top up packs are readable"
  ON public.billing_top_up_packs FOR SELECT
  USING (status = 'published');

CREATE POLICY "Members can read workspace billing subscriptions"
  ON public.workspace_billing_subscriptions FOR SELECT
  USING (
    workspace_id IN (
      SELECT member.workspace_id
      FROM public.workspace_members member
      WHERE member.user_id = private.current_user_id()
    )
  );
CREATE POLICY "Members can read workspace payment orders"
  ON public.billing_payment_orders FOR SELECT
  USING (
    workspace_id IN (
      SELECT member.workspace_id
      FROM public.workspace_members member
      WHERE member.user_id = private.current_user_id()
    )
  );
CREATE POLICY "Members can read workspace credit batches"
  ON public.credit_grant_batches FOR SELECT
  USING (
    workspace_id IN (
      SELECT member.workspace_id
      FROM public.workspace_members member
      WHERE member.user_id = private.current_user_id()
    )
  );
CREATE POLICY "Members can read workspace credit ledger"
  ON public.credit_ledger FOR SELECT
  USING (
    workspace_id IN (
      SELECT member.workspace_id
      FROM public.workspace_members member
      WHERE member.user_id = private.current_user_id()
    )
  );
CREATE POLICY "Members can read workspace credit allocations"
  ON public.credit_ledger_allocations FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.credit_ledger ledger
      JOIN public.workspace_members member
        ON member.workspace_id = ledger.workspace_id
      WHERE ledger.id = ledger_id
        AND member.user_id = private.current_user_id()
    )
  );
CREATE POLICY "Members can read workspace entitlement overrides"
  ON public.workspace_entitlement_overrides FOR SELECT
  USING (
    workspace_id IN (
      SELECT member.workspace_id
      FROM public.workspace_members member
      WHERE member.user_id = private.current_user_id()
    )
  );

REVOKE INSERT, UPDATE, DELETE ON public.billing_plans FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.billing_plan_versions FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.billing_plan_entitlements FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.workspace_billing_subscriptions FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.billing_top_up_packs FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.billing_payment_orders FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.credit_grant_batches FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.credit_ledger FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.credit_ledger_allocations FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.workspace_entitlement_overrides FROM PUBLIC;

-- Seed the catalog as drafts. Nothing becomes public until model costs and
-- margins are reviewed and an explicit publish operation is performed.
INSERT INTO public.billing_plans (code, name_zh, description_zh, is_public)
VALUES
  ('free', '免费版', '用于产品体验与获客', true),
  ('pro', '专业版', '面向持续进行商业创作的个人专业用户', true),
  ('team', '团队版', '面向高用量工作室与小团队', true),
  ('enterprise', '企业版', '按合同配置价格与权益', false)
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.billing_plan_versions (
  plan_id,
  version,
  status,
  currency,
  monthly_price_minor,
  annual_price_minor,
  monthly_subscription_credits,
  daily_credits,
  top_up_eligible
)
SELECT
  plan.id,
  1,
  'draft',
  'USD',
  CASE plan.code
    WHEN 'pro' THEN 3900
    WHEN 'team' THEN 9900
    ELSE 0
  END,
  CASE plan.code
    WHEN 'pro' THEN 34800
    WHEN 'team' THEN 94800
    ELSE 0
  END,
  CASE plan.code
    WHEN 'pro' THEN 5000
    WHEN 'team' THEN 15000
    ELSE 0
  END,
  CASE WHEN plan.code IN ('free', 'pro', 'team') THEN 50 ELSE 0 END,
  plan.code IN ('pro', 'team')
FROM public.billing_plans plan
ON CONFLICT (plan_id, version) DO NOTHING;

INSERT INTO public.billing_top_up_packs (
  code,
  version,
  name_zh,
  credits,
  currency,
  price_minor,
  status,
  minimum_plan_code
)
VALUES
  ('credits_1000', 1, '小型点数包', 1000, 'USD', 0, 'draft', 'pro'),
  ('credits_5000', 1, '标准点数包', 5000, 'USD', 0, 'draft', 'pro'),
  ('credits_15000', 1, '大型点数包', 15000, 'USD', 0, 'draft', 'team')
ON CONFLICT (code, version) DO NOTHING;

-- Preserve every existing aggregate balance as a non-expiring legacy batch.
-- The matching migration ledger entry records the opening balance, and no
-- existing credit transaction is deleted or rewritten.
INSERT INTO public.credit_grant_batches (
  workspace_id,
  source_type,
  original_amount,
  remaining_amount,
  valid_from,
  idempotency_key,
  metadata
)
SELECT
  balance.workspace_id,
  'legacy',
  balance.balance,
  balance.balance,
  now(),
  'migration:legacy-balance:v1',
  jsonb_build_object('legacy_credit_balance_id', balance.id)
FROM public.credit_balances balance
WHERE balance.balance > 0
ON CONFLICT (workspace_id, idempotency_key) DO NOTHING;

INSERT INTO public.credit_ledger (
  workspace_id,
  entry_type,
  amount,
  balance_after,
  idempotency_key,
  description,
  metadata
)
SELECT
  balance.workspace_id,
  'migration',
  balance.balance,
  balance.balance,
  'migration:legacy-balance:v1',
  '旧点数余额迁移为历史永久点数',
  jsonb_build_object('legacy_credit_balance_id', balance.id)
FROM public.credit_balances balance
WHERE balance.balance > 0
ON CONFLICT (workspace_id, idempotency_key) DO NOTHING;

COMMENT ON TABLE public.billing_plan_versions IS
  'Immutable after publication. Price or entitlement changes require a new version.';
COMMENT ON TABLE public.credit_grant_batches IS
  'Source-aware credit lots. Daily and subscription lots expire; top-up lots do not.';
COMMENT ON TABLE public.credit_ledger IS
  'Append-only business-operation ledger. credit_balances remains a query projection.';
COMMENT ON COLUMN public.credit_grant_batches.idempotency_key IS
  'Stable business key such as daily:<date>, subscription:<period>, topup:<order>, or admin:<request>.';
