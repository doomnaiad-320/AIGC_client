-- Index foreign keys introduced by the configurable payment-provider schema.
-- PostgreSQL does not create indexes for referencing columns automatically.

CREATE INDEX IF NOT EXISTS payment_provider_configs_updated_by_idx
  ON public.payment_provider_configs(updated_by)
  WHERE updated_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS billing_payment_orders_created_by_idx
  ON public.billing_payment_orders(created_by)
  WHERE created_by IS NOT NULL;
