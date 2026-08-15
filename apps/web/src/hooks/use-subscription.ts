// @credits-system — React hook for subscription status, cancellation, and plan changes
"use client";

import { useAuth } from "@/lib/auth-context";
import {
  type SubscriptionStatus,
  cancelSubscription as apiCancelSubscription,
  changePlan as apiChangePlan,
  resumeSubscription as apiResumeSubscription,
  getSubscription,
} from "@/lib/payments-api";
import type { BillingPeriod, BillingPlanCode } from "@loomic/shared";
import { useCallback, useEffect, useRef, useState } from "react";

interface UseSubscriptionReturn {
  subscription: SubscriptionStatus | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  cancel: () => Promise<void>;
  resume: () => Promise<void>;
  changePlan: (
    plan: BillingPlanCode,
    billingPeriod: BillingPeriod,
  ) => Promise<void>;
}

export function useSubscription(): UseSubscriptionReturn {
  const { session } = useAuth();
  const accessTokenRef = useRef(session?.access_token);
  accessTokenRef.current = session?.access_token;

  const [subscription, setSubscription] = useState<SubscriptionStatus | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const token = accessTokenRef.current;
    if (!token) return;
    try {
      const result = await getSubscription(token);
      setSubscription(result);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to fetch subscription",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!session?.access_token) {
      setLoading(false);
      return;
    }
    refresh();
  }, [session?.access_token, refresh]);

  const cancel = useCallback(async () => {
    const token = accessTokenRef.current;
    if (!token) throw new Error("Not authenticated");
    await apiCancelSubscription(token);
    await refresh();
  }, [refresh]);

  const resume = useCallback(async () => {
    const token = accessTokenRef.current;
    if (!token) throw new Error("Not authenticated");
    await apiResumeSubscription(token);
    await refresh();
  }, [refresh]);

  const changePlan = useCallback(
    async (plan: BillingPlanCode, billingPeriod: BillingPeriod) => {
      const token = accessTokenRef.current;
      if (!token) throw new Error("Not authenticated");
      await apiChangePlan(token, plan, billingPeriod);
      await refresh();
    },
    [refresh],
  );

  return {
    subscription,
    loading,
    error,
    refresh,
    cancel,
    resume,
    changePlan,
  };
}
