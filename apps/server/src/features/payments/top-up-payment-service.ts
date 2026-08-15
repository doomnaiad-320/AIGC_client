import type {
  PaymentMethod,
  TopUpCheckoutRequest,
  TopUpCheckoutResponse,
  TopUpOrderStatus,
  TopUpPack,
} from "@loomic/shared";

import type { AdminDbClient } from "../../db/client.js";
import {
  createDuluPayClient,
  formatDuluPayAmountMinor,
  parseDuluPayAmountMinor,
} from "./dulupay-client.js";
import type { PaymentCredentialCrypto } from "./payment-credential-crypto.js";

export class TopUpPaymentServiceError extends Error {
  constructor(
    readonly code:
      | "top_up_query_failed"
      | "top_up_checkout_failed"
      | "top_up_order_not_found"
      | "payment_provider_unavailable"
      | "payment_callback_invalid",
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "TopUpPaymentServiceError";
  }
}

type ProviderConfigRow = {
  allowedMethods: PaymentMethod[];
  apiBaseUrl: string;
  callbackToleranceSeconds: number;
  enabled: boolean;
  merchantId: string | null;
  merchantPrivateKeyCiphertext: string | null;
  platformPublicKey: string | null;
};

type CreatedOrder = {
  amount_minor: number;
  credits: number;
  currency: "USD";
  metadata: Record<string, unknown>;
  order_id: string;
  pack_code: string;
  pack_name: string;
  payment_method: PaymentMethod;
  provider_amount_minor: number;
  provider_currency: "CNY";
  provider_order_id: string | null;
  status: "pending" | "paid";
};

export type TopUpPaymentService = {
  listPacks(workspaceId: string): Promise<TopUpPack[]>;
  createCheckout(
    workspaceId: string,
    actorUserId: string,
    input: TopUpCheckoutRequest,
    clientIp: string,
  ): Promise<TopUpCheckoutResponse>;
  getOrderStatus(
    workspaceId: string,
    orderId: string,
  ): Promise<TopUpOrderStatus>;
  processDuluPayCallback(params: Record<string, unknown>): Promise<void>;
};

