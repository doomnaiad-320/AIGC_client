"use client";

import { motion } from "framer-motion";

import { PricingCard } from "./pricing-card";
import type { BillingPeriod } from "./pricing-data";
import { type PricingTier, staggerContainer } from "./pricing-data";

interface PricingCardsProps {
  billingPeriod: BillingPeriod;
  currentPlan?: string | null | undefined;
  onCheckout?:
    | ((plan: string, billingPeriod: BillingPeriod) => Promise<void>)
    | undefined;
  tiers: PricingTier[];
}

export function PricingCards({
  billingPeriod,
  currentPlan,
  onCheckout,
  tiers,
}: PricingCardsProps) {
  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.2 }}
      className="mx-auto grid max-w-6xl grid-cols-1 gap-6 md:grid-cols-3"
    >
      {tiers.map((tier, index) => (
        <PricingCard
          key={tier.id}
          tier={tier}
          billingPeriod={billingPeriod}
          index={index}
          {...(currentPlan !== undefined ? { currentPlan } : {})}
          {...(onCheckout !== undefined ? { onCheckout } : {})}
        />
      ))}
    </motion.div>
  );
}
