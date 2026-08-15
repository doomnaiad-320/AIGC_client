import type pg from "pg";

import type { ServerEnv } from "../config/env.js";
import { type PostgresPool, createPostgresPool } from "./postgres.js";
import {
  type LocalStorageClient,
  createLocalStorageClient,
} from "./storage.js";

export type DbError = {
  code?: string;
  details?: string;
  message: string;
};

export type DbResult<T = any> = {
  count?: number | null;
  data: T | null;
  error: DbError | null;
};

export type DbClient = {
  from<T = any>(table: string): DbQueryBuilder<T>;
  rpc<T = unknown>(
    functionName: string,
    args?: Record<string, unknown>,
  ): Promise<DbResult<T>>;
  storage: LocalStorageClient;
};

export type AdminDbClient = DbClient & {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<DbResult<T[]>>;
};
export type UserDbClient = DbClient;

type DbScope =
  | { kind: "admin" }
  | { kind: "user"; accessToken: string; userId: string };

type QueryOperation = "select" | "insert" | "update" | "delete" | "upsert";

type Filter = {
  column: string;
  op: "=" | "<>" | "is" | "is not" | "in";
  value: unknown;
};

type OrderBy = {
  ascending: boolean;
  column: string;
};

type SelectOptions = {
  count?: "exact";
  head?: boolean;
};

export type DbQueryBuilder<T = any> = PromiseLike<DbResult<T[] | T>> & {
  select(columns?: string, options?: SelectOptions): DbQueryBuilder<T>;
  insert(
    values: Record<string, unknown> | Record<string, unknown>[],
  ): DbQueryBuilder<T>;
  update(values: Record<string, unknown>): DbQueryBuilder<T>;
  upsert(
    values: Record<string, unknown> | Record<string, unknown>[],
    options?: { onConflict?: string },
  ): DbQueryBuilder<T>;
  delete(options?: { count?: "exact" }): DbQueryBuilder<T>;
  eq(column: string, value: unknown): DbQueryBuilder<T>;
  neq(column: string, value: unknown): DbQueryBuilder<T>;
  is(column: string, value: unknown): DbQueryBuilder<T>;
  in(column: string, values: unknown[]): DbQueryBuilder<T>;
  not(column: string, operator: "is", value: unknown): DbQueryBuilder<T>;
  order(column: string, options?: { ascending?: boolean }): DbQueryBuilder<T>;
  limit(count: number): DbQueryBuilder<T>;
  range(from: number, to: number): DbQueryBuilder<T>;
  single(): Promise<DbResult<T>>;
  maybeSingle(): Promise<DbResult<T | null>>;
};

export function createAdminDbClient(
  env: Pick<
    ServerEnv,
    | "appJwtSecret"
    | "databaseUrl"
    | "postgresPoolMax"
    | "serverPublicUrl"
    | "storageRoot"
  >,
  pool = requirePostgresPool(env),
): AdminDbClient {
  const scope: DbScope = { kind: "admin" };
  const client = createDbClient({ env, pool, scope });

  return {
    ...client,
    async query<T = Record<string, unknown>>(
      sql: string,
      values: unknown[] = [],
    ) {
      try {
        const result = await executeScopedQuery(pool, scope, sql, values);
        return { data: result.rows as T[], error: null };
      } catch (error) {
        return { data: null, error: toDbError(error) };
      }
    },
  };
}

export function createUserDbClientFactory(
  env: Pick<
    ServerEnv,
    | "appJwtSecret"
    | "databaseUrl"
    | "postgresPoolMax"
    | "serverPublicUrl"
    | "storageRoot"
  >,
  pool = requirePostgresPool(env),
) {
  return (accessToken: string): UserDbClient => {
    const userId = parseTokenUserId(accessToken);
    if (!userId) {
      throw new Error("Invalid app access token.");
    }

    return createDbClient({
      env,
      pool,
      scope: { accessToken, kind: "user", userId },
    });
  };
}

