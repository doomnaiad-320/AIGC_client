"use client";

import type { SubscriptionPlan } from "@loomic/shared";
import { BadgeAlert, Settings } from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";

import { useSubscription } from "@/hooks/use-subscription";
import { useAuth } from "@/lib/auth-context";
import { changePlan, createCheckout } from "@/lib/payments-api";

import { PricingCards } from "./components/pricing-cards";
import { PricingComparison } from "./components/pricing-comparison";
import { PricingCTA } from "./components/pricing-cta";
import type { BillingPeriod } from "./components/pricing-data";
import { PricingFAQ } from "./components/pricing-faq";
import { PricingHero } from "./components/pricing-hero";
import { PricingNav } from "./components/pricing-nav";
import { PricingToggle } from "./components/pricing-toggle";

function openLemonCheckout(url: string) {
  if (window.LemonSqueezy?.Url?.Open) {
    window.LemonSqueezy.Url.Open(url);
  } else {
    window.open(url, "_blank");
  }
}

export default function PricingPage() {
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>("yearly");
  const { session } = useAuth();
  const { subscription, refresh: refreshSubscription } = useSubscription();
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  const handleCheckout = useCallback(
    async (plan: SubscriptionPlan, period: BillingPeriod) => {
      const token = session?.access_token;
      if (!token) {
        window.location.href = "/login?redirect=/pricing";
        return;
      }

      setCheckoutError(null);
      try {
        if (subscription?.lemonSqueezySubscriptionId) {
          await changePlan(token, plan, period);
          await refreshSubscription();
          return;
        }
        const { checkoutUrl } = await createCheckout(token, plan, period);
        openLemonCheckout(checkoutUrl);
      } catch (error) {
        setCheckoutError(
          error instanceof Error
            ? error.message
            : "暂时无法发起支付，请稍后重试。",
        );
      }
    },
    [
      refreshSubscription,
      session?.access_token,
      subscription?.lemonSqueezySubscriptionId,
    ],
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
          />
        </section>

        {/* Feature comparison */}
        <div id="features">
          <PricingComparison />
        </div>

        <PricingFAQ />
        <PricingCTA />
      </main>
    </div>
  );
}
