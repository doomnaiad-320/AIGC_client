#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import pg from "pg";

const MIGRATIONS_DIR = path.resolve("db/migrations");
const LOCK_KEY = "loomic_schema_migrations";

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
        let value = trimmed.slice(separator + 1).trim();
        if (
          (value.startsWith("\"") && value.endsWith("\"")) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        process.env[key] ??= value;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function checksum(sql) {
  return createHash("sha256").update(sql).digest("hex");
}

async function main() {
  await loadEnv();
  const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required. Add it to .env.local or the process environment.");
  }

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((file) => file.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  const client = new pg.Client({
    application_name: "loomic-migrations",
    connectionString,
  });

  await client.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext($1))", [LOCK_KEY]);
    await client.query(`
      create table if not exists public.schema_migrations (
        version text primary key,
        name text not null,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);

    for (const file of files) {
      const version = file.split("_", 1)[0];
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      const hash = checksum(sql);
      const applied = await client.query(
        "select checksum from public.schema_migrations where version = $1",
        [version],
      );

      if (applied.rowCount) {
        if (applied.rows[0].checksum !== hash) {
          throw new Error(`Migration ${file} changed after it was applied.`);
        }
        console.log(`[skip] ${file}`);
        continue;
      }

      console.log(`[apply] ${file}`);
      await client.query("begin");
      try {
        await client.query("set local search_path = public, extensions");
        await client.query(sql);
        await client.query(
          "insert into public.schema_migrations (version, name, checksum) values ($1, $2, $3)",
          [version, file, hash],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        error.message = `${file}: ${error.message}`;
        throw error;
      }
    }

    console.log(`Applied ${files.length} PostgreSQL migration files.`);
  } finally {
    await client.query("select pg_advisory_unlock(hashtext($1))", [LOCK_KEY]).catch(() => {});
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
});
