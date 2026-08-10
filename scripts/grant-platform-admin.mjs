#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import pg from "pg";

async function loadEnv() {
  for (const envFile of [".env.local", ".env"]) {
    try {
      const content = await readFile(envFile, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const separator = trimmed.indexOf("=");
        if (separator < 1) continue;
        const key = trimmed.slice(0, separator).trim();
        const value = trimmed.slice(separator + 1).trim();
        process.env[key] ??= value.replace(/^['\"]|['\"]$/g, "");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function main() {
  const revoke = process.argv[2] === "--revoke";
  const email = process.argv[revoke ? 3 : 2]?.trim().toLowerCase();
  if (!email) {
    throw new Error(
      revoke
        ? "Usage: pnpm admin:revoke <user-email>"
        : "Usage: pnpm admin:grant <user-email>",
    );
  }

  await loadEnv();
  const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required.");

  const client = new pg.Client({
    application_name: "loomic-admin-grant",
    connectionString,
  });
  await client.connect();
  try {
    if (revoke) {
      const result = await client.query(
        `
          DELETE FROM public.platform_admins pa
          USING public.app_users u
          WHERE pa.user_id = u.id AND u.email = $1
          RETURNING pa.user_id
        `,
        [email],
      );
      if (!result.rowCount) {
        throw new Error(`${email} is not a platform admin.`);
      }
      console.log(`Platform admin revoked: ${email}`);
      return;
    }

    const result = await client.query(
      `
        INSERT INTO public.platform_admins (user_id, note)
        SELECT id, 'Granted with scripts/grant-platform-admin.mjs'
        FROM public.app_users
        WHERE email = $1
        ON CONFLICT (user_id) DO NOTHING
        RETURNING user_id
      `,
      [email],
    );

    if (result.rowCount === 0) {
      const existing = await client.query(
        "SELECT 1 FROM public.platform_admins pa JOIN public.app_users u ON u.id = pa.user_id WHERE u.email = $1",
        [email],
      );
      if (existing.rowCount) {
        console.log(`Already a platform admin: ${email}`);
        return;
      }
      throw new Error(
        `No user exists for ${email}. Register or seed the account first.`,
      );
    }

    console.log(`Platform admin granted: ${email}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Admin grant failed: ${error.message}`);
  process.exitCode = 1;
});
