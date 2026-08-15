import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const FORMAT_VERSION = "v1";

export function createPaymentCredentialCrypto(secret?: string) {
  const normalizedSecret = secret?.trim();
  const key = normalizedSecret
    ? createHash("sha256")
        .update("loomic-payment-config-v1\0", "utf8")
        .update(normalizedSecret, "utf8")
        .digest()
    : null;

  return {
    ready: key !== null,

    encrypt(value: string) {
      if (!key) {
        throw new Error("PAYMENT_CONFIG_ENCRYPTION_KEY_REQUIRED");
      }
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();
      return [
        FORMAT_VERSION,
        iv.toString("base64url"),
        authTag.toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(":");
    },

    decrypt(value: string) {
      if (!key) {
        throw new Error("PAYMENT_CONFIG_ENCRYPTION_KEY_REQUIRED");
      }
      const [version, ivValue, authTagValue, ciphertextValue] =
        value.split(":");
      if (
        version !== FORMAT_VERSION ||
        !ivValue ||
        !authTagValue ||
        !ciphertextValue
      ) {
        throw new Error("PAYMENT_CONFIG_CIPHERTEXT_INVALID");
      }
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(ivValue, "base64url"),
      );
      decipher.setAuthTag(Buffer.from(authTagValue, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextValue, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}

export type PaymentCredentialCrypto = ReturnType<
  typeof createPaymentCredentialCrypto
>;
