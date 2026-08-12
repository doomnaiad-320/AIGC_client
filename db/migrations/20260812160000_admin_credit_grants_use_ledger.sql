-- Route administrator credit grants through the source-aware ledger. The old
-- aggregate balance remains a projection and is updated in the same transaction.

CREATE OR REPLACE FUNCTION public.admin_adjust_credits(
  p_workspace_id uuid,
  p_target_user_id uuid,
  p_actor_user_id uuid,
  p_amount integer,
  p_reason text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance integer;
  v_new_balance integer;
  v_reason text;
  v_business_key text;
  v_batch_id uuid;
  v_ledger_id uuid;
  v_legacy_transaction_id uuid;
  v_existing_ledger_id uuid;
  v_existing_balance integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.platform_admins
    WHERE user_id = p_actor_user_id
  ) THEN
    RAISE EXCEPTION 'PLATFORM_ADMIN_REQUIRED';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.workspace_members
    WHERE workspace_id = p_workspace_id
      AND user_id = p_target_user_id
  ) THEN
    RAISE EXCEPTION 'TARGET_USER_NOT_IN_WORKSPACE';
  END IF;

  IF p_amount <= 0 OR p_amount > 500000 THEN
    RAISE EXCEPTION 'ADMIN_CREDIT_GRANT_AMOUNT_INVALID';
  END IF;

  v_reason := nullif(btrim(p_reason), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'ADJUSTMENT_REASON_REQUIRED';
  END IF;

  IF nullif(btrim(p_idempotency_key), '') IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;

  v_business_key := 'admin:' || p_actor_user_id::text || ':' || btrim(p_idempotency_key);

  SELECT balance
  INTO v_balance
  FROM public.credit_balances
  WHERE workspace_id = p_workspace_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_BALANCE: No credit balance found for workspace %', p_workspace_id;
  END IF;

  SELECT id, balance_after
  INTO v_existing_ledger_id, v_existing_balance
  FROM public.credit_ledger
  WHERE workspace_id = p_workspace_id
    AND idempotency_key = v_business_key;

  IF v_existing_ledger_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'transaction_id', v_existing_ledger_id,
      'balance', v_existing_balance
    );
  END IF;

  v_new_balance := v_balance + p_amount;

  INSERT INTO public.credit_grant_batches (
    workspace_id,
    source_type,
    original_amount,
    remaining_amount,
    idempotency_key,
    metadata
  ) VALUES (
    p_workspace_id,
    'admin',
    p_amount,
    p_amount,
    v_business_key,
    jsonb_build_object(
      'actor_user_id', p_actor_user_id,
      'target_user_id', p_target_user_id,
      'reason', v_reason
    )
  )
  RETURNING id INTO v_batch_id;

  UPDATE public.credit_balances
  SET balance = v_new_balance,
      version = version + 1,
      updated_at = now()
  WHERE workspace_id = p_workspace_id;

  INSERT INTO public.credit_ledger (
    workspace_id,
    user_id,
    entry_type,
    amount,
    balance_after,
    idempotency_key,
    description,
    metadata
  ) VALUES (
    p_workspace_id,
    p_target_user_id,
    'admin_adjustment',
    p_amount,
    v_new_balance,
    v_business_key,
    v_reason,
    jsonb_build_object('actor_user_id', p_actor_user_id)
  )
  RETURNING id INTO v_ledger_id;

  INSERT INTO public.credit_ledger_allocations (
    ledger_id,
    grant_batch_id,
    amount
  ) VALUES (
    v_ledger_id,
    v_batch_id,
    p_amount
  );

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
    jsonb_build_object(
      'actor_user_id', p_actor_user_id,
      'credit_ledger_id', v_ledger_id
    )
  )
  RETURNING id INTO v_legacy_transaction_id;

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
      'credit_ledger_id', v_ledger_id,
      'credit_transaction_id', v_legacy_transaction_id,
      'credit_grant_batch_id', v_batch_id,
      'idempotency_key', p_idempotency_key
    )
  );

  RETURN jsonb_build_object(
    'transaction_id', v_ledger_id,
    'balance', v_new_balance
  );
END;
$$;

-- Preserve the previous signature for controlled scripts, but route it through
-- the same ledger. API callers use the explicit idempotency-key overload.
CREATE OR REPLACE FUNCTION public.admin_adjust_credits(
  p_workspace_id uuid,
  p_target_user_id uuid,
  p_actor_user_id uuid,
  p_amount integer,
  p_reason text
) RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.admin_adjust_credits(
    p_workspace_id,
    p_target_user_id,
    p_actor_user_id,
    p_amount,
    p_reason,
    gen_random_uuid()::text
  );
$$;

REVOKE ALL ON FUNCTION public.admin_adjust_credits(uuid, uuid, uuid, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_adjust_credits(uuid, uuid, uuid, integer, text) FROM PUBLIC;

COMMENT ON FUNCTION public.admin_adjust_credits(uuid, uuid, uuid, integer, text, text) IS
  'Creates a permanent administrator credit batch, ledger entry, compatibility transaction, and audit event atomically.';
