import { generateKeyPairSync, sign } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildDuluPaySigningString,
  createDuluPayClient,
  formatDuluPayAmountMinor,
  parseDuluPayAmountMinor,
} from "./dulupay-client.js";

const merchantKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const platformKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const merchantPrivateKey = merchantKeys.privateKey
  .export({
    format: "pem",
    type: "pkcs8",
  })
  .toString();
const platformPublicKey = platformKeys.publicKey
  .export({
    format: "pem",
    type: "spki",
  })
  .toString();

afterEach(() => vi.unstubAllGlobals());

describe("DuluPay client", () => {
  it("sorts signing parameters and excludes signatures and empty values", () => {
    expect(
      buildDuluPaySigningString({
        z: "last",
        sign: "ignored",
        empty: "",
        b: 2,
        a: "first",
        sign_type: "RSA",
      }),
    ).toBe("a=first&b=2&z=last");
  });

  it("converts CNY amounts without floating point arithmetic", () => {
    expect(parseDuluPayAmountMinor("69")).toBe(6900);
    expect(parseDuluPayAmountMinor("69.9")).toBe(6990);
    expect(parseDuluPayAmountMinor("69.09")).toBe(6909);
    expect(formatDuluPayAmountMinor(6909)).toBe("69.09");
    expect(() => parseDuluPayAmountMinor("1.001")).toThrow(
      "DULUPAY_AMOUNT_INVALID",
    );
  });

  it("verifies callbacks with the configured platform public key", () => {
    const client = makeClient();
    const callback = {
      money: "69.00",
      out_trade_no: "order-1",
      pid: "merchant-1",
      timestamp: "1786812345",
      trade_no: "provider-1",
      trade_status: "TRADE_SUCCESS",
    };
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(buildDuluPaySigningString(callback), "utf8"),
      platformKeys.privateKey,
    ).toString("base64");

    expect(client.verifyCallback({ ...callback, sign: signature })).toBe(true);
    expect(
      client.verifyCallback({ ...callback, money: "70.00", sign: signature }),
    ).toBe(false);
  });

  it("signs form requests and verifies signed payment responses", async () => {
    const responsePayload = {
      code: 0,
      msg: "success",
      pay_info: "https://cashier.dulupay.com/pay/demo",
      pay_type: "jump",
      trade_no: "provider-trade-1",
    };
    const responseSignature = sign(
      "RSA-SHA256",
      Buffer.from(buildDuluPaySigningString(responsePayload), "utf8"),
      platformKeys.privateKey,
    ).toString("base64");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ ...responsePayload, sign: responseSignature }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeClient().createPayment({
      paymentMethod: "alipay",
      outTradeNo: "11111111-1111-4111-8111-111111111111",
      notifyUrl: "https://api.example.com/notify",
      returnUrl: "https://api.example.com/return",
      name: "5,000 credits",
      amount: "69.00",
      clientIp: "127.0.0.1",
      device: "pc",
      param: "11111111-1111-4111-8111-111111111111",
    });

    expect(result).toEqual({
      payInfo: responsePayload.pay_info,
      payType: "jump",
      tradeNo: "provider-trade-1",
    });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = new URLSearchParams(String(request.body));
    expect(body.get("pid")).toBe("merchant-1");
    expect(body.get("money")).toBe("69.00");
    expect(body.get("sign")).toBeTruthy();
    expect(body.get("sign_type")).toBe("RSA");
  });
});

function makeClient() {
  return createDuluPayClient({
    apiBaseUrl: "https://api.dulupay.com/api",
    merchantId: "merchant-1",
    merchantPrivateKey,
    platformPublicKey,
  });
}
