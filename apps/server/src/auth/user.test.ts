import { describe, expect, it, vi } from "vitest";

import type { AdminDbClient } from "../db/client.js";
import {
  createAccessToken,
  createRequestAuthenticator,
  invalidateAuthCacheForUser,
} from "./user.js";

const env = { appJwtSecret: "test-auth-secret-with-enough-entropy" };

function accountClient(input: {
  authVersion: number;
  status: "active" | "suspended" | "disabled";
}) {
  const builder = {
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: {
        auth_version: input.authVersion,
        email: "user@example.com",
        id: "11111111-1111-4111-8111-111111111111",
        status: input.status,
      },
      error: null,
    }),
    select: vi.fn(),
  };
  builder.eq.mockReturnValue(builder);
  builder.select.mockReturnValue(builder);

  return {
    from: vi.fn().mockReturnValue(builder),
  } as unknown as AdminDbClient;
}

async function token(authVersion: number) {
  return (
    await createAccessToken(env, {
      authVersion,
      email: "user@example.com",
      id: "11111111-1111-4111-8111-111111111111",
      userMetadata: {},
    })
  ).access_token;
}

describe("request authentication account state", () => {
  it("accepts an active account with a matching auth version", async () => {
    const accessToken = await token(3);
    const auth = createRequestAuthenticator(env, {
      getAdminClient: () => accountClient({ authVersion: 3, status: "active" }),
    });

    const user = await auth.authenticate({
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(user?.authVersion).toBe(3);
    expect(user?.email).toBe("user@example.com");
    invalidateAuthCacheForUser("11111111-1111-4111-8111-111111111111");
  });

  it("rejects a suspended account even when the token is valid", async () => {
    const accessToken = await token(1);
    const auth = createRequestAuthenticator(env, {
      getAdminClient: () =>
        accountClient({ authVersion: 1, status: "suspended" }),
    });

    await expect(
      auth.authenticate({
        headers: { authorization: `Bearer ${accessToken}` },
      }),
    ).resolves.toBeNull();
  });

  it("rejects a token issued before the auth version changed", async () => {
    const accessToken = await token(2);
    const auth = createRequestAuthenticator(env, {
      getAdminClient: () => accountClient({ authVersion: 3, status: "active" }),
    });

    await expect(
      auth.authenticate({
        headers: { authorization: `Bearer ${accessToken}` },
      }),
    ).resolves.toBeNull();
  });
});
