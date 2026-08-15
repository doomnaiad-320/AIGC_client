import { randomUUID } from "node:crypto";

import type { BillingPeriod, BillingPlanCode } from "@loomic/shared";

import type { AdminDbClient } from "../../db/client.js";
import {
  type PaymentService,
  PaymentServiceError,
  type SubscriptionStatus,
} from "./payment-service.js";

type LocalSubscriptionResult = Record<string, unknown>;

export function createLocalSubscriptionService(options: {
  getAdminClient: () => AdminDbClient;
  webOrigin: string;
}): PaymentService {
  const call = async <T extends LocalSubscriptionResult>(
    sql: string,
    values: unknown[],
  ): Promise<T> => {
    const { data, error } = await options
      .getAdminClient()
      .query<T>(sql, values);
    const result = data?.[0];
    if (error || !result) {
      throw mapLocalSubscriptionError(error?.message);
    }
    return result;
  };

  const getStatus = async (
    workspaceId: string,
    actorUserId: string,
  ): Promise<SubscriptionStatus> => {
    const row = await call<{ result: SubscriptionStatus }>(
      "select public.billing_local_get_subscription_status($1::uuid, $2::uuid) as result",
      [workspaceId, actorUserId],
    );
    return row.result;
  };

  return {
    async createCheckout(workspaceId, actorUserId, planId, billingPeriod) {
      await activate(workspaceId, actorUserId, planId, billingPeriod, call);
      return {
        activated: true,
        checkoutUrl: `${options.webOrigin}/settings?tab=billing&subscription=activated`,
      };
    },

    async handleWebhookEvent() {
      throw new PaymentServiceError(
        "webhook_processing_failed",
        "Local subscriptions do not accept payment webhooks.",
        400,
      );
    },

    getSubscriptionStatus: getStatus,

    async cancelSubscription(workspaceId, actorUserId) {
      await call(
        "select public.billing_local_cancel_subscription($1::uuid, $2::uuid) as result",
        [workspaceId, actorUserId],
      );
    },

    async resumeSubscription(workspaceId, actorUserId) {
      await call(
        "select public.billing_local_resume_subscription($1::uuid, $2::uuid) as result",
        [workspaceId, actorUserId],
      );
    },

    async changePlan(workspaceId, actorUserId, newPlanId, billingPeriod) {
      await activate(workspaceId, actorUserId, newPlanId, billingPeriod, call);
    },
  };
}

async function activate(
  workspaceId: string,
  actorUserId: string,
  planId: BillingPlanCode,
  billingPeriod: BillingPeriod,
  call: <T extends LocalSubscriptionResult>(
    sql: string,
    values: unknown[],
  ) => Promise<T>,
) {
  await call(
    `select public.billing_local_activate_subscription(
       $1::uuid, $2::uuid, $3::text, $4::text, $5::text
     ) as result`,
    [workspaceId, actorUserId, planId, billingPeriod, `local:${randomUUID()}`],
  );
}

function mapLocalSubscriptionError(message?: string) {
  if (message?.includes("SUBSCRIPTION_PLAN_UNAVAILABLE")) {
    return new PaymentServiceError(
      "variant_not_found",
      "The selected plan is not published for self-service subscriptions.",
      400,
    );
  }
  if (message?.includes("SUBSCRIPTION_WORKSPACE_ADMIN_REQUIRED")) {
    return new PaymentServiceError(
      "subscription_update_failed",
      "Only a workspace owner or administrator can manage the subscription.",
      403,
    );
  }
  if (message?.includes("SUBSCRIPTION_WORKSPACE_ACCESS_DENIED")) {
    return new PaymentServiceError(
      "subscription_update_failed",
      "You do not have access to this workspace subscription.",
      403,
    );
  }
  if (message?.includes("SUBSCRIPTION_NOT_FOUND")) {
    return new PaymentServiceError(
      "subscription_not_found",
      "No active subscription was found.",
      404,
    );
  }
  if (message?.includes("SUBSCRIPTION_MANAGED_EXTERNALLY")) {
    return new PaymentServiceError(
      "subscription_update_failed",
      "This subscription is managed by an external payment provider.",
      409,
    );
  }
  return new PaymentServiceError(
    "subscription_update_failed",
    "Unable to update the local subscription.",
    500,
  );
}
