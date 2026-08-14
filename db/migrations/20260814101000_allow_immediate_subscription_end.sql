-- An immediate plan change closes the previous subscription at its start time
-- when the user changes plans directly after activation. A zero-length closed
-- period is valid history; active periods still receive an end after their start.

ALTER TABLE public.workspace_billing_subscriptions
  DROP CONSTRAINT workspace_billing_subscriptions_current_period_check,
  ADD CONSTRAINT workspace_billing_subscriptions_current_period_check
    CHECK (
      current_period_start IS NULL
      OR current_period_end IS NULL
      OR current_period_end >= current_period_start
    );
