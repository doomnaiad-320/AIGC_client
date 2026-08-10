import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "./auth.js";

describe("password hashing", () => {
  it("verifies the originating password and rejects a different password", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");

    expect(hash).toMatch(/^scrypt\$/);
    await expect(
      verifyPassword("correct-horse-battery-staple", hash),
    ).resolves.toBe(true);
    await expect(verifyPassword("incorrect-password", hash)).resolves.toBe(
      false,
    );
  });

  it("rejects malformed stored password hashes", async () => {
    await expect(
      verifyPassword("correct-horse-battery-staple", "not-a-password-hash"),
    ).resolves.toBe(false);
  });
});
