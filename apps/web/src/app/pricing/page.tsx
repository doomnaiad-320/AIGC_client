"use client";

import type { BillingPlanCode, PublishedBillingPlan } from "@loomic/shared";
import { BadgeAlert, Settings } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useSubscription } from "@/hooks/use-subscription";
import { useAuth } from "@/lib/auth-context";
import { changePlan, createCheckout } from "@/lib/payments-api";

import { PricingCards } from "./components/pricing-cards";
import { PricingComparison } from "./components/pricing-comparison";
import { PricingCTA } from "./components/pricing-cta";
import type { BillingPeriod } from "./components/pricing-data";
import { buildPricingData } from "./components/pricing-data";
import { PricingFAQ } from "./components/pricing-faq";
import { PricingHero } from "./components/pricing-hero";
import { PricingNav } from "./components/pricing-nav";
import { PricingToggle } from "./components/pricing-toggle";

export default function PricingPage() {
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>("yearly");
  const { session } = useAuth();
  const { subscription, refresh: refreshSubscription } = useSubscription();
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [publishedPlans, setPublishedPlans] = useState<PublishedBillingPlan[]>(
    [],
  );

  useEffect(() => {
    fetch(
      `${process.env.NEXT_PUBLIC_SERVER_BASE_URL?.trim() || "http://localhost:3001"}/api/billing/plans`,
    )
      .then((response) =>
        response.ok
          ? response.json()
          : Promise.reject(new Error("无法加载套餐")),
      )
      .then((result: { plans: PublishedBillingPlan[] }) =>
        setPublishedPlans(result.plans),
      )
      .catch(() => setCheckoutError("暂时无法加载套餐配置，请稍后重试。"));
  }, []);

  const pricingData = useMemo(
    () => buildPricingData(publishedPlans),
    [publishedPlans],
  );

  const handleCheckout = useCallback(
    async (plan: string, period: BillingPeriod) => {
      const token = session?.access_token;
      if (!token) {
        window.location.href = "/login?redirect=/pricing";
        return;
      }

      setCheckoutError(null);
      try {
        const selectedPlan = plan as BillingPlanCode;
        if (subscription?.plan && subscription.plan !== "free") {
          await changePlan(token, selectedPlan, period);
          await refreshSubscription();
          window.location.assign("/settings?tab=billing&subscription=changed");
          return;
        }
        const result = await createCheckout(token, selectedPlan, period);
        if (result.activated) {
          await refreshSubscription();
          window.location.assign(
            result.checkoutUrl ??
              "/settings?tab=billing&subscription=activated",
          );
          return;
        }
        if (!result.checkoutUrl) {
          throw new Error("结算地址不可用，请稍后重试。");
        }
        window.location.assign(result.checkoutUrl);
      } catch (error) {
        setCheckoutError(
          error instanceof Error
            ? error.message
            : "暂时无法发起支付，请稍后重试。",
        );
      }
    },
    [refreshSubscription, session?.access_token, subscription?.plan],
  );

  const hasActiveSubscription =
    subscription?.plan && subscription.plan !== "free";

  return (
    <div className="min-h-screen bg-background">
      <PricingNav />

      <main>
        <PricingHero />

        {hasActiveSubscription && (
          <div className="mx-auto mb-6 flex max-w-md items-center justify-center gap-3 rounded-lg border bg-card px-4 py-3 text-sm">
            <span className="text-muted-foreground">
              当前套餐：{" "}
              <span className="font-medium text-foreground capitalize">
                {subscription.plan}
              </span>{" "}
              plan.
            </span>
            <Link
              href="/settings?tab=billing"
              className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
            >
              <Settings className="h-3.5 w-3.5" />
              管理订阅
            </Link>
          </div>
        )}

        {checkoutError && (
          <div
            className="mx-auto mb-6 flex max-w-2xl items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
            role="alert"
          >
            <BadgeAlert className="mt-0.5 size-4 shrink-0" />
            <span>{checkoutError}</span>
          </div>
        )}

        {/* Billing toggle + cards */}
        <section className="px-6">
          <div className="mb-10 flex justify-center">
            <PricingToggle value={billingPeriod} onChange={setBillingPeriod} />
          </div>
          <PricingCards
            billingPeriod={billingPeriod}
            currentPlan={subscription?.plan ?? null}
            onCheckout={handleCheckout}
            tiers={pricingData.pricingTiers}
          />
        </section>

        {/* Feature comparison */}
        <div id="features">
          <PricingComparison
            featureCategories={pricingData.featureCategories}
            pricingTiers={pricingData.pricingTiers}
          />
        </div>

        <PricingFAQ />
        <PricingCTA />
      </main>
    </div>
  );
}
