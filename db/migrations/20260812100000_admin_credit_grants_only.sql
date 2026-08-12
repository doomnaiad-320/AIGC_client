-- Administrator credit operations are grants only. Generation deductions and
-- refunds continue to use their dedicated ledger functions.
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

  IF p_amount <= 0 OR p_amount > 500000 THEN
    RAISE EXCEPTION 'ADMIN_CREDIT_GRANT_AMOUNT_INVALID';
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