export function createDbClient(options: {
  env: Pick<ServerEnv, "appJwtSecret" | "serverPublicUrl" | "storageRoot">;
  pool: PostgresPool;
  scope: DbScope;
}): DbClient {
  const execute = (sql: string, values: unknown[]) =>
    executeScopedQuery(options.pool, options.scope, sql, values);

  return {
    from<T = any>(table: string) {
      return new QueryBuilder<T>(
        table,
        execute,
      ) as unknown as DbQueryBuilder<T>;
    },
    rpc(functionName, args = {}) {
      return executeRpc(execute, functionName, args);
    },
    storage: createLocalStorageClient(options.env),
  };
}

function requirePostgresPool(
  env: Pick<ServerEnv, "databaseUrl" | "postgresPoolMax">,
) {
  const pool = createPostgresPool(env);
  if (!pool) {
    throw new Error("DATABASE_URL is required for PostgreSQL access.");
  }
  return pool;
}

async function executeScopedQuery(
  pool: PostgresPool,
  scope: DbScope,
  sql: string,
  values: unknown[],
): Promise<pg.QueryResult<any>> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      scope.kind === "admin"
        ? "set local role service_role"
        : "set local role authenticated",
    );
    await client.query("select set_config($1, $2, true)", [
      "app.is_service_role",
      scope.kind === "admin" ? "true" : "false",
    ]);
    await client.query("select set_config($1, $2, true)", [
      "app.user_id",
      scope.kind === "user" ? scope.userId : "",
    ]);
    const result = await client.query(sql, values);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

class QueryBuilder<T = any> implements PromiseLike<DbResult<T[] | T>> {
  private filters: Filter[] = [];
  private limitCount: number | null = null;
  private offsetCount: number | null = null;
  private operation: QueryOperation = "select";
  private orders: OrderBy[] = [];
  private selectColumns = "*";
  private selectOptions: SelectOptions = {};
  private mutationValues:
    | Record<string, unknown>
    | Record<string, unknown>[]
    | null = null;
  private upsertConflictColumns: string[] = [];
  private deleteCountExact = false;

  constructor(
    private readonly table: string,
    private readonly executeQuery: (
      sql: string,
      values: unknown[],
    ) => Promise<pg.QueryResult<any>>,
  ) {}

  select(columns = "*", options: SelectOptions = {}) {
    this.operation = this.operation === "select" ? "select" : this.operation;
    this.selectColumns = normalizeSelection(columns);
    this.selectOptions = options;
    return this as unknown as DbQueryBuilder<T>;
  }

  insert(values: Record<string, unknown> | Record<string, unknown>[]) {
    this.operation = "insert";
    this.mutationValues = values;
    return this as unknown as DbQueryBuilder<T>;
  }

  update(values: Record<string, unknown>) {
    this.operation = "update";
    this.mutationValues = values;
    return this as unknown as DbQueryBuilder<T>;
  }

  upsert(
    values: Record<string, unknown> | Record<string, unknown>[],
    options: { onConflict?: string } = {},
  ) {
    this.operation = "upsert";
    this.mutationValues = values;
    this.upsertConflictColumns = (options.onConflict ?? "")
      .split(",")
      .map((column) => column.trim())
      .filter(Boolean);
    return this as unknown as DbQueryBuilder<T>;
  }

