import type {
  PaymentMethod,
  TopUpCheckoutResponse,
  TopUpOrderStatus,
  TopUpPack,
} from "@loomic/shared";

import { getServerBaseUrl } from "./env";
import { ApiApplicationError, ApiAuthError } from "./server-api";

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

function authJsonHeaders(accessToken: string): Record<string, string> {
  return {
    ...authHeaders(accessToken),
    "content-type": "application/json",
  };
}

async function handleErrorResponse(response: Response): Promise<never> {
  if (response.status === 401) throw new ApiAuthError();
  const body = await response.json().catch(() => null);
  const code = body?.error?.code ?? "application_error";
  const messages: Record<string, string> = {
    payment_provider_unavailable: "支付渠道尚未启用或所选支付方式不可用。",
    top_up_checkout_failed: "无法创建点数包订单，请检查当前套餐或稍后重试。",
    top_up_order_not_found: "未找到这笔点数包订单。",
  };
  throw new ApiApplicationError(
    code,
    messages[code] ?? body?.error?.message ?? "点数包支付请求失败。",
  );
}

export async function fetchTopUpPacks(accessToken: string) {
  const response = await fetch(
    `${getServerBaseUrl()}/api/payments/top-up-packs`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as { packs: TopUpPack[] };
}

export async function createTopUpCheckout(
  accessToken: string,
  input: {
    packCode: string;
    paymentMethod: PaymentMethod;
    idempotencyKey: string;
  },
) {
  const response = await fetch(
    `${getServerBaseUrl()}/api/payments/top-up-checkout`,
    {
      method: "POST",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify({ ...input, device: resolvePaymentDevice() }),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as TopUpCheckoutResponse;
}

export async function fetchTopUpOrder(accessToken: string, orderId: string) {
  const response = await fetch(
    `${getServerBaseUrl()}/api/payments/top-up-orders/${encodeURIComponent(orderId)}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as TopUpOrderStatus;
}

function resolvePaymentDevice() {
  if (typeof navigator === "undefined") return "pc" as const;
  const agent = navigator.userAgent.toLowerCase();
  if (agent.includes("micromessenger")) return "wechat" as const;
  if (agent.includes("alipayclient")) return "alipay" as const;
  return /android|iphone|ipad|mobile/.test(agent)
    ? ("mobile" as const)
    : ("pc" as const);
}
