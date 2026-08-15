import { describe, expect, it } from "vitest";

import { createPaymentCredentialCrypto } from "./payment-credential-crypto.js";

describe("payment credential crypto", () => {
  it("encrypts and decrypts merchant credentials without storing plaintext", () => {
    const crypto = createPaymentCredentialCrypto(
      "test-secret-with-enough-entropy",
    );
    const plaintext =
      "-----BEGIN PRIVATE KEY-----\nmerchant-secret\n-----END PRIVATE KEY-----";

    const ciphertext = crypto.encrypt(plaintext);

    expect(crypto.ready).toBe(true);
    expect(ciphertext).toMatch(/^v1:/);
    expect(ciphertext).not.toContain("merchant-secret");
    expect(crypto.decrypt(ciphertext)).toBe(plaintext);
  });

  it("rejects missing secrets and tampered ciphertext", () => {
    const unavailable = createPaymentCredentialCrypto();
    expect(unavailable.ready).toBe(false);
    expect(() => unavailable.encrypt("secret")).toThrow(
      "PAYMENT_CONFIG_ENCRYPTION_KEY_REQUIRED",
    );

    const crypto = createPaymentCredentialCrypto("test-secret");
    const ciphertext = crypto.encrypt("merchant-private-key");
    expect(() => crypto.decrypt(`${ciphertext.slice(0, -2)}aa`)).toThrow();
  });
});
