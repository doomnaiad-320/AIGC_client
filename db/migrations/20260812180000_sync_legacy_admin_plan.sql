-- Keep the legacy administrator plan selector compatible with the versioned
-- runtime catalog until the user-management API adopts billing plan codes.

CREATE OR REPLACE FUNCTION public.sync_workspace_billing_plan_from_legacy(
  p_workspace_id uuid,
  p_legacy_plan public.subscription_plan,
  p_actor_user_id uuid,
  p_reason text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan_code text;
  v_plan_version_id uuid;
  v_subscription_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_admins WHERE user_id = p_actor_user_id
  ) THEN
    RAISE EXCEPTION 'PLATFORM_ADMIN_REQUIRED';
  END IF;

  v_plan_code := CASE p_legacy_plan
    WHEN 'free' THEN 'free'
    WHEN 'starter' THEN 'pro'
    WHEN 'pro' THEN 'pro'
    WHEN 'ultra' THEN 'team'
    WHEN 'business' THEN 'team'
  END;

  SELECT version.id INTO v_plan_version_id
  FROM public.billing_plan_versions version
  JOIN public.billing_plans plan ON plan.id = version.plan_id
  WHERE plan.code = v_plan_code AND version.status = 'published'
  LIMIT 1;

  IF v_plan_version_id IS NULL THEN
    RAISE EXCEPTION 'BILLING_PLAN_PUBLISHED_VERSION_NOT_FOUND';
  END IF;

  SELECT id INTO v_subscription_id
  FROM public.workspace_billing_subscriptions
  WHERE workspace_id = p_workspace_id
    AND status IN ('trialing', 'active', 'past_due', 'canceled')
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_subscription_id IS NULL THEN
    INSERT INTO public.workspace_billing_subscriptions (
      workspace_id,
      plan_version_id,
      status,
      metadata
    ) VALUES (
      p_workspace_id,
      v_plan_version_id,
      'active',
      jsonb_build_object(
        'source', 'admin_legacy_plan_selector',
        'actor_user_id', p_actor_user_id,
        'reason', p_reason
      )
    ) RETURNING id INTO v_subscription_id;
  ELSE
    UPDATE public.workspace_billing_subscriptions
    SET plan_version_id = v_plan_version_id,
        status = 'active',
        billing_period = NULL,
        provider = NULL,
        provider_customer_id = NULL,
        provider_subscription_id = NULL,
        current_period_start = NULL,
        current_period_end = NULL,
        credit_period_start = NULL,
        credit_period_end = NULL,
        cancel_at_period_end = false,
        canceled_at = NULL,
        grace_ends_at = NULL,
        metadata = metadata || jsonb_build_object(
          'source', 'admin_legacy_plan_selector',
          'actor_user_id', p_actor_user_id,
          'reason', p_reason
        ),
        updated_at = now()
    WHERE id = v_subscription_id;
  END IF;

  RETURN v_subscription_id;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_workspace_billing_plan_from_legacy(
  uuid, public.subscription_plan, uuid, text
) FROM PUBLIC;
