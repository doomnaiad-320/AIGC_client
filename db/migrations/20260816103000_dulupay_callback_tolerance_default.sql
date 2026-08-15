-- Keep the DuluPay replay window narrow by default. Existing untouched,
-- disabled configurations are safe to update because no merchant is active.

ALTER TABLE public.payment_provider_configs
  ALTER COLUMN callback_tolerance_seconds SET DEFAULT 300;

UPDATE public.payment_provider_configs
SET callback_tolerance_seconds = 300,
    updated_at = now()
WHERE provider_code = 'dulupay'
  AND NOT enabled
  AND merchant_id IS NULL
  AND merchant_private_key_ciphertext IS NULL
  AND callback_tolerance_seconds = 86400;
