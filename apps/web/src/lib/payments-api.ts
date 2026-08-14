// @credits-system — Frontend API client for payments: checkout, subscription, cancellation, plan change
import type { BillingPeriod, BillingPlanCode } from "@loomic/shared";

import { getServerBaseUrl } from "./env";
import { ApiApplicationError, ApiAuthError } from "./server-api";

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

export type CheckoutResult = {
  activated: boolean;
  checkoutUrl: string | null;
};

// ── Helpers ──────────────────────────────────────────────────

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

function authJsonHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  };
}

async function handleErrorResponse(response: Response): Promise<never> {
  if (response.status === 401) {
    throw new ApiAuthError();
  }
  const body = await response.json().catch(() => null);
  const code = body?.error?.code ?? "application_error";
  const messages: Record<string, string> = {
    payment_not_configured: "支付服务尚未配置，请联系平台管理员完成商户设置。",
    variant_not_found: "当前套餐的支付价格尚未配置。",
    subscription_not_found: "未找到有效订阅。",
    subscription_update_failed: "无法更新订阅，请稍后重试。",
  };
  const message =
    messages[code] ?? body?.error?.message ?? "支付请求失败，请稍后重试。";
  throw new ApiApplicationError(code, message);
}

// ── Payment APIs ─────────────────────────────────────────────

export async function createCheckout(
  accessToken: string,
  plan: BillingPlanCode,
  billingPeriod: BillingPeriod,
): Promise<CheckoutResult> {
  const response = await fetch(`${getServerBaseUrl()}/api/payments/checkout`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify({ plan, billingPeriod }),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as CheckoutResult;
}

export async function getSubscription(
  accessToken: string,
): Promise<SubscriptionStatus> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/payments/subscription`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as SubscriptionStatus;
}

export async function cancelSubscription(accessToken: string): Promise<void> {
  const response = await fetch(`${getServerBaseUrl()}/api/payments/cancel`, {
    method: "POST",
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
}

export async function resumeSubscription(accessToken: string): Promise<void> {
  const response = await fetch(`${getServerBaseUrl()}/api/payments/resume`, {
    method: "POST",
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
}

export async function changePlan(
  accessToken: string,
  plan: BillingPlanCode,
  billingPeriod: BillingPeriod,
): Promise<void> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/payments/change-plan`,
    {
      method: "POST",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify({ plan, billingPeriod }),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
}