  delete(options: { count?: "exact" } = {}) {
    this.operation = "delete";
    this.deleteCountExact = options.count === "exact";
    return this as unknown as DbQueryBuilder<T>;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ column, op: "=", value });
    return this as unknown as DbQueryBuilder<T>;
  }

  neq(column: string, value: unknown) {
    this.filters.push({ column, op: "<>", value });
    return this as unknown as DbQueryBuilder<T>;
  }

  is(column: string, value: unknown) {
    this.filters.push({ column, op: "is", value });
    return this as unknown as DbQueryBuilder<T>;
  }

  in(column: string, values: unknown[]) {
    this.filters.push({ column, op: "in", value: values });
    return this as unknown as DbQueryBuilder<T>;
  }

  not(column: string, operator: "is", value: unknown) {
    if (operator !== "is") {
      throw new Error(`Unsupported not() operator: ${operator}`);
    }
    this.filters.push({ column, op: "is not", value });
    return this as unknown as DbQueryBuilder<T>;
  }

  order(column: string, options: { ascending?: boolean } = {}) {
    this.orders.push({ column, ascending: options.ascending ?? true });
    return this as unknown as DbQueryBuilder<T>;
  }

  limit(count: number) {
    this.limitCount = count;
    return this as unknown as DbQueryBuilder<T>;
  }

  range(from: number, to: number) {
    this.offsetCount = from;
    this.limitCount = Math.max(0, to - from + 1);
    return this as unknown as DbQueryBuilder<T>;
  }

  async single() {
    this.limitCount = 1;
    const result = await this.execute();
    const rows = Array.isArray(result.data) ? result.data : [];
    if (result.error) return { data: null, error: result.error };
    if (rows.length !== 1) {
      return {
        data: null,
        error: { message: "Expected exactly one row." },
      };
    }
    return { data: rows[0] as T, error: null };
  }

  async maybeSingle() {
    this.limitCount = 1;
    const result = await this.execute();
    const rows = Array.isArray(result.data) ? result.data : [];
    if (result.error) return { data: null, error: result.error };
    return { data: (rows[0] as T | undefined) ?? null, error: null };
  }

  then<TResult1 = DbResult<T[] | T>, TResult2 = never>(
    onfulfilled?:
      | ((value: DbResult<T[] | T>) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<DbResult<T[] | T>> {
    try {
      const built = this.build();
      const result = await this.executeQuery(built.sql, built.values);
      if (built.head) {
        const count = Number(
          (result.rows[0] as { count?: number })?.count ?? 0,
        );
        return { count, data: null, error: null };
      }
      return {
        count: built.countFromRowCount ? (result.rowCount ?? 0) : null,
        data: result.rows as T[],
        error: null,
      };
    } catch (error) {
      return { data: null, error: toDbError(error) };
    }
  }

  private build() {
    switch (this.operation) {
      case "select":
        return this.buildSelect();
      case "insert":
        return this.buildInsert(false);
      case "upsert":
        return this.buildInsert(true);
      case "update":
        return this.buildUpdate();
      case "delete":
        return this.buildDelete();
    }
  }

  private buildSelect() {
    const values: unknown[] = [];
    const selection = buildSelectExpression(this.table, this.selectColumns);
    const where = buildWhere(this.filters, values, "t");
    const order = buildOrder(this.orders, "t");
    const limit = buildLimit(this.limitCount, this.offsetCount, values);

    if (this.selectOptions.head) {
      return {
        head: true,
        sql: `select count(*)::int as count from ${quoteIdent(
          this.table,
        )} as t ${selection.joins} ${where}`,
        values,
      };
    }

    return {
      countFromRowCount: false,
      head: false,
      sql: `select ${selection.sql} from ${quoteIdent(this.table)} as t ${selection.joins} ${where} ${order} ${limit}`,
      values,
    };
  }

  private buildInsert(isUpsert: boolean) {
    const rows = normalizeRows(this.mutationValues);
    if (rows.length === 0) {
      throw new Error("No values supplied for insert.");
    }
    const columns = Array.from(
      rows.reduce((set, row) => {
        for (const key of Object.keys(row)) set.add(key);
        return set;
      }, new Set<string>()),
    );
    if (columns.length === 0) {
      throw new Error("No columns supplied for insert.");
    }

    const values: unknown[] = [];
    const tuples = rows
      .map((row) => {
        const placeholders = columns.map((column) => {
          values.push(row[column] ?? null);
          return `$${values.length}`;
        });
        return `(${placeholders.join(", ")})`;
      })
      .join(", ");

    const conflictSql =
      isUpsert && this.upsertConflictColumns.length > 0
        ? buildUpsertConflict(columns, this.upsertConflictColumns)
        : "";
    const returning = buildReturningExpression(this.selectColumns);

    return {
      countFromRowCount: false,
      head: false,
      sql: `insert into ${quoteIdent(this.table)} (${columns.map(quoteIdent).join(", ")}) values ${tuples} ${conflictSql} ${returning}`,
      values,
    };
  }

  private buildUpdate() {
    const row = normalizeRow(this.mutationValues);
    const columns = Object.keys(row);
    if (columns.length === 0) {
      throw new Error("No values supplied for update.");
    }

    const values: unknown[] = [];
    const setSql = columns
      .map((column) => {
        values.push(row[column]);
        return `${quoteIdent(column)} = $${values.length}`;
      })
      .join(", ");
    const where = buildWhere(this.filters, values, "t");
    const returning = buildReturningExpression(this.selectColumns);
    return {
      countFromRowCount: false,
      head: false,
      sql: `update ${quoteIdent(this.table)} as t set ${setSql} ${where} ${returning}`,
      values,
    };
  }

  private buildDelete() {
    const values: unknown[] = [];
    const where = buildWhere(this.filters, values, "t");
    return {
      countFromRowCount: this.deleteCountExact,
      head: false,
      sql: `delete from ${quoteIdent(this.table)} as t ${where}`,
      values,
    };
  }
}

async function executeRpc<T>(
  execute: (sql: string, values: unknown[]) => Promise<pg.QueryResult<any>>,
  functionName: string,
  args: Record<string, unknown>,
): Promise<DbResult<T>> {
  try {
    const { sql, values, unwrapColumn } = buildRpc(functionName, args);
    const result = await execute(sql, values);
    const row = result.rows[0] ?? null;
    const data = unwrapColumn && row ? row[unwrapColumn] : row;
    return { data: (data as T) ?? null, error: null };
  } catch (error) {
    return { data: null, error: toDbError(error) };
  }
}

function buildRpc(functionName: string, args: Record<string, unknown>) {
  switch (functionName) {
    case "bootstrap_viewer":
      return {
        sql: "select public.bootstrap_viewer($1::uuid, $2::text, $3::jsonb) as result",
        unwrapColumn: "result",
        values: [
          args.p_user_id,
          args.p_email ?? null,
          JSON.stringify(args.p_user_meta ?? {}),
        ],
      };
    case "create_project_with_canvas":
      return {
        sql: "select public.create_project_with_canvas($1::uuid, $2::text, $3::text, $4::text, $5::text) as result",
        unwrapColumn: "result",
        values: [
          args.p_workspace_id,
          args.p_name,
          args.p_slug,
          args.p_description ?? null,
          args.p_canvas_name ?? "Main Canvas",
        ],
      };
    case "deduct_credits":
      return {
        sql: "select public.deduct_credits($1::uuid, $2::uuid, $3::int, $4::uuid, $5::text) as result",
        unwrapColumn: "result",
        values: [
          args.p_workspace_id,
          args.p_user_id,
          args.p_amount,
          args.p_job_id ?? null,
          args.p_description ?? null,
        ],
      };
    case "refund_credits":
      return {
        sql: "select public.refund_credits($1::uuid, $2::uuid, $3::int, $4::uuid, $5::text) as result",
        unwrapColumn: "result",
        values: [
          args.p_workspace_id,
          args.p_user_id,
          args.p_amount,
          args.p_job_id ?? null,
          args.p_description ?? null,
        ],
      };
    case "claim_daily_credits":
      return {
        sql: "select public.claim_daily_credits($1::uuid, $2::int) as result",
        unwrapColumn: "result",
        values: [args.p_workspace_id, args.p_amount],
      };
    case "has_daily_credit_claim":
      return {
        sql: "select exists(select 1 from public.daily_credit_claims where workspace_id = $1::uuid and claim_date = current_date) as result",
        unwrapColumn: "result",
        values: [args.p_workspace_id],
      };
    case "grant_plan_credits":
      return {
        sql: "select public.grant_plan_credits($1::uuid, $2::public.subscription_plan, $3::int) as result",
        unwrapColumn: "result",
        values: [args.p_workspace_id, args.p_plan, args.p_credits],
      };
    case "billing_get_credit_balance":
      return {
        sql: "select public.billing_get_credit_balance($1::uuid) as result",
        unwrapColumn: "result",
        values: [args.p_workspace_id],
      };
    case "billing_ensure_daily_credit_grant":
      return {
        sql: "select public.billing_ensure_daily_credit_grant($1::uuid) as result",
        unwrapColumn: "result",
        values: [args.p_workspace_id],
      };
    case "billing_deduct_credits":
      return {
        sql: "select public.billing_deduct_credits($1::uuid, $2::uuid, $3::int, $4::uuid, $5::text, $6::text) as result",
        unwrapColumn: "result",
        values: [
          args.p_workspace_id,
          args.p_user_id,
          args.p_amount,
          args.p_job_id ?? null,
          args.p_description ?? null,
          args.p_idempotency_key,
        ],
      };
    case "billing_refund_credits":
      return {
        sql: "select public.billing_refund_credits($1::uuid, $2::uuid, $3::int, $4::uuid, $5::text, $6::text) as result",
        unwrapColumn: "result",
        values: [
          args.p_workspace_id,
          args.p_user_id,
          args.p_amount,
          args.p_job_id,
          args.p_description ?? null,
          args.p_idempotency_key,
        ],
      };
    case "increment_job_attempt":
      return {
        sql: "select * from public.increment_job_attempt($1::uuid)",
        values: [args.p_job_id],
      };
    case "create_and_enqueue_generation_job":
      return {
        sql: "select * from public.create_and_enqueue_generation_job($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::public.background_job_type, $7::jsonb, $8::uuid, $9::int, $10::text)",
        values: [
          args.p_workspace_id,
          args.p_project_id ?? null,
          args.p_canvas_id ?? null,
          args.p_session_id ?? null,
          args.p_thread_id ?? null,
          args.p_job_type,
          JSON.stringify(args.p_payload ?? {}),
          args.p_user_id,
          args.p_credits_cost ?? 0,
          args.p_credit_description ?? null,
        ],
      };
    case "admin_adjust_credits":
      return {
        sql: "select public.admin_adjust_credits($1::uuid, $2::uuid, $3::uuid, $4::int, $5::text, $6::text) as result",
        unwrapColumn: "result",
        values: [
          args.p_workspace_id,
          args.p_target_user_id,
          args.p_actor_user_id,
          args.p_amount,
          args.p_reason,
          args.p_idempotency_key,
        ],
      };
    case "admin_save_billing_plan_draft":
      return {
        sql: "select public.admin_save_billing_plan_draft($1::uuid, $2::text, $3::text, $4::int, $5::int, $6::int, $7::int, $8::boolean, $9::jsonb, $10::text) as result",
        unwrapColumn: "result",
        values: [
          args.p_actor_user_id,
          args.p_plan_code,
          args.p_currency,
          args.p_monthly_price_minor,
          args.p_annual_price_minor,
          args.p_monthly_subscription_credits,
          args.p_daily_credits,
          args.p_top_up_eligible,
          JSON.stringify(args.p_entitlements ?? {}),
          args.p_reason,
        ],
      };
    case "admin_create_billing_plan_draft":
      return {
        sql: "select public.admin_create_billing_plan_draft($1::uuid, $2::text, $3::text) as result",
        unwrapColumn: "result",
        values: [args.p_actor_user_id, args.p_plan_code, args.p_reason],
      };
    case "admin_publish_billing_plan":
      return {
        sql: "select public.admin_publish_billing_plan($1::uuid, $2::text, $3::text) as result",
        unwrapColumn: "result",
        values: [args.p_actor_user_id, args.p_plan_code, args.p_reason],
      };
    default:
      throw new Error(`Unsupported database function: ${functionName}`);
  }
}

function buildSelectExpression(table: string, selection: string) {
  if (table === "canvases" && selection === "project:projects(workspace_id)") {
    return {
      joins: 'left join projects as p on p.id = t."project_id"',
      sql: "jsonb_build_object('workspace_id', p.workspace_id) as project",
    };
  }
  if (
    table === "canvases" &&
    selection === "project_id, projects!inner(brand_kit_id)"
  ) {
    return {
      joins: 'inner join projects as p on p.id = t."project_id"',
      sql: "t.\"project_id\", jsonb_build_object('brand_kit_id', p.brand_kit_id) as projects",
    };
  }
  if (table === "workspace_skills" && selection.includes("skills(*)")) {
    return {
      joins: 'left join skills as s on s.id = t."skill_id"',
      sql: 't."skill_id", t."enabled", t."installed_at", to_jsonb(s.*) as skills',
    };
  }
  if (table === "workspace_skills" && selection.startsWith("skill:skills(")) {
    return {
      joins: 'left join skills as s on s.id = t."skill_id"',
      sql: "jsonb_build_object('id', s.id, 'slug', s.slug, 'name', s.name, 'description', s.description, 'skill_content', s.skill_content, 'metadata', s.metadata) as skill",
    };
  }

  return {
    joins: "",
    sql: buildColumnList(selection, "t"),
  };
}

function buildReturningExpression(selection: string) {
  if (!selection || selection === "*") return "returning *";
  if (selection.includes("(")) return "returning *";
  return `returning ${buildColumnList(selection)}`;
}

function buildColumnList(selection: string, alias?: string) {
  if (!selection || selection === "*") {
    return alias ? `${alias}.*` : "*";
  }
  return selection
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean)
    .map((column) => {
      if (column === "*") return alias ? `${alias}.*` : "*";
      return alias ? `${alias}.${quoteIdent(column)}` : quoteIdent(column);
    })
    .join(", ");
}

