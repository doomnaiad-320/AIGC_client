CREATE INDEX IF NOT EXISTS credit_ledger_billing_month_idx
  ON public.credit_ledger(created_at DESC)
  WHERE entry_type IN ('grant', 'admin_adjustment', 'deduct');

COMMENT ON INDEX public.credit_ledger_billing_month_idx IS
  'Supports platform billing statistics grouped over recent credit ledger activity.';
