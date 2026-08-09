#!/usr/bin/env tsx
/**
 * Debug script: dump a chat session's full agent execution trace.
 *
 * Usage:
 *   tsx scripts/debug-session.ts <session_id>
 *   tsx scripts/debug-session.ts <canvas_url>
 *
 * Example:
 *   tsx scripts/debug-session.ts c6f649a2-3223-4d05-a8a6-0b7dd1cb51cf
 *   tsx scripts/debug-session.ts "http://localhost:3000/canvas?id=xxx&session=yyy"
 */

import { readFile } from "node:fs/promises";

import pg from "pg";

async function loadEnv() {
  try {
    const content = await readFile(".env.local", "utf8");
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
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function parseSessionId(input: string): { sessionId: string; canvasId?: string } {
  if (input.includes("session=")) {
    const url = new URL(input);
    return {
      sessionId: url.searchParams.get("session") ?? input,
      canvasId: url.searchParams.get("id") ?? undefined,
    };
  }
  return { sessionId: input };
}

function truncate(s: string, max = 120): string {
  if (!s) return "";
  const clean = s.replace(/\n/g, "\\n");
  return clean.length > max ? clean.slice(0, max) + "..." : clean;
}

function formatJson(obj: unknown, max = 200): string {
  const s = JSON.stringify(obj, null, 0);
  return truncate(s ?? "null", max);
}

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

async function main() {
  await loadEnv();
  const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required.");
  }

  const client = new pg.Client({
    application_name: "loomic-debug-session",
    connectionString,
  });
  await client.connect();

  const raw = process.argv[2];
  if (!raw) {
    console.error("Usage: tsx scripts/debug-session.ts <session_id|canvas_url>");
    process.exit(1);
  }

  const { sessionId, canvasId } = parseSessionId(raw);
  console.log(`${C.bold}Session:${C.reset} ${sessionId}`);
  if (canvasId) console.log(`${C.bold}Canvas:${C.reset}  ${canvasId}`);
  console.log();

  // Fetch messages
  const messageResult = await client.query(
    `
      select role, content, content_blocks, created_at
      from public.chat_messages
      where session_id = $1
      order by created_at asc
    `,
    [sessionId],
  );
  const msgs = messageResult.rows;

  if (!Array.isArray(msgs) || msgs.length === 0) {
    console.log(`${C.red}No messages found for this session.${C.reset}`);
    process.exit(1);
  }

  console.log(`${C.bold}Messages: ${msgs.length}${C.reset}\n`);

  for (let mi = 0; mi < msgs.length; mi++) {
    const m = msgs[mi];
    const role = m.role;
    const time = m.created_at?.slice(11, 19) ?? "";
    const roleColor = role === "user" ? C.blue : C.green;

    console.log(
      `${C.bold}${roleColor}━━━ [${mi}] ${role.toUpperCase()} ${C.dim}${time}${C.reset}`,
    );

    // Show user text
    const blocks = m.content_blocks ?? [];
    for (const b of blocks) {
      switch (b.type) {
        case "text":
          console.log(`  ${C.dim}💬${C.reset} ${truncate(b.text, 200)}`);
          break;

        case "thinking":
          console.log(`  ${C.magenta}🧠 thinking:${C.reset} ${truncate(b.thinking, 150)}`);
          break;

        case "image":
          const url = b.url ?? "";
          const prefix = url.startsWith("data:") ? `data:${url.slice(5, 30)}...` : truncate(url, 80);
          console.log(`  ${C.cyan}🖼️  image:${C.reset} ${prefix}`);
          break;

        case "tool": {
          const tn = b.toolName ?? "?";
          const status = b.status ?? "?";
          const statusColor = status === "completed" ? C.green : status === "failed" ? C.red : C.yellow;

          console.log(
            `  ${C.yellow}🔧 ${tn}${C.reset} ${statusColor}[${status}]${C.reset}`,
          );

          // Parse input
          if (b.input) {
            let inputStr: string;
            try {
              const parsed = typeof b.input.input === "string" ? JSON.parse(b.input.input) : b.input;
              inputStr = formatJson(parsed, 250);
            } catch {
              inputStr = formatJson(b.input, 250);
            }
            console.log(`     ${C.dim}→ input:${C.reset}  ${inputStr}`);
          }

          // Parse output
          if (b.output) {
            const out = b.output;
            if (out.success !== undefined) {
              console.log(
                `     ${C.dim}← output:${C.reset} applied=${out.applied ?? "?"} success=${out.success}`,
              );
              if (out.summary) {
                console.log(`     ${C.dim}  summary:${C.reset} ${truncate(out.summary, 200)}`);
              }
              if (out.createdIds) {
                console.log(`     ${C.dim}  ids:${C.reset}     ${formatJson(out.createdIds, 200)}`);
              }
            } else if (out.elements !== undefined) {
              // inspect_canvas output
              console.log(
                `     ${C.dim}← output:${C.reset} ${out.elementCount ?? out.elements?.length ?? 0} elements`,
              );
              if (Array.isArray(out.elements)) {
                for (const el of out.elements.slice(0, 5)) {
                  const t = el.type ?? "?";
                  const id = el.id?.slice(0, 12) ?? "?";
                  const text = el.text ? ` "${truncate(el.text, 30)}"` : "";
                  console.log(
                    `     ${C.dim}  [${t}] ${id} (${Math.round(el.x ?? 0)},${Math.round(el.y ?? 0)}) ${Math.round(el.width ?? 0)}x${Math.round(el.height ?? 0)}${text}${C.reset}`,
                  );
                }
                if (out.elements.length > 5) {
                  console.log(`     ${C.dim}  ... +${out.elements.length - 5} more${C.reset}`);
                }
              }
            } else if (out.summary) {
              console.log(`     ${C.dim}← output:${C.reset} ${truncate(out.summary, 200)}`);
            } else if (out.error) {
              console.log(`     ${C.red}← error:${C.reset}  ${truncate(out.error, 200)}`);
            } else {
              console.log(`     ${C.dim}← output:${C.reset} ${formatJson(out, 150)}`);
            }
          }
          break;
        }

        default:
          console.log(`  ${C.dim}[${b.type}]${C.reset} ${formatJson(b, 100)}`);
      }
    }
    console.log();
  }

  // Canvas element summary
  if (canvasId) {
    console.log(`${C.bold}━━━ CANVAS STATE ━━━${C.reset}`);
    const canvasResult = await client.query(
      "select content from public.canvases where id = $1",
      [canvasId],
    );
    const canvases = canvasResult.rows;
    if (canvases?.[0]?.content) {
      const elements = canvases[0].content.elements ?? [];
      console.log(`Elements: ${elements.length}\n`);

      const byType: Record<string, number> = {};
      for (const el of elements) {
        byType[el.type] = (byType[el.type] ?? 0) + 1;
      }
      for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${type}: ${count}`);
      }
    }
  }

  await client.end();
}

main().catch(console.error);