export function createTopUpPaymentService(options: {
  credentialCrypto: PaymentCredentialCrypto;
  getAdminClient: () => AdminDbClient;
  serverPublicUrl: string;
  webOrigin: string;
}): TopUpPaymentService {
  const getAdmin = options.getAdminClient;

  async function loadProviderConfig(requireEnabled = true) {
    const { data, error } = await getAdmin().query<ProviderConfigRow>(
      `select
         allowed_methods as "allowedMethods",
         api_base_url as "apiBaseUrl",
         callback_tolerance_seconds as "callbackToleranceSeconds",
         enabled,
         merchant_id as "merchantId",
         merchant_private_key_ciphertext as "merchantPrivateKeyCiphertext",
         platform_public_key as "platformPublicKey"
       from public.payment_provider_configs
       where provider_code = 'dulupay'
       limit 1`,
    );
    const config = data?.[0];
    if (
      error ||
      !config ||
      (requireEnabled && !config.enabled) ||
      !config.merchantId ||
      !config.merchantPrivateKeyCiphertext ||
      !config.platformPublicKey ||
      !options.credentialCrypto.ready
    ) {
      throw new TopUpPaymentServiceError(
        "payment_provider_unavailable",
        "DuluPay is not fully configured.",
        503,
      );
    }
    return {
      ...config,
      merchantId: config.merchantId,
      merchantPrivateKey: options.credentialCrypto.decrypt(
        config.merchantPrivateKeyCiphertext,
      ),
      platformPublicKey: config.platformPublicKey,
    };
  }

  return {
    async listPacks(_workspaceId) {
      const { data, error } = await getAdmin().query<{
        code: string;
        credits: number;
        description: string;
        minimumPlanCode: "pro" | "team";
        name: string;
        paymentMethods: PaymentMethod[];
        priceMinor: number;
        providerAmountMinor: number;
      }>(
        `select
           pack.code,
           pack.name_zh as name,
           pack.description_zh as description,
           pack.credits,
           pack.price_minor as "priceMinor",
           pack.minimum_plan_code as "minimumPlanCode",
           price.amount_minor as "providerAmountMinor",
           config.allowed_methods as "paymentMethods"
         from public.billing_top_up_packs pack
         join public.billing_top_up_pack_provider_prices price
           on price.top_up_pack_id = pack.id
          and price.provider_code = 'dulupay'
         join public.payment_provider_configs config
           on config.provider_code = price.provider_code
          and config.enabled
         where pack.status = 'published'
         order by pack.sort_order, pack.credits, pack.code`,
      );
      if (error) {
        throw new TopUpPaymentServiceError(
          "top_up_query_failed",
          "Unable to load top-up packs.",
          500,
        );
      }
      return (data ?? []).map((pack) => ({
        ...pack,
        currency: "USD" as const,
        provider: "dulupay" as const,
        providerCurrency: "CNY" as const,
      }));
    },

    async createCheckout(workspaceId, actorUserId, input, clientIp) {
      const config = await loadProviderConfig();
      if (!config.allowedMethods.includes(input.paymentMethod)) {
        throw new TopUpPaymentServiceError(
          "payment_provider_unavailable",
          "The selected payment method is disabled.",
          400,
        );
      }

      const { data, error } = await getAdmin().query<{ result: CreatedOrder }>(
        `select public.billing_create_top_up_order(
           $1::uuid, $2::uuid, $3::text, 'dulupay', $4::text, $5::text
         ) as result`,
        [
          workspaceId,
          actorUserId,
          input.packCode,
          input.paymentMethod,
          input.idempotencyKey,
        ],
      );
      const order = data?.[0]?.result;
      if (error || !order) {
        throw mapCheckoutError(error?.message);
      }
      if (order.status !== "pending" && order.status !== "paid") {
        throw new TopUpPaymentServiceError(
          "top_up_checkout_failed",
          "This top-up order cannot be resumed.",
          409,
        );
      }

      const existingPayType = stringValue(order.metadata?.pay_type);
      const existingPayInfo = stringValue(order.metadata?.pay_info);
      if (order.provider_order_id && existingPayType && existingPayInfo) {
        return {
          orderId: order.order_id,
          status: order.status,
          payType: existingPayType,
          payInfo: existingPayInfo,
          providerTradeNo: order.provider_order_id,
        };
      }

      const client = createDuluPayClient({
        apiBaseUrl: config.apiBaseUrl,
        merchantId: config.merchantId,
        merchantPrivateKey: config.merchantPrivateKey,
        platformPublicKey: config.platformPublicKey,
      });
      try {
        const callbackUrl = `${options.serverPublicUrl}/api/payments/dulupay/notify`;
        const returnUrl = `${options.serverPublicUrl}/api/payments/dulupay/return`;
        const payment = await client.createPayment({
          paymentMethod: input.paymentMethod,
          outTradeNo: order.order_id,
          notifyUrl: callbackUrl,
          returnUrl,
          name: order.pack_name,
          amount: formatDuluPayAmountMinor(order.provider_amount_minor),
          clientIp,
          device: input.device,
          param: order.order_id,
        });

        const update = await getAdmin().query(
          `update public.billing_payment_orders
           set provider_order_id = $2,
               provider_checkout_id = $2,
               metadata = metadata || jsonb_build_object(
                 'pay_type', $3::text,
                 'pay_info', $4::text
               ),
               updated_at = now()
           where id = $1::uuid and status = 'pending'`,
          [order.order_id, payment.tradeNo, payment.payType, payment.payInfo],
        );
        if (update.error) throw new Error(update.error.message);

        return {
          orderId: order.order_id,
          status: order.status,
          payType: payment.payType,
          payInfo: payment.payInfo,
          providerTradeNo: payment.tradeNo,
        };
      } catch (cause) {
        await getAdmin().query(
          `update public.billing_payment_orders
           set status = 'failed',
               metadata = metadata || jsonb_build_object('checkout_error', $2::text),
               updated_at = now()
           where id = $1::uuid and status = 'pending'`,
          [order.order_id, cause instanceof Error ? cause.message : "unknown"],
        );
        throw new TopUpPaymentServiceError(
          "top_up_checkout_failed",
          "Unable to create the DuluPay checkout.",
          502,
        );
      }
    },

    async getOrderStatus(workspaceId, orderId) {
      const { data, error } = await getAdmin().query<{
        credits: number;
        orderId: string;
        paidAt: string | null;
        status: TopUpOrderStatus["status"];
      }>(
        `select
           orders.id as "orderId",
           orders.status,
           pack.credits,
           orders.paid_at as "paidAt"
         from public.billing_payment_orders orders
         join public.billing_top_up_packs pack on pack.id = orders.top_up_pack_id
         where orders.id = $1::uuid
           and orders.workspace_id = $2::uuid
           and orders.order_type = 'top_up'
         limit 1`,
        [orderId, workspaceId],
      );
      if (error || !data?.[0]) {
        throw new TopUpPaymentServiceError(
          "top_up_order_not_found",
          "Top-up order not found.",
          404,
        );
      }
      return data[0];
    },

    async processDuluPayCallback(params) {
      const config = await loadProviderConfig(false);
      const client = createDuluPayClient({
        apiBaseUrl: config.apiBaseUrl,
        merchantId: config.merchantId,
        merchantPrivateKey: config.merchantPrivateKey,
        platformPublicKey: config.platformPublicKey,
      });
      const timestamp = Number.parseInt(String(params.timestamp ?? ""), 10);
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (
        !Number.isInteger(timestamp) ||
        Math.abs(nowSeconds - timestamp) > config.callbackToleranceSeconds ||
        String(params.pid ?? "") !== config.merchantId ||
        String(params.trade_status ?? "") !== "TRADE_SUCCESS" ||
        !client.verifyCallback(params)
      ) {
        throw new TopUpPaymentServiceError(
          "payment_callback_invalid",
          "Invalid DuluPay callback.",
          400,
        );
      }

      const orderId = String(params.out_trade_no ?? "");
      const providerTradeNo = String(params.trade_no ?? "");
      const providerAmountMinor = parseDuluPayAmountMinor(params.money);
      const providerEventId = `${providerTradeNo}:TRADE_SUCCESS`;
      const { data, error } = await getAdmin().query<{ result: unknown }>(
        `select public.billing_complete_dulupay_top_up(
           $1::uuid, $2::text, $3::text, $4::integer, $5::jsonb
         ) as result`,
        [
          orderId,
          providerEventId,
          providerTradeNo,
          providerAmountMinor,
          JSON.stringify(params),
        ],
      );
      if (error || !data?.[0]) {
        throw new TopUpPaymentServiceError(
          "payment_callback_invalid",
          "Unable to apply the DuluPay callback.",
          400,
        );
      }
    },
  };
}

function mapCheckoutError(message?: string) {
  if (
    message?.includes("PAYMENT_PROVIDER_UNAVAILABLE") ||
    message?.includes("PAYMENT_METHOD_UNAVAILABLE")
  ) {
    return new TopUpPaymentServiceError(
      "payment_provider_unavailable",
      "The selected payment method is unavailable.",
      503,
    );
  }
  if (message?.includes("TOP_UP_PACK_NOT_FOUND")) {
    return new TopUpPaymentServiceError(
      "top_up_checkout_failed",
      "The selected top-up pack is not available.",
      404,
    );
  }
  if (message?.includes("TOP_UP_PLAN_NOT_ELIGIBLE")) {
    return new TopUpPaymentServiceError(
      "top_up_checkout_failed",
      "Your current plan is not eligible for this top-up pack.",
      403,
    );
  }
  return new TopUpPaymentServiceError(
    "top_up_checkout_failed",
    "Unable to create a top-up order.",
    500,
  );
}

function stringValue(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}
