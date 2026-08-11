import type { FastifyRequest } from "fastify";
import { SignJWT, jwtVerify } from "jose";

import type { ServerEnv } from "../config/env.js";
import type { AdminDbClient } from "../db/client.js";

export { createUserDbClientFactory } from "../db/client.js";
export type { UserDbClient } from "../db/client.js";

export type AuthenticatedUser = {
  accessToken: string;
  authVersion: number;
  email: string;
  id: string;
  userMetadata: Record<string, unknown>;
};

export type RequestAuthenticator = {
  authenticate(
    request: Pick<FastifyRequest, "headers">,
  ): Promise<AuthenticatedUser | null>;
};

const AUTH_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_DEV_SECRET = "loomic-local-dev-secret-change-me";
const tokenCache = new Map<
  string,
  { expiresAt: number; user: AuthenticatedUser }
>();

export function createRequestAuthenticator(
  env: Pick<ServerEnv, "appJwtSecret">,
  options: { getAdminClient: () => AdminDbClient },
): RequestAuthenticator {
  const secret = getJwtSecret(env);

  return {
    async authenticate(request) {
      const accessToken = readBearerToken(request.headers.authorization);
      if (!accessToken) return null;

      const cached = getCached(accessToken);
      if (cached) return cached;

      try {
        const { payload } = await jwtVerify(accessToken, secret, {
          audience: "authenticated",
        });
        const id = payload.sub;
        const tokenEmail =
          typeof payload.email === "string" ? payload.email : null;
        const tokenAuthVersion =
          typeof payload.auth_version === "number" &&
          Number.isInteger(payload.auth_version) &&
          payload.auth_version >= 0
            ? payload.auth_version
            : 0;
        if (!id || !tokenEmail) return null;

        const { data: account, error } = await options
          .getAdminClient()
          .from<{
            auth_version: number;
            email: string;
            id: string;
            status: string;
          }>("app_users")
          .select("id, email, status, auth_version")
          .eq("id", id)
          .maybeSingle();
        if (
          error ||
          !account ||
          account.status !== "active" ||
          account.auth_version !== tokenAuthVersion
        ) {
          return null;
        }

        const user: AuthenticatedUser = {
          accessToken,
          authVersion: account.auth_version,
          email: account.email,
          id,
          userMetadata: isRecord(payload.user_metadata)
            ? (payload.user_metadata as Record<string, unknown>)
            : {},
        };
        setCached(accessToken, user);
        return user;
      } catch {
        return null;
      }
    },
  };
}

export async function createAccessToken(
  env: Pick<ServerEnv, "appJwtSecret">,
  user: Omit<AuthenticatedUser, "accessToken">,
) {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 60 * 60 * 24 * 30;
  const token = await new SignJWT({
    aud: "authenticated",
    auth_version: user.authVersion,
    email: user.email,
    user_metadata: user.userMetadata,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .setSubject(user.id)
    .sign(getJwtSecret(env));

  return {
    access_token: token,
    expires_at: expiresAt,
    token_type: "bearer",
    user: {
      email: user.email,
      id: user.id,
      user_metadata: user.userMetadata,
    },
  };
}

export function invalidateAuthCacheForUser(userId: string) {
  for (const [token, cached] of tokenCache) {
    if (cached.user.id === userId) tokenCache.delete(token);
  }
}

function getJwtSecret(env: Pick<ServerEnv, "appJwtSecret">) {
  return new TextEncoder().encode(env.appJwtSecret ?? DEFAULT_DEV_SECRET);
}

function readBearerToken(authorizationHeader: string | string[] | undefined) {
  if (typeof authorizationHeader !== "string") return null;
  const [scheme, token] = authorizationHeader.trim().split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

function getCached(token: string) {
  const cached = tokenCache.get(token);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    tokenCache.delete(token);
    return null;
  }
  return cached.user;
}

function setCached(token: string, user: AuthenticatedUser) {
  tokenCache.set(token, { expiresAt: Date.now() + AUTH_CACHE_TTL_MS, user });
  if (tokenCache.size > 500) {
    const now = Date.now();
    for (const [key, value] of tokenCache) {
      if (value.expiresAt <= now) tokenCache.delete(key);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
