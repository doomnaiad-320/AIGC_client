import type {
  AdminAuditEvent,
  AdminCreditAdjustmentRequest,
  AdminCreditAdjustmentResponse,
  AdminCreditTransaction,
  AdminJob,
  AdminOverview,
  AdminUser,
} from "@loomic/shared";

import type { AdminDbClient } from "../../db/client.js";

export class PlatformAdminServiceError extends Error {
  constructor(
    readonly code:
      | "platform_admin_required"
      | "admin_query_failed"
      | "credit_adjustment_failed",
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "PlatformAdminServiceError";
  }
}

export type PlatformAdminService = {
  isPlatformAdmin(userId: string): Promise<boolean>;
  getOverview(): Promise<AdminOverview>;
  listUsers(input?: { limit?: number; search?: string }): Promise<AdminUser[]>;
  listJobs(input?: { limit?: number; status?: string }): Promise<AdminJob[]>;
  listTransactions(input?: { limit?: number }): Promise<
    AdminCreditTransaction[]
  >;
  listAuditEvents(input?: { limit?: number }): Promise<AdminAuditEvent[]>;
  adjustCredits(
    actorUserId: string,
    input: AdminCreditAdjustmentRequest,
  ): Promise<AdminCreditAdjustmentResponse>;
};

const USER_COLUMNS = `
  u.id,
  u.email,
  coalesce(p.display_name, split_part(u.email, '@', 1)) as "displayName",
  u.created_at as "createdAt",
  u.last_sign_in_at as "lastSignInAt",
  w.id as "workspaceId",
  w.name as "workspaceName",
  coalesce(s.plan::text, 'free') as plan,
  coalesce(cb.balance, 0)::int as balance,
  (pa.user_id is not null) as "isPlatformAdmin"
`;

const USER_JOINS = `
  left join public.profiles p on p.id = u.id
  left join lateral (
    select id, name
    from public.workspaces
    where owner_user_id = u.id
    order by created_at asc
    limit 1
  ) w on true
  left join public.subscriptions s on s.workspace_id = w.id
  left join public.credit_balances cb on cb.workspace_id = w.id
  left join public.platform_admins pa on pa.user_id = u.id
`;

