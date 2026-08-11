import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  type RequestAuthenticator,
  createAccessToken,
  invalidateAuthCacheForUser,
} from "../auth/user.js";
import type { ServerEnv } from "../config/env.js";
import type { AdminDbClient } from "../db/client.js";

const scrypt = promisify(scryptCallback);

const authRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().trim().min(1).max(80).optional(),
});

const changePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(8).max(256),
    newPassword: z.string().min(8).max(256),
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: "New password must be different from the current password.",
    path: ["newPassword"],
  });

const completePasswordResetRequestSchema = z.object({
  newPassword: z.string().min(8).max(256),
  resetToken: z.string().min(32).max(256),
});

type AppUserRow = {
  auth_version: number;
  id: string;
  email: string;
  password_hash: string;
  status: "active" | "suspended" | "disabled";
  user_metadata: Record<string, unknown> | null;
};

export async function registerAuthRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    env: Pick<ServerEnv, "appJwtSecret">;
    getAdminClient: () => AdminDbClient;
  },
) {
  app.post("/api/auth/register", async (request, reply) => {
    const parsed = authRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "invalid_auth_request",
          message: "Invalid email or password.",
        },
      });
    }

    const email = normalizeEmail(parsed.data.email);
    const userMetadata = {
      display_name: parsed.data.displayName ?? email.split("@")[0],
    };

    const admin = options.getAdminClient();
    const { data, error } = await admin
      .from<AppUserRow>("app_users")
      .insert({
        email,
        password_hash: await hashPassword(parsed.data.password),
        user_metadata: userMetadata,
      })
      .select("id, email, password_hash, user_metadata, status, auth_version")
      .single();

    if (error || !data) {
      const isDuplicate = error?.code === "23505";
      return reply.code(isDuplicate ? 409 : 500).send({
        error: {
          code: isDuplicate ? "email_already_registered" : "register_failed",
          message: isDuplicate
            ? "Email is already registered."
            : "Unable to create account.",
        },
      });
    }

    await admin.rpc("bootstrap_viewer", {
      p_email: data.email,
      p_user_id: data.id,
      p_user_meta: userMetadata,
    });

    const session = await createAccessToken(options.env, {
      authVersion: data.auth_version,
      email: data.email,
      id: data.id,
      userMetadata,
    });

    return reply.code(201).send({ session });
  });

  app.post("/api/auth/login", async (request, reply) => {
    const parsed = authRequestSchema
      .pick({ email: true, password: true })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "invalid_auth_request",
          message: "Invalid email or password.",
        },
      });
    }

    const email = normalizeEmail(parsed.data.email);
    const admin = options.getAdminClient();
    const { data, error } = await admin
      .from<AppUserRow>("app_users")
      .select("id, email, password_hash, user_metadata, status, auth_version")
      .eq("email", email)
      .maybeSingle();

    if (
      error ||
      !data ||
      !(await verifyPassword(parsed.data.password, data.password_hash))
    ) {
      return reply.code(401).send({
        error: {
          code: "invalid_credentials",
          message: "Invalid email or password.",
        },
      });
    }
    if (data.status !== "active") {
      return reply.code(403).send({
        error: {
          code: "account_unavailable",
          message: "This account is not currently available.",
        },
      });
    }

    await admin
      .from("app_users")
      .update({ last_sign_in_at: new Date().toISOString() })
      .eq("id", data.id);

    const userMetadata = data.user_metadata ?? {};
    await admin.rpc("bootstrap_viewer", {
      p_email: data.email,
      p_user_id: data.id,
      p_user_meta: userMetadata,
    });

    const session = await createAccessToken(options.env, {
      authVersion: data.auth_version,
      email: data.email,
      id: data.id,
      userMetadata,
    });

    return reply.code(200).send({ session });
  });

  app.post("/api/auth/password", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) {
      return reply.code(401).send({
        error: {
          code: "unauthorized",
          message: "Missing or invalid bearer token.",
        },
      });
    }

    const parsed = changePasswordRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "invalid_password_change_request",
          message:
            "Enter a valid current password and a different new password.",
        },
      });
    }

    const admin = options.getAdminClient();
    const { data, error } = await admin
      .from<Pick<AppUserRow, "id" | "password_hash">>("app_users")
      .select("id, password_hash")
      .eq("id", user.id)
      .maybeSingle();

    if (error || !data) {
      return reply.code(500).send({
        error: {
          code: "password_change_failed",
          message: "Unable to update password.",
        },
      });
    }

    if (
      !(await verifyPassword(parsed.data.currentPassword, data.password_hash))
    ) {
      return reply.code(400).send({
        error: {
          code: "invalid_current_password",
          message: "Current password is incorrect.",
        },
      });
    }

    const { error: updateError } = await admin.query(
      `
        update public.app_users
        set password_hash = $2::text,
            auth_version = auth_version + 1,
            updated_at = now()
        where id = $1::uuid
      `,
      [user.id, await hashPassword(parsed.data.newPassword)],
    );

    if (updateError) {
      return reply.code(500).send({
        error: {
          code: "password_change_failed",
          message: "Unable to update password.",
        },
      });
    }

    invalidateAuthCacheForUser(user.id);

    return reply.code(204).send();
  });

  app.post("/api/auth/password-reset", async (request, reply) => {
    const parsed = completePasswordResetRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "invalid_password_reset_request",
          message: "Enter a valid reset token and new password.",
        },
      });
    }

    const tokenHash = createHash("sha256")
      .update(parsed.data.resetToken)
      .digest("hex");
    const passwordHash = await hashPassword(parsed.data.newPassword);
    const { data, error } = await options.getAdminClient().query<{
      userId: string;
    }>(
      `
        with valid_token as materialized (
          select id, user_id
          from public.admin_password_reset_tokens
          where token_hash = $1::text
            and used_at is null
            and revoked_at is null
            and expires_at > now()
          for update
        ),
        updated_user as (
          update public.app_users u
          set password_hash = $2::text,
              auth_version = u.auth_version + 1,
              updated_at = now()
          from valid_token t
          where u.id = t.user_id
          returning u.id
        ),
        consumed_token as (
          update public.admin_password_reset_tokens token
          set used_at = now()
          from valid_token t
          where token.id = t.id
            and exists (
              select 1 from updated_user u where u.id = t.user_id
            )
          returning token.user_id
        )
        select user_id as "userId" from consumed_token
      `,
      [tokenHash, passwordHash],
    );

    const userId = data?.[0]?.userId;
    if (error || !userId) {
      return reply.code(400).send({
        error: {
          code: "invalid_or_expired_password_reset",
          message: "The password reset token is invalid or has expired.",
        },
      });
    }

    invalidateAuthCacheForUser(userId);
    return reply.code(204).send();
  });
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("base64url");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, storedHash: string) {
  const [scheme, salt, hash] = storedHash.split("$", 3);
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(hash, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
