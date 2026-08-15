import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export type DuluPayConfig = {
  apiBaseUrl: string;
  merchantId: string;
  merchantPrivateKey: string;
  platformPublicKey: string;
};

type DuluPayResponse = Record<string, unknown> & {
  code?: number;
  msg?: string;
  sign?: string;
};

export function createDuluPayClient(config: DuluPayConfig) {
  const apiBaseUrl = validateApiBaseUrl(config.apiBaseUrl);
  const privateKey = createPrivateKey(config.merchantPrivateKey);
  const publicKey = createPublicKey(config.platformPublicKey);

  async function request(path: string, params: Record<string, unknown>) {
    const signed = signParams(
      {
        pid: config.merchantId,
        ...params,
        timestamp: Math.floor(Date.now() / 1000).toString(),
      },
      privateKey,
    );
    const response = await fetch(new URL(path, `${apiBaseUrl}/`), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(toStringRecord(signed)),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`DULUPAY_HTTP_${response.status}`);
    }
    const payload = (await response.json()) as DuluPayResponse;
    if (!payload.sign || !verifyParams(payload, payload.sign, publicKey)) {
      throw new Error("DULUPAY_RESPONSE_SIGNATURE_INVALID");
    }
    if (Number(payload.code) !== 0) {
      throw new Error(
        `DULUPAY_REQUEST_FAILED:${String(payload.msg ?? payload.code ?? "unknown")}`,
      );
    }
    return payload;
  }

  return {
    async createPayment(input: {
      paymentMethod: "alipay" | "wxpay";
      outTradeNo: string;
      notifyUrl: string;
      returnUrl: string;
      name: string;
      amount: string;
      clientIp: string;
      device: "pc" | "mobile" | "qq" | "wechat" | "alipay";
      param: string;
    }) {
      const payload = await request("pay/create", {
        method: "jump",
        device: input.device,
        type: input.paymentMethod,
        out_trade_no: input.outTradeNo,
        notify_url: input.notifyUrl,
        return_url: input.returnUrl,
        name: input.name,
        money: input.amount,
        clientip: input.clientIp,
        param: input.param,
      });
      const tradeNo = stringValue(payload.trade_no);
      const payType = stringValue(payload.pay_type);
      const payInfo = stringValue(payload.pay_info);
      if (!tradeNo || !payType || !payInfo) {
        throw new Error("DULUPAY_PAYMENT_RESPONSE_INVALID");
      }
      return { tradeNo, payType, payInfo };
    },

    async getMerchantInfo() {
      return request("merchant/info", {});
    },

    verifyCallback(params: Record<string, unknown>) {
      const signature = stringValue(params.sign);
      return Boolean(signature && verifyParams(params, signature, publicKey));
    },
  };
}

export function buildDuluPaySigningString(params: Record<string, unknown>) {
  return Object.entries(params)
    .filter(([key, value]) => {
      if (key === "sign" || key === "sign_type") return false;
      if (value === null || value === undefined || value === "") return false;
      return !Array.isArray(value) && !Buffer.isBuffer(value);
    })
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("&");
}

export function parseDuluPayAmountMinor(value: unknown) {
  const normalized = String(value ?? "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    throw new Error("DULUPAY_AMOUNT_INVALID");
  }
  const [whole, fraction = ""] = normalized.split(".");
  return (
    Number.parseInt(whole ?? "0", 10) * 100 +
    Number.parseInt(fraction.padEnd(2, "0"), 10)
  );
}

export function formatDuluPayAmountMinor(value: number) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("DULUPAY_AMOUNT_INVALID");
  }
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}

function signParams(
  params: Record<string, unknown>,
  privateKey: ReturnType<typeof createPrivateKey>,
) {
  const signingString = buildDuluPaySigningString(params);
  return {
    ...params,
    sign: sign(
      "RSA-SHA256",
      Buffer.from(signingString, "utf8"),
      privateKey,
    ).toString("base64"),
    sign_type: "RSA",
  };
}

function verifyParams(
  params: Record<string, unknown>,
  signature: string,
  publicKey: ReturnType<typeof createPublicKey>,
) {
  return verify(
    "RSA-SHA256",
    Buffer.from(buildDuluPaySigningString(params), "utf8"),
    publicKey,
    Buffer.from(signature, "base64"),
  );
}

function validateApiBaseUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "api.dulupay.com" &&
      !url.hostname.endsWith(".dulupay.com"))
  ) {
    throw new Error("DULUPAY_API_BASE_URL_INVALID");
  }
  return url.toString().replace(/\/$/, "");
}

function toStringRecord(params: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(params)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
}

function stringValue(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}