function buildWhere(filters: Filter[], values: unknown[], alias: string) {
  if (filters.length === 0) return "";
  const parts = filters.map((filter) => {
    const column = `${alias}.${quoteIdent(filter.column)}`;
    if (filter.op === "is" || filter.op === "is not") {
      return `${column} ${filter.op} ${filter.value === null ? "null" : "$" + pushValue(values, filter.value)}`;
    }
    if (filter.op === "in") {
      const list = Array.isArray(filter.value) ? filter.value : [];
      if (list.length === 0) return "false";
      const placeholders = list.map((item) => `$${pushValue(values, item)}`);
      return `${column} in (${placeholders.join(", ")})`;
    }
    return `${column} ${filter.op} $${pushValue(values, filter.value)}`;
  });
  return `where ${parts.join(" and ")}`;
}

function buildOrder(orders: OrderBy[], alias: string) {
  if (orders.length === 0) return "";
  return `order by ${orders
    .map(
      (order) =>
        `${alias}.${quoteIdent(order.column)} ${order.ascending ? "asc" : "desc"}`,
    )
    .join(", ")}`;
}

function buildLimit(
  limitCount: number | null,
  offsetCount: number | null,
  values: unknown[],
) {
  const parts: string[] = [];
  if (limitCount !== null) {
    parts.push(`limit $${pushValue(values, limitCount)}`);
  }
  if (offsetCount !== null) {
    parts.push(`offset $${pushValue(values, offsetCount)}`);
  }
  return parts.join(" ");
}

