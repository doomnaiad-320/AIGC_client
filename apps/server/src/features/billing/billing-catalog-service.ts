import type {
  AdminBillingOverview,
  AdminBillingPlan,
  AdminBillingPlanVersion,
  BillingPlanCode,
  BillingPlanEntitlements,
  ImageQualityLevel,
  PublishedBillingPlan,
  SubscriptionPlan,
  VideoResolution,
} from "@loomic/shared";

import type { AdminDbClient } from "../../db/client.js";

export type RuntimePlanConfig = BillingPlanEntitlements & {
  planCode: BillingPlanCode;
  planName: string;
  planVersionId: string;
  legacyPlan: SubscriptionPlan;
  currency: string;
  monthlyPriceMinor: number;
  annualPriceMinor: number;
  monthlySubscriptionCredits: number;
  dailyCredits: number;
  topUpEligible: boolean;
};

export type BillingCatalogService = {
  listAdminPlans(): Promise<AdminBillingPlan[]>;
  getAdminOverview(): Promise<AdminBillingOverview>;
  listPublishedPlans(): Promise<PublishedBillingPlan[]>;
  getRuntimePlanConfig(workspaceId: string): Promise<RuntimePlanConfig>;
};

type CatalogRow = {
  id: string;
  code: BillingPlanCode;
  nameZh: string;
  descriptionZh: string;
  isPublic: boolean;
  isActive: boolean;
  draft: unknown;
  published: unknown;
  workspaceCount: number | string;
  coveredUserCount: number | string;
  activeSubscriptionCount: number | string;
  monthlyCreditsIssued: number | string;
  monthlyCreditsConsumed: number | string;
};

type OverviewRow = Record<keyof AdminBillingOverview, number | string>;

type RuntimeRow = {
  planCode: BillingPlanCode;
  planName: string;
  planVersionId: string;
  currency: string;
  monthlyPriceMinor: number;
  annualPriceMinor: number;
  monthlySubscriptionCredits: number;
  dailyCredits: number;
  topUpEligible: boolean;
  entitlements: Record<string, unknown> | null;
  legacyPlan: SubscriptionPlan | null;
};

const DEFAULT_ENTITLEMENTS: Record<BillingPlanCode, BillingPlanEntitlements> = {
  free: {
    maxConcurrentJobs: 1,
    allowedModelGroups: ["free"],
    maxImageQuality: "standard",
    maxVideoResolution: "720p",
    maxProjects: 3,
    maxBrandKits: 1,
    maxTeamSeats: 1,
    watermark: true,
    queuePriority: "standard",
    apiEnabled: false,
  },
  pro: {
    maxConcurrentJobs: 4,
    allowedModelGroups: ["free", "standard", "advanced"],
    maxImageQuality: "hd",
    maxVideoResolution: "1080p",
    maxProjects: 50,
    maxBrandKits: 10,
    maxTeamSeats: 1,
    watermark: false,
    queuePriority: "standard",
    apiEnabled: false,
  },
  team: {
    maxConcurrentJobs: 8,
    allowedModelGroups: ["free", "standard", "advanced", "premium"],
    maxImageQuality: "ultra",
    maxVideoResolution: "4k",
    maxProjects: 200,
    maxBrandKits: 30,
    maxTeamSeats: 3,
    watermark: false,
    queuePriority: "high",
    apiEnabled: false,
  },
  enterprise: {
    maxConcurrentJobs: 12,
    allowedModelGroups: ["free", "standard", "advanced", "premium"],
    maxImageQuality: "ultra",
    maxVideoResolution: "4k",
    maxProjects: -1,
    maxBrandKits: 100,
    maxTeamSeats: 10,
    watermark: false,
    queuePriority: "highest",
    apiEnabled: true,
  },
};

