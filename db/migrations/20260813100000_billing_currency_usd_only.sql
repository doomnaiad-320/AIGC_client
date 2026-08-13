-- Loomic uses USD as its single billing and reporting currency. Keep the
-- currency columns for immutable historical records and future migrations,
-- but reject non-USD catalog and order data at the database boundary.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.billing_plan_versions WHERE currency <> 'USD'
  ) OR EXISTS (
    SELECT 1 FROM public.billing_top_up_packs WHERE currency <> 'USD'
  ) OR EXISTS (
    SELECT 1 FROM public.billing_payment_orders WHERE currency <> 'USD'
  ) THEN
    RAISE EXCEPTION
      'NON_USD_BILLING_DATA_EXISTS: resolve existing non-USD records before applying this migration';
  END IF;
END;
$$;

ALTER TABLE public.billing_plan_versions
  DROP CONSTRAINT billing_plan_versions_currency_check,
  ADD CONSTRAINT billing_plan_versions_currency_check
    CHECK (currency = 'USD');

ALTER TABLE public.billing_top_up_packs
  DROP CONSTRAINT billing_top_up_packs_currency_check,
  ADD CONSTRAINT billing_top_up_packs_currency_check
    CHECK (currency = 'USD');

ALTER TABLE public.billing_payment_orders
  DROP CONSTRAINT billing_payment_orders_currency_check,
  ADD CONSTRAINT billing_payment_orders_currency_check
    CHECK (currency = 'USD');