function buildUpsertConflict(columns: string[], conflictColumns: string[]) {
  const updateColumns = columns.filter(
    (column) => !conflictColumns.includes(column),
  );
  const conflictSql = conflictColumns.map(quoteIdent).join(", ");
  if (updateColumns.length === 0) {
    return `on conflict (${conflictSql}) do nothing`;
  }
  return `on conflict (${conflictSql}) do update set ${updateColumns
    .map((column) => `${quoteIdent(column)} = excluded.${quoteIdent(column)}`)
    .join(", ")}`;
}

function normalizeSelection(selection: string) {
  return selection.replace(/\s+/g, " ").trim() || "*";
}

function normalizeRows(
  value: Record<string, unknown> | Record<string, unknown>[] | null,
) {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  return rows.map(normalizeRow);
}

function normalizeRow(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([, entryValue]) => entryValue !== undefined,
    ),
  );
}

function pushValue(values: unknown[], value: unknown) {
  values.push(value);
  return values.length;
}

function quoteIdent(identifier: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function toDbError(error: unknown): DbError {
  if (error && typeof error === "object") {
    const maybe = error as { code?: string; detail?: string; message?: string };
    return {
      ...(maybe.code ? { code: maybe.code } : {}),
      ...(maybe.detail ? { details: maybe.detail } : {}),
      message: maybe.message ?? String(error),
    };
  }
  return { message: String(error) };
}

function parseTokenUserId(accessToken: string) {
  const [, payload] = accessToken.split(".");
  if (!payload) return null;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(
      Buffer.from(normalized, "base64").toString("utf8"),
    ) as { sub?: unknown };
    return typeof decoded.sub === "string" ? decoded.sub : null;
  } catch {
    return null;
  }
}