export function createBillingCatalogService(options: {
  getAdminClient: () => AdminDbClient;
}): BillingCatalogService {
  return {
    async listAdminPlans() {
      const { data, error } = await options.getAdminClient().query<CatalogRow>(`
        with current_subscriptions as (
          select
            subscription.id,
            subscription.workspace_id,
            subscription.status,
            version.plan_id
          from public.workspace_billing_subscriptions subscription
          join public.billing_plan_versions version
            on version.id = subscription.plan_version_id
          where subscription.status in ('trialing', 'active', 'past_due', 'canceled')
            and (
              subscription.status <> 'canceled'
              or subscription.current_period_end is null
              or subscription.current_period_end > now()
            )
        ), plan_statistics as (
          select
            current_subscription.plan_id,
            count(distinct current_subscription.workspace_id)::int as workspace_count,
            count(distinct member.user_id)::int as covered_user_count,
            count(distinct current_subscription.id) filter (
              where current_subscription.status in ('trialing', 'active')
            )::int as active_subscription_count
          from current_subscriptions current_subscription
          left join public.workspace_members member
            on member.workspace_id = current_subscription.workspace_id
          group by current_subscription.plan_id
        ), monthly_credit_statistics as (
          select
            current_subscription.plan_id,
            coalesce(sum(ledger.amount) filter (
              where ledger.entry_type in ('grant', 'admin_adjustment')
                and ledger.amount > 0
            ), 0)::bigint as monthly_credits_issued,
            coalesce(sum(-ledger.amount) filter (
              where ledger.entry_type = 'deduct' and ledger.amount < 0
            ), 0)::bigint as monthly_credits_consumed
          from current_subscriptions current_subscription
          join public.credit_ledger ledger
            on ledger.workspace_id = current_subscription.workspace_id
            and ledger.created_at >= date_trunc('month', now())
          group by current_subscription.plan_id
        )
        select
          plan.id,
          plan.code,
          plan.name_zh as "nameZh",
          plan.description_zh as "descriptionZh",
          plan.is_public as "isPublic",
          plan.is_active as "isActive",
          coalesce(plan_statistics.workspace_count, 0)::int as "workspaceCount",
          coalesce(plan_statistics.covered_user_count, 0)::int as "coveredUserCount",
          coalesce(plan_statistics.active_subscription_count, 0)::int as "activeSubscriptionCount",
          coalesce(monthly_credit_statistics.monthly_credits_issued, 0)::bigint as "monthlyCreditsIssued",
          coalesce(monthly_credit_statistics.monthly_credits_consumed, 0)::bigint as "monthlyCreditsConsumed",
          (
            select jsonb_build_object(
              'id', version.id,
              'version', version.version,
              'status', version.status,
              'currency', version.currency,
              'monthlyPriceMinor', version.monthly_price_minor,
              'annualPriceMinor', version.annual_price_minor,
              'monthlySubscriptionCredits', version.monthly_subscription_credits,
              'dailyCredits', version.daily_credits,
              'topUpEligible', version.top_up_eligible,
              'effectiveFrom', version.effective_from,
              'publishedAt', version.published_at,
              'createdAt', version.created_at,
              'entitlements', coalesce((
                select jsonb_object_agg(entitlement_key, entitlement_value)
                from public.billing_plan_entitlements entitlement
                where entitlement.plan_version_id = version.id
              ), '{}'::jsonb)
            )
            from public.billing_plan_versions version
            where version.plan_id = plan.id and version.status = 'draft'
            order by version.version desc
            limit 1
          ) as draft,
          (
            select jsonb_build_object(
              'id', version.id,
              'version', version.version,
              'status', version.status,
              'currency', version.currency,
              'monthlyPriceMinor', version.monthly_price_minor,
              'annualPriceMinor', version.annual_price_minor,
              'monthlySubscriptionCredits', version.monthly_subscription_credits,
              'dailyCredits', version.daily_credits,
              'topUpEligible', version.top_up_eligible,
              'effectiveFrom', version.effective_from,
              'publishedAt', version.published_at,
              'createdAt', version.created_at,
              'entitlements', coalesce((
                select jsonb_object_agg(entitlement_key, entitlement_value)
                from public.billing_plan_entitlements entitlement
                where entitlement.plan_version_id = version.id
              ), '{}'::jsonb)
            )
            from public.billing_plan_versions version
            where version.plan_id = plan.id and version.status = 'published'
            limit 1
          ) as published
        from public.billing_plans plan
        left join plan_statistics on plan_statistics.plan_id = plan.id
        left join monthly_credit_statistics on monthly_credit_statistics.plan_id = plan.id
        order by case plan.code
          when 'free' then 1
          when 'pro' then 2
          when 'team' then 3
          else 4
        end
      `);

      if (error)
        throw new Error(`Unable to load billing catalog: ${error.message}`);

      return (data ?? []).map((row) => ({
        id: row.id,
        code: row.code,
        nameZh: row.nameZh,
        descriptionZh: row.descriptionZh,
        isPublic: row.isPublic,
        isActive: row.isActive,
        draft: parseVersion(row.code, row.draft),
        published: parseVersion(row.code, row.published),
        statistics: {
          workspaceCount: Number(row.workspaceCount),
          coveredUserCount: Number(row.coveredUserCount),
          activeSubscriptionCount: Number(row.activeSubscriptionCount),
          monthlyCreditsIssued: Number(row.monthlyCreditsIssued),
          monthlyCreditsConsumed: Number(row.monthlyCreditsConsumed),
        },
      }));
    },

    async getAdminOverview() {
      const { data, error } = await options
        .getAdminClient()
        .query<OverviewRow>(`
        with current_subscriptions as (
          select
            subscription.id,
            subscription.workspace_id,
            subscription.status,
            plan.code
          from public.workspace_billing_subscriptions subscription
          join public.billing_plan_versions version
            on version.id = subscription.plan_version_id
          join public.billing_plans plan on plan.id = version.plan_id
          where subscription.status in ('trialing', 'active', 'past_due', 'canceled')
            and (
              subscription.status <> 'canceled'
              or subscription.current_period_end is null
              or subscription.current_period_end > now()
            )
        ), subscription_totals as (
          select
            count(distinct current_subscription.workspace_id)::int as workspace_count,
            count(distinct current_subscription.workspace_id) filter (
              where current_subscription.code in ('pro', 'team', 'enterprise')
            )::int as paid_workspace_count,
            count(distinct member.user_id)::int as covered_user_count,
            count(distinct current_subscription.id) filter (
              where current_subscription.status in ('trialing', 'active')
            )::int as active_subscription_count
          from current_subscriptions current_subscription
          left join public.workspace_members member
            on member.workspace_id = current_subscription.workspace_id
        ), credit_totals as (
          select
            coalesce(sum(ledger.amount) filter (
              where ledger.entry_type in ('grant', 'admin_adjustment')
                and ledger.amount > 0
            ), 0)::bigint as monthly_credits_issued,
            coalesce(sum(-ledger.amount) filter (
              where ledger.entry_type = 'deduct' and ledger.amount < 0
            ), 0)::bigint as monthly_credits_consumed
          from current_subscriptions current_subscription
          join public.credit_ledger ledger
            on ledger.workspace_id = current_subscription.workspace_id
          where ledger.created_at >= date_trunc('month', now())
        )
        select
          subscription_totals.workspace_count as "workspaceCount",
          subscription_totals.paid_workspace_count as "paidWorkspaceCount",
          subscription_totals.covered_user_count as "coveredUserCount",
          subscription_totals.active_subscription_count as "activeSubscriptionCount",
          credit_totals.monthly_credits_issued as "monthlyCreditsIssued",
          credit_totals.monthly_credits_consumed as "monthlyCreditsConsumed"
        from subscription_totals cross join credit_totals
      `);

      if (error || !data?.[0]) {
        throw new Error(
          `Unable to load billing overview: ${error?.message ?? "no result"}`,
        );
      }

      const row = data[0];
      return {
        workspaceCount: Number(row.workspaceCount),
        paidWorkspaceCount: Number(row.paidWorkspaceCount),
        coveredUserCount: Number(row.coveredUserCount),
        activeSubscriptionCount: Number(row.activeSubscriptionCount),
        monthlyCreditsIssued: Number(row.monthlyCreditsIssued),
        monthlyCreditsConsumed: Number(row.monthlyCreditsConsumed),
      };
    },

    async listPublishedPlans() {
      const plans = await this.listAdminPlans();
      return plans.flatMap((plan) => {
        const published = plan.published;
        if (!plan.isActive || !plan.isPublic || !published) return [];
        return {
          code: plan.code,
          nameZh: plan.nameZh,
          descriptionZh: plan.descriptionZh,
          currency: published.currency,
          monthlyPriceMinor: published.monthlyPriceMinor,
          annualPriceMinor: published.annualPriceMinor,
          monthlySubscriptionCredits: published.monthlySubscriptionCredits,
          dailyCredits: published.dailyCredits,
          topUpEligible: published.topUpEligible,
          entitlements: published.entitlements,
        };
      });
    },

    async getRuntimePlanConfig(workspaceId) {
      const { data, error } = await options.getAdminClient().query<RuntimeRow>(
        `
          with legacy as (
            select plan::text as plan
            from public.subscriptions
            where workspace_id = $1::uuid
          ), selected_version as (
            select
              plan.code,
              plan.name_zh,
              version.*,
              (select plan from legacy limit 1) as legacy_plan
            from public.workspace_billing_subscriptions subscription
            join public.billing_plan_versions version on version.id = subscription.plan_version_id
            join public.billing_plans plan on plan.id = version.plan_id
            where subscription.workspace_id = $1::uuid
              and subscription.status in ('trialing', 'active', 'past_due', 'canceled')
              and (
                subscription.status <> 'canceled'
                or subscription.current_period_end is null
                or subscription.current_period_end > now()
              )
            order by subscription.created_at desc
            limit 1
          ), fallback_version as (
            select
              plan.code,
              plan.name_zh,
              version.*,
              coalesce((select plan from legacy limit 1), 'free') as legacy_plan
            from public.billing_plans plan
            join public.billing_plan_versions version
              on version.plan_id = plan.id and version.status = 'published'
            where plan.code = case coalesce((select plan from legacy limit 1), 'free')
              when 'free' then 'free'
              when 'starter' then 'pro'
              when 'pro' then 'pro'
              when 'ultra' then 'team'
              when 'business' then 'team'
              else 'free'
            end
            limit 1
          ), resolved as (
            select * from selected_version
            union all
            select * from fallback_version
            where not exists (select 1 from selected_version)
            limit 1
          )
          select
            resolved.code as "planCode",
            resolved.name_zh as "planName",
            resolved.id as "planVersionId",
            resolved.currency,
            resolved.monthly_price_minor as "monthlyPriceMinor",
            resolved.annual_price_minor as "annualPriceMinor",
            resolved.monthly_subscription_credits as "monthlySubscriptionCredits",
            resolved.daily_credits as "dailyCredits",
            resolved.top_up_eligible as "topUpEligible",
            resolved.legacy_plan as "legacyPlan",
            coalesce(jsonb_object_agg(entitlement.entitlement_key, entitlement.entitlement_value)
              filter (where entitlement.entitlement_key is not null), '{}'::jsonb) as entitlements
          from resolved
          left join public.billing_plan_entitlements entitlement
            on entitlement.plan_version_id = resolved.id
          group by resolved.code, resolved.name_zh, resolved.id, resolved.currency,
            resolved.monthly_price_minor, resolved.annual_price_minor,
            resolved.monthly_subscription_credits, resolved.daily_credits,
            resolved.top_up_eligible, resolved.legacy_plan
        `,
        [workspaceId],
      );

      if (error || !data?.[0]) {
        throw new Error(
          `Unable to resolve runtime billing plan: ${error?.message ?? "no published plan"}`,
        );
      }

      const row = data[0];
      return {
        planCode: row.planCode,
        planName: row.planName,
        planVersionId: row.planVersionId,
        legacyPlan: row.legacyPlan ?? mapCatalogPlanToLegacy(row.planCode),
        currency: row.currency,
        monthlyPriceMinor: Number(row.monthlyPriceMinor),
        annualPriceMinor: Number(row.annualPriceMinor),
        monthlySubscriptionCredits: Number(row.monthlySubscriptionCredits),
        dailyCredits: Number(row.dailyCredits),
        topUpEligible: row.topUpEligible,
        ...parseEntitlements(row.planCode, row.entitlements),
      };
    },
  };
}

