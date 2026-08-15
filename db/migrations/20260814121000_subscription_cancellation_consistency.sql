-- Keep cancellation fields internally consistent for every subscription
-- provider. An active subscription that is not scheduled to cancel cannot
-- retain a stale canceled_at timestamp after a resume event.

CREATE OR REPLACE FUNCTION private.billing_normalize_subscription_cancellation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status IN ('trialing', 'active')
    AND NEW.cancel_at_period_end = false
  THEN
    NEW.canceled_at := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS normalize_subscription_cancellation
  ON public.workspace_billing_subscriptions;
CREATE TRIGGER normalize_subscription_cancellation
BEFORE INSERT OR UPDATE OF status, cancel_at_period_end, canceled_at
ON public.workspace_billing_subscriptions
FOR EACH ROW
EXECUTE FUNCTION private.billing_normalize_subscription_cancellation();

REVOKE ALL ON FUNCTION private.billing_normalize_subscription_cancellation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.billing_normalize_subscription_cancellation() TO service_role;
