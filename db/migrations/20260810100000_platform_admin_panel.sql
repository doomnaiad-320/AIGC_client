-- Platform administration is separate from workspace owner/admin roles.
-- These tables are only accessed through the server-side admin API.

CREATE TABLE public.platform_admins (
  user_id uuid PRIMARY KEY REFERENCES public.app_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.app_users(id) ON DELETE SET NULL,
  note text NOT NULL DEFAULT ''
);

CREATE TABLE public.admin_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES public.app_users(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (char_length(btrim(action)) > 0),
  target_user_id uuid REFERENCES public.app_users(id) ON DELETE SET NULL,
  target_workspace_id uuid REFERENCES public.workspaces(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX admin_audit_events_created_at_idx
  ON public.admin_audit_events(created_at DESC);
CREATE INDEX admin_audit_events_actor_created_at_idx
  ON public.admin_audit_events(actor_user_id, created_at DESC);
CREATE INDEX admin_audit_events_target_user_created_at_idx
  ON public.admin_audit_events(target_user_id, created_at DESC)
  WHERE target_user_id IS NOT NULL;

ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_audit_events ENABLE ROW LEVEL SECURITY;

-- A server-mediated atomic adjustment. It keeps the balance, immutable credit
-- ledger, and the operating audit trail consistent under concurrent requests.
CREATE OR REPLACE FUNCTION public.admin_adjust_credits(
  p_workspace_id uuid,
  p_target_user_id uuid,
  p_actor_user_id uuid,
  p_amount integer,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance integer;
  v_new_balance integer;
  v_version integer;
  v_transaction_id uuid;
  v_reason text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.platform_admins
    WHERE user_id = p_actor_user_id
  ) THEN
    RAISE EXCEPTION 'PLATFORM_ADMIN_REQUIRED';
  END IF;

  IF p_amount = 0 THEN
    RAISE EXCEPTION 'ADJUSTMENT_AMOUNT_MUST_NOT_BE_ZERO';
  END IF;

  v_reason := nullif(btrim(p_reason), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'ADJUSTMENT_REASON_REQUIRED';
  END IF;

  SELECT balance, version
  INTO v_balance, v_version
  FROM public.credit_balances
  WHERE workspace_id = p_workspace_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_BALANCE: No credit balance found for workspace %', p_workspace_id;
  END IF;

  v_new_balance := v_balance + p_amount;
  IF v_new_balance < 0 THEN
    RAISE EXCEPTION 'INSUFFICIENT_CREDITS: have %, adjustment %', v_balance, p_amount;
  END IF;

  UPDATE public.credit_balances
  SET balance = v_new_balance,
      version = v_version + 1,
      updated_at = now()
  WHERE workspace_id = p_workspace_id
    AND version = v_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONCURRENT_MODIFICATION: credit balance was modified concurrently';
  END IF;

  INSERT INTO public.credit_transactions (
    workspace_id,
    user_id,
    transaction_type,
    amount,
    balance_after,
    description,
    metadata
  ) VALUES (
    p_workspace_id,
    p_target_user_id,
    'admin_adjustment',
    p_amount,
    v_new_balance,
    v_reason,
    jsonb_build_object('actor_user_id', p_actor_user_id)
  )
  RETURNING id INTO v_transaction_id;

  INSERT INTO public.admin_audit_events (
    actor_user_id,
    action,
    target_user_id,
    target_workspace_id,
    metadata
  ) VALUES (
    p_actor_user_id,
    'credits.adjusted',
    p_target_user_id,
    p_workspace_id,
    jsonb_build_object(
      'amount', p_amount,
      'balance_before', v_balance,
      'balance_after', v_new_balance,
      'reason', v_reason,
      'credit_transaction_id', v_transaction_id
    )
  );

  RETURN jsonb_build_object(
    'transaction_id', v_transaction_id,
    'balance', v_new_balance
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_adjust_credits(uuid, uuid, uuid, integer, text) FROM PUBLIC;