export function createPlatformAdminService(options: {
  getAdminClient: () => AdminDbClient;
}): PlatformAdminService {
  const getAdmin = options.getAdminClient;

  return {
    async isPlatformAdmin(userId) {
      const { data, error } = await getAdmin()
        .from("platform_admins")
        .select("user_id")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) {
        throw new PlatformAdminServiceError(
          "admin_query_failed",
          "Unable to verify administrator access.",
          500,
        );
      }
      return !!data;
    },

    async getOverview() {
      const { data, error } = await getAdmin().query<AdminOverview>(`
        select
          (select count(*)::int from public.app_users) as "totalUsers",
          (select count(*)::int from public.background_jobs where status in ('queued', 'running')) as "activeJobs",
          (select count(*)::int from public.background_jobs where status = 'failed' and failed_at >= now() - interval '24 hours') as "failedJobs24h",
          (select count(*)::int from public.admin_audit_events where action = 'credits.adjusted' and created_at >= now() - interval '24 hours') as "adjustments24h"
      `);
      return getOne(data, error, "Unable to load admin overview.");
    },

    async listUsers(input = {}) {
      const search = input.search?.trim() || null;
      const limit = clampLimit(input.limit, 50);
      const { data, error } = await getAdmin().query<AdminUser>(
        `
          select ${USER_COLUMNS}
          from public.app_users u
          ${USER_JOINS}
          where (
            $1::text is null
            or u.email ilike '%' || $1 || '%'
            or coalesce(p.display_name, '') ilike '%' || $1 || '%'
          )
          order by u.created_at desc
          limit $2::int
        `,
        [search, limit],
      );
      return getMany(data, error, "Unable to load users.");
    },

    async listJobs(input = {}) {
      const limit = clampLimit(input.limit, 50);
      const { data, error } = await getAdmin().query<AdminJob>(
        `
          select
            j.id,
            j.job_type::text as "jobType",
            j.status::text as status,
            j.created_at as "createdAt",
            j.started_at as "startedAt",
            j.completed_at as "completedAt",
            j.error_code as "errorCode",
            j.error_message as "errorMessage",
            w.name as "workspaceName",
            u.email as "userEmail",
            p.display_name as "userDisplayName"
          from public.background_jobs j
          left join public.workspaces w on w.id = j.workspace_id
          left join public.app_users u on u.id = j.created_by
          left join public.profiles p on p.id = j.created_by
          where ($1::text is null or j.status::text = $1)
          order by j.created_at desc
          limit $2::int
        `,
        [input.status?.trim() || null, limit],
      );
      return getMany(data, error, "Unable to load jobs.");
    },

    async listTransactions(input = {}) {
      const { data, error } = await getAdmin().query<AdminCreditTransaction>(
        `
          select
            t.id,
            t.transaction_type::text as "transactionType",
            t.amount,
            t.balance_after as "balanceAfter",
            t.description,
            t.created_at as "createdAt",
            t.workspace_id as "workspaceId",
            w.name as "workspaceName",
            u.email as "userEmail",
            p.display_name as "userDisplayName"
          from public.credit_transactions t
          left join public.workspaces w on w.id = t.workspace_id
          left join public.app_users u on u.id = t.user_id
          left join public.profiles p on p.id = t.user_id
          order by t.created_at desc
          limit $1::int
        `,
        [clampLimit(input.limit, 50)],
      );
      return getMany(data, error, "Unable to load credit transactions.");
    },

    async listAuditEvents(input = {}) {
      const { data, error } = await getAdmin().query<AdminAuditEvent>(
        `
          select
            e.id,
            e.action,
            actor.email as "actorEmail",
            target.email as "targetEmail",
            w.name as "workspaceName",
            e.metadata,
            e.created_at as "createdAt"
          from public.admin_audit_events e
          join public.app_users actor on actor.id = e.actor_user_id
          left join public.app_users target on target.id = e.target_user_id
          left join public.workspaces w on w.id = e.target_workspace_id
          order by e.created_at desc
          limit $1::int
        `,
        [clampLimit(input.limit, 50)],
      );
      return getMany(data, error, "Unable to load audit events.");
    },

    async adjustCredits(actorUserId, input) {
      const { data, error } = await getAdmin().rpc<{
        transaction_id: string;
        balance: number;
      }>("admin_adjust_credits", {
        p_workspace_id: input.workspaceId,
        p_target_user_id: input.targetUserId,
        p_actor_user_id: actorUserId,
        p_amount: input.amount,
        p_reason: input.reason,
      });

      if (error || !data) {
        const message = error?.message ?? "Unable to adjust credits.";
        if (message.includes("INSUFFICIENT_CREDITS")) {
          throw new PlatformAdminServiceError(
            "credit_adjustment_failed",
            "This adjustment would make the balance negative.",
            400,
          );
        }
        throw new PlatformAdminServiceError(
          "credit_adjustment_failed",
          "Unable to adjust credits.",
          500,
        );
      }

      return {
        transactionId: data.transaction_id,
        balance: data.balance,
      };
    },
  };
}

function clampLimit(value: number | undefined, fallback: number) {
  return Math.min(Math.max(value ?? fallback, 1), 100);
}

function getOne<T>(
  data: T[] | null,
  error: { message: string } | null,
  message: string,
) {
  if (error || !data?.[0]) {
    throw new PlatformAdminServiceError("admin_query_failed", message, 500);
  }
  return data[0];
}

function getMany<T>(
  data: T[] | null,
  error: { message: string } | null,
  message: string,
) {
  if (error) {
    throw new PlatformAdminServiceError("admin_query_failed", message, 500);
  }
  return data ?? [];
}
