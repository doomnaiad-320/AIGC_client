// @credits-system — Core credit operations: balance queries, deductions, refunds, grants, plan updates
import { randomUUID } from "node:crypto";

import type {
  BillingPeriod,
  CreditTransaction,
  SubscriptionPlan,
} from "@loomic/shared";
import { PLAN_CONFIGS } from "@loomic/shared";

import type { AdminDbClient } from "../../db/client.js";

// ── Error ────────────────────────────────────────────────────

export class CreditServiceError extends Error {
  readonly statusCode: number;
  readonly code:
    | "insufficient_credits"
    | "credit_query_failed"
    | "credit_claim_failed"
    | "credit_deduct_failed"
    | "credit_refund_failed"
    | "credit_plan_update_failed";

  constructor(
    code: CreditServiceError["code"],
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.name = "CreditServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ── Types ────────────────────────────────────────────────────

export type BalanceInfo = {
  balance: number;
  plan: SubscriptionPlan;
  dailyClaimed: boolean;
  dailyBalance?: number;
  subscriptionBalance?: number;
  topUpBalance?: number;
  permanentBalance?: number;
};

export type SubscriptionInfo = {
  plan: SubscriptionPlan;
  billingPeriod: BillingPeriod | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  canceledAt: string | null;
};

export type CreditService = {
  getBalance(workspaceId: string): Promise<BalanceInfo>;
  deductCredits(
    workspaceId: string,
    userId: string,
    amount: number,
    jobId?: string,
    description?: string,
  ): Promise<string>;
  refundCredits(
    workspaceId: string,
    userId: string,
    amount: number,
    jobId: string,
    description?: string,
  ): Promise<string>;
  claimDailyCredits(
    workspaceId: string,
  ): Promise<{ success: boolean; balance?: number }>;
  getTransactions(
    workspaceId: string,
    limit?: number,
  ): Promise<CreditTransaction[]>;
  getSubscription(workspaceId: string): Promise<SubscriptionInfo>;
  updatePlan(workspaceId: string, plan: SubscriptionPlan): Promise<void>;
};

// ── Factory ──────────────────────────────────────────────────

export function createCreditService(options: {
  getAdminClient: () => AdminDbClient;
}): CreditService {
  return {
    async getBalance(workspaceId) {
      const admin = options.getAdminClient();

      const [balanceResult, subscriptionResult] = await Promise.all([
        admin.rpc<Record<string, unknown>>("billing_get_credit_balance", {
          p_workspace_id: workspaceId,
        }),
        admin
          .from("subscriptions")
          .select("plan")
          .eq("workspace_id", workspaceId)
          .maybeSingle(),
      ]);

      if (balanceResult.error || subscriptionResult.error) {
        throw new CreditServiceError(
          "credit_query_failed",
          "Failed to query credit balance.",
          500,
        );
      }

      const billingBalance = balanceResult.data ?? {};
      return {
        balance: Number(billingBalance.balance ?? 0),
        plan: (subscriptionResult.data?.plan as SubscriptionPlan) ?? "free",
        dailyClaimed: true,
        dailyBalance: Number(billingBalance.daily_balance ?? 0),
        subscriptionBalance: Number(
          billingBalance.subscription_balance ?? 0,
        ),
        topUpBalance: Number(billingBalance.top_up_balance ?? 0),
        permanentBalance: Number(billingBalance.permanent_balance ?? 0),
      };
    },

    async deductCredits(workspaceId, userId, amount, jobId, description) {
      const admin = options.getAdminClient();

      const { data, error } = await admin.rpc("billing_deduct_credits", {
        p_workspace_id: workspaceId,
        p_user_id: userId,
        p_amount: amount,
        p_job_id: (jobId ?? null) as string,
        p_description: (description ?? null) as string,
        p_idempotency_key: jobId
          ? `job:${jobId}:deduct`
          : `direct:${randomUUID()}:deduct`,
      });

      if (error) {
        if (error.message?.includes("INSUFFICIENT_CREDITS")) {
          throw new CreditServiceError(
            "insufficient_credits",
            "Not enough credits to perform this action.",
            402,
          );
        }
        throw new CreditServiceError(
          "credit_deduct_failed",
          `Failed to deduct credits: ${error.message}`,
          500,
        );
      }

      return data as string;
    },

    async refundCredits(workspaceId, userId, amount, jobId, description) {
      const admin = options.getAdminClient();

      const { data, error } = await admin.rpc("billing_refund_credits", {
        p_workspace_id: workspaceId,
        p_user_id: userId,
        p_amount: amount,
        p_job_id: jobId ?? null,
        p_description: description ?? null,
        p_idempotency_key: `job:${jobId}:refund`,
      });

      if (error) {
        throw new CreditServiceError(
          "credit_refund_failed",
          `Failed to refund credits: ${error.message}`,
          500,
        );
      }

      return data as string;
    },

    async claimDailyCredits(workspaceId) {
      const admin = options.getAdminClient();

      const { data: grant, error: claimError } = await admin.rpc<
        Record<string, unknown>
      >(
        "billing_ensure_daily_credit_grant",
        {
          p_workspace_id: workspaceId,
        },
      );

      if (claimError) {
        throw new CreditServiceError(
          "credit_claim_failed",
          `Failed to claim daily credits: ${claimError.message}`,
          500,
        );
      }

      return {
        success: grant?.created === true,
        balance: Number(grant?.balance ?? 0),
      };
    },

    async getTransactions(workspaceId, limit = 20) {
      const admin = options.getAdminClient();
      const safeLimit = Math.min(Math.max(limit, 1), 100);

      const { data, error } = await admin
        .from("credit_transactions")
        .select(
          "id, transaction_type, amount, balance_after, job_id, description, created_at",
        )
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: false })
        .limit(safeLimit);

      if (error) {
        throw new CreditServiceError(
          "credit_query_failed",
          "Failed to query transactions.",
          500,
        );
      }

      return (data ?? []) as CreditTransaction[];
    },

    async getSubscription(workspaceId) {
      const admin = options.getAdminClient();

      const { data, error } = await admin
        .from("subscriptions")
        .select(
          "plan, billing_period, stripe_customer_id, stripe_subscription_id, current_period_start, current_period_end, canceled_at",
        )
        .eq("workspace_id", workspaceId)
        .maybeSingle();

      if (error) {
        throw new CreditServiceError(
          "credit_query_failed",
          "Failed to query subscription.",
          500,
        );
      }

      return {
        plan: (data?.plan as SubscriptionPlan) ?? "free",
        billingPeriod: (data?.billing_period as BillingPeriod) ?? null,
        stripeCustomerId: data?.stripe_customer_id ?? null,
        stripeSubscriptionId: data?.stripe_subscription_id ?? null,
        currentPeriodStart: data?.current_period_start ?? null,
        currentPeriodEnd: data?.current_period_end ?? null,
        canceledAt: data?.canceled_at ?? null,
      };
    },

    async updatePlan(workspaceId, plan) {
      const admin = options.getAdminClient();
      const config = PLAN_CONFIGS[plan];

      // Atomic plan update + credit grant via RPC to avoid read-then-write race condition.
      // The RPC uses FOR UPDATE row locking so concurrent deductions cannot be overwritten.
      const { error } = await admin.rpc("grant_plan_credits", {
        p_workspace_id: workspaceId,
        p_plan: plan,
        p_credits: config.monthlyCredits,
      });

      if (error) {
        throw new CreditServiceError(
          "credit_plan_update_failed",
          `Failed to update plan: ${error.message}`,
          500,
        );
      }
    },
  };
}
