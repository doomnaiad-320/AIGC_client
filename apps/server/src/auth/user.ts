import type { FastifyRequest } from "fastify";
import { jwtVerify, SignJWT } from "jose";

import type { ServerEnv } from "../config/env.js";

export { createUserDbClientFactory } from "../db/client.js";
export type { UserDbClient } from "../db/client.js";

export type AuthenticatedUser = {
  accessToken: string;
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
const tokenCache = new Map<string, { expiresAt: number; user: AuthenticatedUser }>();

export function createRequestAuthenticator(
  env: Pick<ServerEnv, "appJwtSecret">,
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
        const email = typeof payload.email === "string" ? payload.email : null;
        if (!id || !email) return null;

        const user: AuthenticatedUser = {
          accessToken,
          email,
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
