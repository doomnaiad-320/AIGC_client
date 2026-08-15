// @credits-system — Payment lifecycle: checkout creation, subscription sync, cancellation, plan changes
import type { BillingPeriod, BillingPlanCode } from "@loomic/shared";

import type { AdminDbClient } from "../../db/client.js";
import type { LemonSqueezyClient } from "./lemon-squeezy-client.js";

// ── Error ────────────────────────────────────────────────────

export class PaymentServiceError extends Error {
  readonly statusCode: number;
  readonly code:
    | "payment_not_configured"
    | "variant_not_found"
    | "checkout_failed"
    | "subscription_not_found"
    | "subscription_update_failed"
    | "webhook_processing_failed";

  constructor(
    code: PaymentServiceError["code"],
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.name = "PaymentServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ── Types ────────────────────────────────────────────────────

export type SubscriptionStatus = {
  plan: BillingPlanCode;
  planName: string | null;
  billingPeriod: BillingPeriod | null;
  status: string | null;
  provider: string | null;
  lemonSqueezySubscriptionId: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  creditPeriodStart: string | null;
  creditPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  customerPortalUrl: string | null;
  monthlyCredits: number;
  currency: "USD";
};

export type VariantMap = Record<string, string>;

export type PaymentService = {
  createCheckout(
    workspaceId: string,
    actorUserId: string,
    planId: BillingPlanCode,
    billingPeriod: BillingPeriod,
  ): Promise<{ activated: boolean; checkoutUrl: string | null }>;

  handleWebhookEvent(
    eventName: string,
    payload: WebhookPayload,
    context: WebhookEventContext,
  ): Promise<void>;

  getSubscriptionStatus(
    workspaceId: string,
    actorUserId: string,
  ): Promise<SubscriptionStatus>;

  cancelSubscription(workspaceId: string, actorUserId: string): Promise<void>;

  resumeSubscription(workspaceId: string, actorUserId: string): Promise<void>;

  changePlan(
    workspaceId: string,
    actorUserId: string,
    newPlanId: BillingPlanCode,
    billingPeriod: BillingPeriod,
  ): Promise<void>;
};

export type WebhookEventContext = {
  providerEventId: string;
  receivedAt: string;
};

export type WebhookPayload = {
  meta: {
    event_name: string;
    custom_data?: { workspace_id?: string };
  };
  data: {
    id: string;
    type: string;
    attributes: {
      store_id: number;
      customer_id: number;
      order_id: number;
      variant_id: number;
      status: string;
      renews_at: string | null;
      ends_at: string | null;
      cancelled?: boolean;
      created_at?: string;
      updated_at?: string;
      urls?: {
        customer_portal?: string;
        update_payment_method?: string;
      };
      [key: string]: unknown;
    };
  };
};

type LegacySubscriptionRow = {
  billing_period: BillingPeriod | null;
  canceled_at: string | null;
  current_period_end: string | null;
  current_period_start: string | null;
  lemon_squeezy_subscription_id: string | null;
  plan: string;
};

type CanonicalSubscriptionRow = {
  billingPeriod: BillingPeriod | null;
  canceledAt: string | null;
  cancelAtPeriodEnd: boolean;
  creditPeriodEnd: string | null;
  creditPeriodStart: string | null;
  currentPeriodEnd: string | null;
  currentPeriodStart: string | null;
  monthlyCredits: number;
  plan: BillingPlanCode;
  planName: string;
  provider: string | null;
  providerSubscriptionId: string | null;
  status: string;
};

// ── Factory ──────────────────────────────────────────────────

export function createPaymentService(options: {
  lemonSqueezy: LemonSqueezyClient;
  getAdminClient: () => AdminDbClient;
  variantMap: VariantMap;
  webOrigin: string;
}): PaymentService {
  const { lemonSqueezy, getAdminClient, variantMap, webOrigin } = options;

  // Build reverse lookup: variantId -> "plan_period"
  const reverseVariantMap = new Map<
    string,
    { plan: BillingPlanCode; period: BillingPeriod }
  >();
  for (const [key, variantId] of Object.entries(variantMap)) {
    if (!variantId) continue;
    const [plan, period] = key.split("_") as [string, BillingPeriod];
    reverseVariantMap.set(variantId, {
      plan: catalogPlanFromLegacy(plan),
      period,
    });
  }

  function lookupVariant(
    planId: BillingPlanCode,
    billingPeriod: BillingPeriod,
  ): string {
    const key = `${legacyVariantPlan(planId)}_${billingPeriod}`;
    const variantId = variantMap[key];
    if (!variantId) {
      throw new PaymentServiceError(
        "variant_not_found",
        `No Lemon Squeezy variant configured for ${key}. Set the corresponding LEMONSQUEEZY_VARIANT env var.`,
        400,
      );
    }
    return variantId;
  }

  function resolvePlanFromVariant(variantId: number): {
    plan: BillingPlanCode;
    period: BillingPeriod;
  } | null {
    return reverseVariantMap.get(String(variantId)) ?? null;
  }

  return {
    async createCheckout(workspaceId, _actorUserId, planId, billingPeriod) {
      const variantId = lookupVariant(planId, billingPeriod);
      const redirectUrl = `${webOrigin}/settings?checkout=success`;

      const result = await lemonSqueezy.createCheckout(
        variantId,
        workspaceId,
        redirectUrl,
      );

      return { activated: false, checkoutUrl: result.checkoutUrl };
    },

    async handleWebhookEvent(eventName, payload, context) {
      const workspaceId = payload.meta.custom_data?.workspace_id;
      const attrs = payload.data.attributes;
      const subscriptionId = payload.data.id;
      const resolved = resolvePlanFromVariant(attrs.variant_id);
      const periodStart =
        normalizeWebhookTimestamp(attrs.updated_at) ??
        normalizeWebhookTimestamp(attrs.created_at) ??
        context.receivedAt;
      const periodEnd =
        normalizeWebhookTimestamp(attrs.renews_at) ??
        normalizeWebhookTimestamp(attrs.ends_at);
      const cancelAtPeriodEnd =
        attrs.cancelled ??
        (eventName === "subscription_cancelled"
          ? true
          : eventName === "subscription_created" ||
              eventName === "subscription_payment_success"
            ? false
            : null);

      const { error } = await getAdminClient().query(
        `select public.billing_process_lemon_squeezy_webhook(
           $1::text, $2::text, $3::uuid, $4::text, $5::text,
           $6::text, $7::text, $8::text, $9::text, $10::text,
           $11::timestamptz, $12::timestamptz, $13::boolean,
           $14::timestamptz, $15::jsonb
         ) as result`,
        [
          context.providerEventId,
          eventName,
          workspaceId ?? null,
          subscriptionId,
          stringValue(attrs.customer_id),
          stringValue(attrs.variant_id),
          stringValue(attrs.order_id),
          resolved?.plan ?? null,
          resolved?.period ?? null,
          attrs.status ?? null,
          periodStart,
          periodEnd,
          cancelAtPeriodEnd,
          normalizeWebhookTimestamp(attrs.ends_at),
          JSON.stringify(payload),
        ],
      );

      if (error) {
        throw new PaymentServiceError(
          "webhook_processing_failed",
          error.message,
          500,
        );
      }
    },

    async getSubscriptionStatus(workspaceId, _actorUserId) {
      const { data, error } =
        await getAdminClient().query<CanonicalSubscriptionRow>(
          `select
           plan.code as "plan",
           plan.name_zh as "planName",
           subscription.billing_period as "billingPeriod",
           subscription.status,
           subscription.provider,
           subscription.provider_subscription_id as "providerSubscriptionId",
           subscription.current_period_start as "currentPeriodStart",
           subscription.current_period_end as "currentPeriodEnd",
           subscription.credit_period_start as "creditPeriodStart",
           subscription.credit_period_end as "creditPeriodEnd",
           subscription.cancel_at_period_end as "cancelAtPeriodEnd",
           subscription.canceled_at as "canceledAt",
           version.monthly_subscription_credits as "monthlyCredits"
         from public.workspace_billing_subscriptions subscription
         join public.billing_plan_versions version
           on version.id = subscription.plan_version_id
         join public.billing_plans plan on plan.id = version.plan_id
         where subscription.workspace_id = $1::uuid
           and subscription.status in ('trialing', 'active', 'past_due', 'canceled')
         order by subscription.created_at desc
         limit 1`,
          [workspaceId],
        );

      if (error) {
        throw new PaymentServiceError(
          "subscription_not_found",
          "Failed to query subscription.",
          500,
        );
      }

      const subscription = data?.[0] ?? null;
      let customerPortalUrl: string | null = null;
      const lsSubId =
        subscription?.provider === "lemon_squeezy"
          ? subscription.providerSubscriptionId
          : null;
      if (lsSubId) {
        try {
          const lsSub = await lemonSqueezy.getSubscription(lsSubId);
          customerPortalUrl = lsSub.attributes.urls.customer_portal ?? null;
        } catch {
          // Non-critical — we can still return status without the portal URL
        }
      }

      return {
        plan: subscription?.plan ?? "free",
        planName: subscription?.planName ?? null,
        billingPeriod: subscription?.billingPeriod ?? null,
        status: subscription?.status ?? null,
        provider: subscription?.provider ?? null,
        lemonSqueezySubscriptionId: lsSubId ?? null,
        currentPeriodStart: subscription?.currentPeriodStart ?? null,
        currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
        creditPeriodStart: subscription?.creditPeriodStart ?? null,
        creditPeriodEnd: subscription?.creditPeriodEnd ?? null,
        cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
        canceledAt: subscription?.canceledAt ?? null,
        customerPortalUrl,
        monthlyCredits: Number(subscription?.monthlyCredits ?? 0),
        currency: "USD",
      };
    },

    async cancelSubscription(workspaceId, _actorUserId) {
      const admin = getAdminClient();

      const { data } = await admin
        .from<Pick<LegacySubscriptionRow, "lemon_squeezy_subscription_id">>(
          "subscriptions",
        )
        .select("lemon_squeezy_subscription_id")
        .eq("workspace_id", workspaceId)
        .maybeSingle();

      const lsSubId = data?.lemon_squeezy_subscription_id ?? null;
      if (!lsSubId) {
        throw new PaymentServiceError(
          "subscription_not_found",
          "No active Lemon Squeezy subscription found for this workspace.",
          404,
        );
      }

      // Cancel at period end via the LS API
      await lemonSqueezy.cancelSubscription(lsSubId);

      // The webhook will update canceled_at, but we can set it optimistically
      // (the webhook handler also handles this, so it's idempotent)
    },

    async resumeSubscription(workspaceId, _actorUserId) {
      const admin = getAdminClient();
      const { data } = await admin
        .from<Pick<LegacySubscriptionRow, "lemon_squeezy_subscription_id">>(
          "subscriptions",
        )
        .select("lemon_squeezy_subscription_id")
        .eq("workspace_id", workspaceId)
        .maybeSingle();
      const lsSubId = data?.lemon_squeezy_subscription_id ?? null;
      if (!lsSubId) {
        throw new PaymentServiceError(
          "subscription_not_found",
          "No active Lemon Squeezy subscription found for this workspace.",
          404,
        );
      }
      await lemonSqueezy.updateSubscription(lsSubId, { cancelled: false });
    },

    async changePlan(workspaceId, _actorUserId, newPlanId, billingPeriod) {
      const admin = getAdminClient();

      const { data } = await admin
        .from<Pick<LegacySubscriptionRow, "lemon_squeezy_subscription_id">>(
          "subscriptions",
        )
        .select("lemon_squeezy_subscription_id")
        .eq("workspace_id", workspaceId)
        .maybeSingle();

      const lsSubId = data?.lemon_squeezy_subscription_id ?? null;
      if (!lsSubId) {
        throw new PaymentServiceError(
          "subscription_not_found",
          "No active Lemon Squeezy subscription found for this workspace.",
          404,
        );
      }

      const newVariantId = lookupVariant(newPlanId, billingPeriod);

      await lemonSqueezy.updateSubscription(lsSubId, {
        variant_id: Number.parseInt(newVariantId, 10),
        invoice_immediately: true,
      });

      // The webhook (subscription_updated) will handle the DB update
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────

function normalizeWebhookTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function stringValue(value: unknown): string | null {
  if (value == null) return null;
  return String(value);
}

function legacyVariantPlan(plan: BillingPlanCode) {
  if (plan === "team") return "ultra";
  if (plan === "enterprise") return "business";
  return plan;
}

function catalogPlanFromLegacy(plan: string): BillingPlanCode {
  if (plan === "ultra") return "team";
  if (plan === "business") return "enterprise";
  if (plan === "starter") return "pro";
  if (
    plan === "free" ||
    plan === "pro" ||
    plan === "team" ||
    plan === "enterprise"
  ) {
    return plan;
  }
  return "free";
}

// ── Variant map builder ──────────────────────────────────────

/**
 * Build a variant map from ServerEnv.
 * Keys are "plan_period" (e.g. "starter_monthly"), values are variant IDs.
 */
export function buildVariantMap(env: {
  lemonSqueezyVariantStarterMonthly?: string;
  lemonSqueezyVariantStarterYearly?: string;
  lemonSqueezyVariantProMonthly?: string;
  lemonSqueezyVariantProYearly?: string;
  lemonSqueezyVariantUltraMonthly?: string;
  lemonSqueezyVariantUltraYearly?: string;
  lemonSqueezyVariantBusinessMonthly?: string;
  lemonSqueezyVariantBusinessYearly?: string;
}): VariantMap {
  const map: VariantMap = {};
  if (env.lemonSqueezyVariantStarterMonthly)
    map.starter_monthly = env.lemonSqueezyVariantStarterMonthly;
  if (env.lemonSqueezyVariantStarterYearly)
    map.starter_yearly = env.lemonSqueezyVariantStarterYearly;
  if (env.lemonSqueezyVariantProMonthly)
    map.pro_monthly = env.lemonSqueezyVariantProMonthly;
  if (env.lemonSqueezyVariantProYearly)
    map.pro_yearly = env.lemonSqueezyVariantProYearly;
  if (env.lemonSqueezyVariantUltraMonthly)
    map.ultra_monthly = env.lemonSqueezyVariantUltraMonthly;
  if (env.lemonSqueezyVariantUltraYearly)
    map.ultra_yearly = env.lemonSqueezyVariantUltraYearly;
  if (env.lemonSqueezyVariantBusinessMonthly)
    map.business_monthly = env.lemonSqueezyVariantBusinessMonthly;
  if (env.lemonSqueezyVariantBusinessYearly)
    map.business_yearly = env.lemonSqueezyVariantBusinessYearly;
  return map;
}
