import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { createAccessToken } from "../auth/user.js";
import type { ServerEnv } from "../config/env.js";
import type { AdminDbClient } from "../db/client.js";

const scrypt = promisify(scryptCallback);

const authRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().trim().min(1).max(80).optional(),
});

type AppUserRow = {
  id: string;
  email: string;
  password_hash: string;
  user_metadata: Record<string, unknown> | null;
};

export async function registerAuthRoutes(
  app: FastifyInstance,
  options: {
    env: Pick<ServerEnv, "appJwtSecret">;
    getAdminClient: () => AdminDbClient;
  },
) {
  app.post("/api/auth/register", async (request, reply) => {
    const parsed = authRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: "invalid_auth_request", message: "Invalid email or password." },
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
      .select("id, email, password_hash, user_metadata")
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
        error: { code: "invalid_auth_request", message: "Invalid email or password." },
      });
    }

    const email = normalizeEmail(parsed.data.email);
    const admin = options.getAdminClient();
    const { data, error } = await admin
      .from<AppUserRow>("app_users")
      .select("id, email, password_hash, user_metadata")
      .eq("email", email)
      .maybeSingle();

    if (error || !data || !(await verifyPassword(parsed.data.password, data.password_hash))) {
      return reply.code(401).send({
        error: { code: "invalid_credentials", message: "Invalid email or password." },
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
      email: data.email,
      id: data.id,
      userMetadata,
    });

    return reply.code(200).send({ session });
  });
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("base64url");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return "scrypt$" + salt + "$" + derived.toString("base64url");
}

async function verifyPassword(password: string, storedHash: string) {
  const [scheme, salt, hash] = storedHash.split("$", 3);
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(hash, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