function parseVersion(
  planCode: BillingPlanCode,
  value: unknown,
): AdminBillingPlanVersion | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.currency !== "USD") return null;
  return {
    id: String(record.id),
    version: Number(record.version),
    status: record.status as AdminBillingPlanVersion["status"],
    currency: record.currency,
    monthlyPriceMinor: Number(record.monthlyPriceMinor),
    annualPriceMinor: Number(record.annualPriceMinor),
    monthlySubscriptionCredits: Number(record.monthlySubscriptionCredits),
    dailyCredits: Number(record.dailyCredits),
    topUpEligible: record.topUpEligible === true,
    effectiveFrom:
      typeof record.effectiveFrom === "string" ? record.effectiveFrom : null,
    publishedAt:
      typeof record.publishedAt === "string" ? record.publishedAt : null,
    createdAt: String(record.createdAt),
    entitlements: parseEntitlements(
      planCode,
      (record.entitlements as Record<string, unknown>) ?? {},
    ),
  };
}

function parseEntitlements(
  planCode: BillingPlanCode,
  value: Record<string, unknown> | null,
): BillingPlanEntitlements {
  const fallback = DEFAULT_ENTITLEMENTS[planCode];
  const source = value ?? {};
  return {
    maxConcurrentJobs: integer(
      source["generation.max_concurrent_jobs"],
      fallback.maxConcurrentJobs,
    ),
    allowedModelGroups: stringArray(
      source["generation.allowed_model_groups"],
      fallback.allowedModelGroups,
    ),
    maxImageQuality: enumValue(
      source["image.max_quality"],
      ["standard", "hd", "ultra"],
      fallback.maxImageQuality,
    ),
    maxVideoResolution: enumValue(
      source["video.max_resolution"],
      ["720p", "1080p", "4k"],
      fallback.maxVideoResolution,
    ),
    maxProjects: integer(source["projects.max_count"], fallback.maxProjects),
    maxBrandKits: integer(
      source["brand_kits.max_count"],
      fallback.maxBrandKits,
    ),
    maxTeamSeats: integer(source["team.max_seats"], fallback.maxTeamSeats),
    watermark: booleanValue(source["generation.watermark"], fallback.watermark),
    queuePriority: enumValue(
      source["queue.priority"],
      ["standard", "high", "highest"],
      fallback.queuePriority,
    ),
    apiEnabled: booleanValue(source["api.enabled"], fallback.apiEnabled),
  };
}

function mapCatalogPlanToLegacy(planCode: BillingPlanCode): SubscriptionPlan {
  if (planCode === "team" || planCode === "enterprise") return "ultra";
  return planCode;
}

function integer(value: unknown, fallback: number) {
  return Number.isInteger(value) ? (value as number) : fallback;
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function stringArray(value: unknown, fallback: string[]) {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : fallback;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && allowed.includes(value as T)
    ? (value as T)
    : fallback;
}

export function isImageQualityAllowed(
  maximum: ImageQualityLevel,
  requested: ImageQualityLevel,
) {
  return (
    ["standard", "hd", "ultra"].indexOf(requested) <=
    ["standard", "hd", "ultra"].indexOf(maximum)
  );
}

export function isVideoResolutionAllowed(
  maximum: VideoResolution,
  requested: VideoResolution,
) {
  return (
    ["720p", "1080p", "4k"].indexOf(requested) <=
    ["720p", "1080p", "4k"].indexOf(maximum)
  );
}
