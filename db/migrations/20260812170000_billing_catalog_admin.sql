-- Provider-neutral billing catalog administration and published runtime config.

CREATE OR REPLACE FUNCTION public.prevent_published_billing_entitlement_changes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_plan_version_id uuid;
  v_status text;
BEGIN
  v_plan_version_id := coalesce(NEW.plan_version_id, OLD.plan_version_id);

  SELECT status
  INTO v_status
  FROM public.billing_plan_versions
  WHERE id = v_plan_version_id;

  IF v_status IN ('published', 'retired') THEN
    RAISE EXCEPTION 'PUBLISHED_PLAN_ENTITLEMENTS_IMMUTABLE';
  END IF;

  RETURN coalesce(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_prevent_published_billing_entitlement_changes
  BEFORE INSERT OR UPDATE OR DELETE ON public.billing_plan_entitlements
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_published_billing_entitlement_changes();

CREATE OR REPLACE FUNCTION public.admin_save_billing_plan_draft(
  p_actor_user_id uuid,
  p_plan_code text,
  p_currency text,
  p_monthly_price_minor integer,
  p_annual_price_minor integer,
  p_monthly_subscription_credits integer,
  p_daily_credits integer,
  p_top_up_eligible boolean,
  p_entitlements jsonb,
  p_reason text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan_id uuid;
  v_version_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_reason text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_admins WHERE user_id = p_actor_user_id
  ) THEN
    RAISE EXCEPTION 'PLATFORM_ADMIN_REQUIRED';
  END IF;

  v_reason := nullif(btrim(p_reason), '');
  IF v_reason IS NULL OR char_length(v_reason) < 3 THEN
    RAISE EXCEPTION 'BILLING_CHANGE_REASON_REQUIRED';
  END IF;

  IF p_currency !~ '^[A-Z]{3}$'
    OR p_monthly_price_minor < 0
    OR p_annual_price_minor < 0
    OR p_monthly_subscription_credits < 0
    OR p_daily_credits < 0
    OR jsonb_typeof(p_entitlements) <> 'object'
  THEN
    RAISE EXCEPTION 'BILLING_PLAN_VALUES_INVALID';
  END IF;

  SELECT id
  INTO v_plan_id
  FROM public.billing_plans
  WHERE code = p_plan_code
  FOR UPDATE;

  IF v_plan_id IS NULL THEN
    RAISE EXCEPTION 'BILLING_PLAN_NOT_FOUND';
  END IF;

  SELECT id,
    jsonb_build_object(
      'currency', currency,
      'monthly_price_minor', monthly_price_minor,
      'annual_price_minor', annual_price_minor,
      'monthly_subscription_credits', monthly_subscription_credits,
      'daily_credits', daily_credits,
      'top_up_eligible', top_up_eligible,
      'entitlements', (
        SELECT coalesce(jsonb_object_agg(e.entitlement_key, e.entitlement_value), '{}'::jsonb)
        FROM public.billing_plan_entitlements e
        WHERE e.plan_version_id = billing_plan_versions.id
      )
    )
  INTO v_version_id, v_before
  FROM public.billing_plan_versions
  WHERE plan_id = v_plan_id AND status = 'draft'
  ORDER BY version DESC
  LIMIT 1
  FOR UPDATE;

  IF v_version_id IS NULL THEN
    INSERT INTO public.billing_plan_versions (
      plan_id,
      version,
      status,
      currency,
      monthly_price_minor,
      annual_price_minor,
      monthly_subscription_credits,
      daily_credits,
      top_up_eligible,
      created_by
    )
    SELECT
      v_plan_id,
      coalesce(max(version), 0) + 1,
      'draft',
      p_currency,
      p_monthly_price_minor,
      p_annual_price_minor,
      p_monthly_subscription_credits,
      p_daily_credits,
      p_top_up_eligible,
      p_actor_user_id
    FROM public.billing_plan_versions
    WHERE plan_id = v_plan_id
    RETURNING id INTO v_version_id;
  ELSE
    UPDATE public.billing_plan_versions
    SET currency = p_currency,
        monthly_price_minor = p_monthly_price_minor,
        annual_price_minor = p_annual_price_minor,
        monthly_subscription_credits = p_monthly_subscription_credits,
        daily_credits = p_daily_credits,
        top_up_eligible = p_top_up_eligible
    WHERE id = v_version_id;
  END IF;

  DELETE FROM public.billing_plan_entitlements
  WHERE plan_version_id = v_version_id;

  INSERT INTO public.billing_plan_entitlements (
    plan_version_id,
    entitlement_key,
    entitlement_value
  )
  SELECT v_version_id, key, value
  FROM jsonb_each(p_entitlements);

  SELECT jsonb_build_object(
    'currency', version.currency,
    'monthly_price_minor', version.monthly_price_minor,
    'annual_price_minor', version.annual_price_minor,
    'monthly_subscription_credits', version.monthly_subscription_credits,
    'daily_credits', version.daily_credits,
    'top_up_eligible', version.top_up_eligible,
    'entitlements', coalesce(jsonb_object_agg(e.entitlement_key, e.entitlement_value)
      FILTER (WHERE e.entitlement_key IS NOT NULL), '{}'::jsonb)
  )
  INTO v_after
  FROM public.billing_plan_versions version
  LEFT JOIN public.billing_plan_entitlements e ON e.plan_version_id = version.id
  WHERE version.id = v_version_id
  GROUP BY version.id;

  INSERT INTO public.admin_audit_events (
    actor_user_id,
    action,
    metadata
  ) VALUES (
    p_actor_user_id,
    'billing.plan_draft_saved',
    jsonb_build_object(
      'plan_code', p_plan_code,
      'plan_version_id', v_version_id,
      'reason', v_reason,
      'before', v_before,
      'after', v_after
    )
  );

  RETURN v_version_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_create_billing_plan_draft(
  p_actor_user_id uuid,
  p_plan_code text,
  p_reason text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan_id uuid;
  v_source public.billing_plan_versions%ROWTYPE;
  v_new_version_id uuid;
  v_reason text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_admins WHERE user_id = p_actor_user_id
  ) THEN
    RAISE EXCEPTION 'PLATFORM_ADMIN_REQUIRED';
  END IF;

  v_reason := nullif(btrim(p_reason), '');
  IF v_reason IS NULL OR char_length(v_reason) < 3 THEN
    RAISE EXCEPTION 'BILLING_CHANGE_REASON_REQUIRED';
  END IF;

  SELECT id INTO v_plan_id
  FROM public.billing_plans
  WHERE code = p_plan_code
  FOR UPDATE;

  IF v_plan_id IS NULL THEN
    RAISE EXCEPTION 'BILLING_PLAN_NOT_FOUND';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.billing_plan_versions
    WHERE plan_id = v_plan_id AND status = 'draft'
  ) THEN
    RAISE EXCEPTION 'BILLING_PLAN_DRAFT_EXISTS';
  END IF;

  SELECT * INTO v_source
  FROM public.billing_plan_versions
  WHERE plan_id = v_plan_id AND status = 'published'
  ORDER BY version DESC
  LIMIT 1;

  IF v_source.id IS NULL THEN
    RAISE EXCEPTION 'BILLING_PLAN_PUBLISHED_VERSION_NOT_FOUND';
  END IF;

  INSERT INTO public.billing_plan_versions (
    plan_id,
    version,
    status,
    currency,
    monthly_price_minor,
    annual_price_minor,
    monthly_subscription_credits,
    daily_credits,
    top_up_eligible,
    created_by
  )
  SELECT
    v_plan_id,
    coalesce(max(version), 0) + 1,
    'draft',
    v_source.currency,
    v_source.monthly_price_minor,
    v_source.annual_price_minor,
    v_source.monthly_subscription_credits,
    v_source.daily_credits,
    v_source.top_up_eligible,
    p_actor_user_id
  FROM public.billing_plan_versions
  WHERE plan_id = v_plan_id
  RETURNING id INTO v_new_version_id;

  INSERT INTO public.billing_plan_entitlements (
    plan_version_id,
    entitlement_key,
    entitlement_value
  )
  SELECT v_new_version_id, entitlement_key, entitlement_value
  FROM public.billing_plan_entitlements
  WHERE plan_version_id = v_source.id;

  INSERT INTO public.admin_audit_events (actor_user_id, action, metadata)
  VALUES (
    p_actor_user_id,
    'billing.plan_draft_created',
    jsonb_build_object(
      'plan_code', p_plan_code,
      'source_version_id', v_source.id,
      'plan_version_id', v_new_version_id,
      'reason', v_reason
    )
  );

  RETURN v_new_version_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_publish_billing_plan(
  p_actor_user_id uuid,
  p_plan_code text,
  p_reason text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan_id uuid;
  v_draft_id uuid;
  v_previous_id uuid;
  v_reason text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_admins WHERE user_id = p_actor_user_id
  ) THEN
    RAISE EXCEPTION 'PLATFORM_ADMIN_REQUIRED';
  END IF;

  v_reason := nullif(btrim(p_reason), '');
  IF v_reason IS NULL OR char_length(v_reason) < 3 THEN
    RAISE EXCEPTION 'BILLING_PUBLISH_REASON_REQUIRED';
  END IF;

  SELECT id INTO v_plan_id
  FROM public.billing_plans
  WHERE code = p_plan_code
  FOR UPDATE;

  IF v_plan_id IS NULL THEN
    RAISE EXCEPTION 'BILLING_PLAN_NOT_FOUND';
  END IF;

  SELECT id INTO v_draft_id
  FROM public.billing_plan_versions
  WHERE plan_id = v_plan_id AND status = 'draft'
  ORDER BY version DESC
  LIMIT 1
  FOR UPDATE;

  IF v_draft_id IS NULL THEN
    RAISE EXCEPTION 'BILLING_PLAN_DRAFT_NOT_FOUND';
  END IF;

  SELECT id INTO v_previous_id
  FROM public.billing_plan_versions
  WHERE plan_id = v_plan_id AND status = 'published'
  FOR UPDATE;

  IF v_previous_id IS NOT NULL THEN
    UPDATE public.billing_plan_versions
    SET status = 'retired', retired_at = now()
    WHERE id = v_previous_id;
  END IF;

  UPDATE public.billing_plan_versions
  SET status = 'published',
      effective_from = now(),
      published_at = now()
  WHERE id = v_draft_id;

  INSERT INTO public.admin_audit_events (actor_user_id, action, metadata)
  VALUES (
    p_actor_user_id,
    'billing.plan_published',
    jsonb_build_object(
      'plan_code', p_plan_code,
      'plan_version_id', v_draft_id,
      'retired_version_id', v_previous_id,
      'reason', v_reason
    )
  );

  RETURN v_draft_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_save_billing_plan_draft(
  uuid, text, text, integer, integer, integer, integer, boolean, jsonb, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_create_billing_plan_draft(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_publish_billing_plan(uuid, text, text) FROM PUBLIC;

-- Seed the versioned entitlement source. Values are editable through a new
-- draft and never read from application constants at runtime.
INSERT INTO public.billing_plan_entitlements (
  plan_version_id,
  entitlement_key,
  entitlement_value
)
SELECT version.id, seed.key, seed.value
FROM public.billing_plan_versions version
JOIN public.billing_plans plan ON plan.id = version.plan_id
CROSS JOIN LATERAL jsonb_each(
  CASE plan.code
    WHEN 'free' THEN jsonb_build_object(
      'generation.max_concurrent_jobs', 1,
      'generation.allowed_model_groups', jsonb_build_array('free'),
      'image.max_quality', 'standard',
      'video.max_resolution', '720p',
      'projects.max_count', 3,
      'brand_kits.max_count', 1,
      'team.max_seats', 1,
      'generation.watermark', true,
      'queue.priority', 'standard',
      'api.enabled', false
    )
    WHEN 'pro' THEN jsonb_build_object(
      'generation.max_concurrent_jobs', 4,
      'generation.allowed_model_groups', jsonb_build_array('free', 'standard', 'advanced'),
      'image.max_quality', 'hd',
      'video.max_resolution', '1080p',
      'projects.max_count', 50,
      'brand_kits.max_count', 10,
      'team.max_seats', 1,
      'generation.watermark', false,
      'queue.priority', 'standard',
      'api.enabled', false
    )
    WHEN 'team' THEN jsonb_build_object(
      'generation.max_concurrent_jobs', 8,
      'generation.allowed_model_groups', jsonb_build_array('free', 'standard', 'advanced', 'premium'),
      'image.max_quality', 'ultra',
      'video.max_resolution', '4k',
      'projects.max_count', 200,
      'brand_kits.max_count', 30,
      'team.max_seats', 3,
      'generation.watermark', false,
      'queue.priority', 'high',
      'api.enabled', false
    )
    ELSE jsonb_build_object(
      'generation.max_concurrent_jobs', 12,
      'generation.allowed_model_groups', jsonb_build_array('free', 'standard', 'advanced', 'premium'),
      'image.max_quality', 'ultra',
      'video.max_resolution', '4k',
      'projects.max_count', -1,
      'brand_kits.max_count', 100,
      'team.max_seats', 10,
      'generation.watermark', false,
      'queue.priority', 'highest',
      'api.enabled', true
    )
  END
) AS seed(key, value)
WHERE version.version = 1
ON CONFLICT (plan_version_id, entitlement_key) DO NOTHING;

-- Publish the initial development catalog so runtime and /pricing have one
-- authoritative database version immediately after migration.
UPDATE public.billing_plan_versions
SET status = 'published',
    effective_from = coalesce(effective_from, now()),
    published_at = coalesce(published_at, now())
WHERE version = 1 AND status = 'draft';

-- Free workspaces without an explicit versioned subscription resolve through
-- the published free plan. Existing paid workspaces remain pinned to the
-- version they purchased until an explicit subscription migration occurs.

COMMENT ON FUNCTION public.admin_publish_billing_plan(uuid, text, text) IS
  'Atomically retires the current published plan version and publishes its draft.';
