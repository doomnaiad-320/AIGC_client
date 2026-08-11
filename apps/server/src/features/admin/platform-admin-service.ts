import { createHash, randomBytes } from "node:crypto";

import type {
  AdminAgentRun,
  AdminAuditEvent,
  AdminCreditAdjustmentRequest,
  AdminCreditAdjustmentResponse,
  AdminCreditTransaction,
  AdminJob,
  AdminOverview,
  AdminPasswordResetRequest,
  AdminPasswordResetResponse,
  AdminPlatformAdmin,
  AdminPlatformAdminMutationRequest,
  AdminUpdateUserRequest,
  AdminUpdateUserStatusRequest,
  AdminUser,
  AdminUserDetail,
} from "@loomic/shared";

import type { AdminDbClient } from "../../db/client.js";

export class PlatformAdminServiceError extends Error {
  constructor(
    readonly code:
      | "platform_admin_required"
      | "admin_user_not_found"
      | "admin_query_failed"
      | "admin_user_update_failed"
      | "admin_user_status_update_failed"
      | "admin_password_reset_failed"
      | "admin_platform_admin_update_failed"
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
  listUsers(input?: {
    limit?: number;
    search?: string;
    status?: string;
  }): Promise<AdminUser[]>;
  getUserDetail(userId: string): Promise<AdminUserDetail>;
  updateUser(
    actorUserId: string,
    userId: string,
    input: AdminUpdateUserRequest,
  ): Promise<AdminUserDetail>;
  updateUserStatus(
    actorUserId: string,
    userId: string,
    input: AdminUpdateUserStatusRequest,
  ): Promise<AdminUserDetail>;
  createPasswordReset(
    actorUserId: string,
    userId: string,
    input: AdminPasswordResetRequest,
  ): Promise<AdminPasswordResetResponse>;
  listPlatformAdmins(): Promise<AdminPlatformAdmin[]>;
  grantPlatformAdmin(
    actorUserId: string,
    userId: string,
    input: AdminPlatformAdminMutationRequest,
  ): Promise<void>;
  revokePlatformAdmin(
    actorUserId: string,
    userId: string,
    input: AdminPlatformAdminMutationRequest,
  ): Promise<void>;
  listJobs(input?: {
    limit?: number;
    status?: string;
    userId?: string;
  }): Promise<AdminJob[]>;
  listAgentRuns(input?: {
    limit?: number;
    status?: string;
    userId?: string;
  }): Promise<AdminAgentRun[]>;
  listTransactions(input?: { limit?: number; workspaceId?: string }): Promise<
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
  (pa.user_id is not null) as "isPlatformAdmin",
  u.status,
  u.status_reason as "statusReason",
  u.status_changed_at as "statusChangedAt"
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
  onUserAuthChanged?: (userId: string) => void;
}): PlatformAdminService {
  const getAdmin = options.getAdminClient;

  const service: PlatformAdminService = {
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
      const status = input.status?.trim() || null;
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
            and ($2::text is null or u.status = $2)
          order by u.created_at desc
          limit $3::int
        `,
        [search, status, limit],
      );
      return getMany(data, error, "Unable to load users.");
    },

    async getUserDetail(userId) {
      const { data, error } = await getAdmin().query<AdminUser>(
        `
          select ${USER_COLUMNS}
          from public.app_users u
          ${USER_JOINS}
          where u.id = $1::uuid
          limit 1
        `,
        [userId],
      );
      if (error) {
        throw new PlatformAdminServiceError(
          "admin_query_failed",
          "Unable to load user detail.",
          500,
        );
      }
      const user = data?.[0];
      if (!user) {
        throw new PlatformAdminServiceError(
          "admin_user_not_found",
          "User was not found.",
          404,
        );
      }

      const [recentTransactions, recentJobs, recentAgentRuns] =
        await Promise.all([
          user.workspaceId
            ? service.listTransactions({
                limit: 20,
                workspaceId: user.workspaceId,
              })
            : Promise.resolve([]),
          service.listJobs({ limit: 20, userId }),
          service.listAgentRuns({ limit: 20, userId }),
        ]);

      return { recentAgentRuns, recentJobs, recentTransactions, user };
    },

    async updateUser(actorUserId, userId, input) {
      const email = input.email?.trim().toLowerCase() ?? null;
      const displayName = input.displayName?.trim() ?? null;
      const { data, error } = await getAdmin().query<{ id: string }>(
        `
          with target as materialized (
            select
              u.id,
              u.email,
              coalesce(p.display_name, split_part(u.email, '@', 1)) as display_name
            from public.app_users u
            left join public.profiles p on p.id = u.id
            where u.id = $2::uuid
            for update of u
          ),
          updated_user as (
            update public.app_users u
            set email = coalesce($3::text, u.email),
                user_metadata = case
                  when $4::text is null then u.user_metadata
                  else jsonb_set(
                    coalesce(u.user_metadata, '{}'::jsonb),
                    '{display_name}',
                    to_jsonb($4::text),
                    true
                  )
                end,
                auth_version = case
                  when $3::text is not null and $3::text is distinct from u.email
                    then u.auth_version + 1
                  else u.auth_version
                end,
                updated_at = now()
            from target t
            where u.id = t.id
            returning u.id, u.email
          ),
          synced_profile as (
            insert into public.profiles (id, email, display_name)
            select
              u.id,
              u.email,
              coalesce($4::text, t.display_name)
            from updated_user u
            join target t on t.id = u.id
            on conflict (id) do update
            set email = excluded.email,
                display_name = excluded.display_name,
                updated_at = now()
            returning id, email, display_name
          ),
          audit as (
            insert into public.admin_audit_events (
              actor_user_id,
              action,
              target_user_id,
              metadata
            )
            select
              $1::uuid,
              'user.profile_updated',
              t.id,
              jsonb_build_object(
                'email_before', t.email,
                'email_after', p.email,
                'display_name_before', t.display_name,
                'display_name_after', p.display_name,
                'reason', $5::text
              )
            from target t
            join synced_profile p on p.id = t.id
          )
          select id from synced_profile
        `,
        [actorUserId, userId, email, displayName, input.reason],
      );
      if (error) {
        const duplicateEmail = error.code === "23505";
        throw new PlatformAdminServiceError(
          "admin_user_update_failed",
          duplicateEmail
            ? "This email address is already in use."
            : "Unable to update the user.",
          duplicateEmail ? 409 : 500,
        );
      }
      if (!data?.[0]) throw userNotFound();
      if (email) options.onUserAuthChanged?.(userId);
      return service.getUserDetail(userId);
    },

    async updateUserStatus(actorUserId, userId, input) {
      if (actorUserId === userId && input.status !== "active") {
        throw new PlatformAdminServiceError(
          "admin_user_status_update_failed",
          "You cannot suspend or disable your own account.",
          400,
        );
      }

      const { data, error } = await getAdmin().query<{ id: string }>(
        `
          with target as materialized (
            select id, status, status_reason
            from public.app_users
            where id = $2::uuid
            for update
          ),
          updated as (
            update public.app_users u
            set status = $3::text,
                status_reason = $4::text,
                status_changed_at = now(),
                status_changed_by = $1::uuid,
                auth_version = u.auth_version + 1,
                updated_at = now()
            from target t
            where u.id = t.id
            returning u.id, u.status, u.status_reason, u.auth_version
          ),
          audit as (
            insert into public.admin_audit_events (
              actor_user_id,
              action,
              target_user_id,
              metadata
            )
            select
              $1::uuid,
              'user.status_updated',
              t.id,
              jsonb_build_object(
                'status_before', t.status,
                'status_after', u.status,
                'reason_before', t.status_reason,
                'reason', u.status_reason,
                'auth_version_after', u.auth_version
              )
            from target t
            join updated u on u.id = t.id
          )
          select id from updated
        `,
        [actorUserId, userId, input.status, input.reason],
      );
      if (error) {
        throw new PlatformAdminServiceError(
          "admin_user_status_update_failed",
          "Unable to update the user status.",
          500,
        );
      }
      if (!data?.[0]) throw userNotFound();
      options.onUserAuthChanged?.(userId);
      return service.getUserDetail(userId);
    },

    async createPasswordReset(actorUserId, userId, input) {
      const resetToken = randomBytes(32).toString("base64url");
      const tokenHash = createHash("sha256").update(resetToken).digest("hex");
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      const { data, error } = await getAdmin().query<{ id: string }>(
        `
          with target as materialized (
            select id
            from public.app_users
            where id = $2::uuid
          ),
          revoked as (
            update public.admin_password_reset_tokens
            set revoked_at = now()
            where user_id = $2::uuid
              and used_at is null
              and revoked_at is null
          ),
          issued as (
            insert into public.admin_password_reset_tokens (
              user_id,
              token_hash,
              created_by,
              reason,
              expires_at
            )
            select id, $3::text, $1::uuid, $4::text, $5::timestamptz
            from target
            returning id, user_id
          ),
          audit as (
            insert into public.admin_audit_events (
              actor_user_id,
              action,
              target_user_id,
              metadata
            )
            select
              $1::uuid,
              'user.password_reset_issued',
              user_id,
              jsonb_build_object(
                'expires_at', $5::timestamptz,
                'reason', $4::text,
                'reset_token_id', id
              )
            from issued
          )
          select id from issued
        `,
        [actorUserId, userId, tokenHash, input.reason, expiresAt],
      );
      if (error) {
        throw new PlatformAdminServiceError(
          "admin_password_reset_failed",
          "Unable to create a password reset.",
          500,
        );
      }
      if (!data?.[0]) throw userNotFound();
      return { expiresAt, resetToken };
    },

    async listPlatformAdmins() {
      const { data, error } = await getAdmin().query<AdminPlatformAdmin>(`
        select
          pa.user_id as "userId",
          u.email,
          coalesce(p.display_name, split_part(u.email, '@', 1)) as "displayName",
          pa.created_at as "createdAt",
          creator.email as "createdByEmail",
          pa.note
        from public.platform_admins pa
        join public.app_users u on u.id = pa.user_id
        left join public.profiles p on p.id = pa.user_id
        left join public.app_users creator on creator.id = pa.created_by
        order by pa.created_at asc
      `);
      return getMany(data, error, "Unable to load platform administrators.");
    },

    async grantPlatformAdmin(actorUserId, userId, input) {
      const { data, error } = await getAdmin().query<{ userId: string }>(
        `
          with target as materialized (
            select id
            from public.app_users
            where id = $2::uuid
              and status = 'active'
          ),
          granted as (
            insert into public.platform_admins (user_id, created_by, note)
            select id, $1::uuid, $3::text
            from target
            on conflict (user_id) do update
            set note = excluded.note
            returning user_id
          ),
          audit as (
            insert into public.admin_audit_events (
              actor_user_id,
              action,
              target_user_id,
              metadata
            )
            select
              $1::uuid,
              'platform_admin.granted',
              user_id,
              jsonb_build_object('reason', $3::text)
            from granted
          )
          select user_id as "userId" from granted
        `,
        [actorUserId, userId, input.reason],
      );
      if (error) {
        throw new PlatformAdminServiceError(
          "admin_platform_admin_update_failed",
          "Unable to grant platform administrator access.",
          500,
        );
      }
      if (!data?.[0]) {
        throw new PlatformAdminServiceError(
          "admin_platform_admin_update_failed",
          "Only an active user can become a platform administrator.",
          400,
        );
      }
    },

    async revokePlatformAdmin(actorUserId, userId, input) {
      if (actorUserId === userId) {
        throw new PlatformAdminServiceError(
          "admin_platform_admin_update_failed",
          "You cannot revoke your own platform administrator access.",
          400,
        );
      }

      const { data, error } = await getAdmin().query<{ userId: string }>(
        `
          with guard as materialized (
            select pg_advisory_xact_lock(
              hashtext('loomic_platform_admin_membership')
            )
          ),
          admin_count as materialized (
            select count(*)::int as value
            from public.platform_admins, guard
          ),
          revoked as (
            delete from public.platform_admins
            where user_id = $2::uuid
              and (select value from admin_count) > 1
            returning user_id
          ),
          audit as (
            insert into public.admin_audit_events (
              actor_user_id,
              action,
              target_user_id,
              metadata
            )
            select
              $1::uuid,
              'platform_admin.revoked',
              user_id,
              jsonb_build_object('reason', $3::text)
            from revoked
          )
          select user_id as "userId" from revoked
        `,
        [actorUserId, userId, input.reason],
      );
      if (error) {
        throw new PlatformAdminServiceError(
          "admin_platform_admin_update_failed",
          "Unable to revoke platform administrator access.",
          500,
        );
      }
      if (!data?.[0]) {
        throw new PlatformAdminServiceError(
          "admin_platform_admin_update_failed",
          "The administrator was not found or is the last platform administrator.",
          400,
        );
      }
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
            and ($2::uuid is null or j.created_by = $2)
          order by j.created_at desc
          limit $3::int
        `,
        [input.status?.trim() || null, input.userId ?? null, limit],
      );
      return getMany(data, error, "Unable to load jobs.");
    },

    async listAgentRuns(input = {}) {
      const limit = clampLimit(input.limit, 50);
      const { data, error } = await getAdmin().query<AdminAgentRun>(
        `
          select
            ar.id,
            ar.session_id as "sessionId",
            cs.title as "sessionTitle",
            ar.thread_id as "threadId",
            ar.status,
            ar.model,
            ar.created_at as "createdAt",
            ar.completed_at as "completedAt",
            ar.error_code as "errorCode",
            ar.error_message as "errorMessage",
            w.name as "workspaceName",
            pr.name as "projectName",
            c.name as "canvasName",
            u.email as "userEmail",
            p.display_name as "userDisplayName"
          from public.agent_runs ar
          join public.chat_sessions cs on cs.id = ar.session_id
          left join public.canvases c on c.id = cs.canvas_id
          left join public.projects pr on pr.id = c.project_id
          left join public.workspaces w on w.id = pr.workspace_id
          left join public.app_users u on u.id = cs.created_by
          left join public.profiles p on p.id = cs.created_by
          where ($1::text is null or ar.status = $1)
            and ($2::uuid is null or cs.created_by = $2)
          order by ar.created_at desc
          limit $3::int
        `,
        [input.status?.trim() || null, input.userId ?? null, limit],
      );
      return getMany(data, error, "Unable to load agent runs.");
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
          where ($1::uuid is null or t.workspace_id = $1)
          order by t.created_at desc
          limit $2::int
        `,
        [
          "workspaceId" in input ? (input.workspaceId ?? null) : null,
          clampLimit(input.limit, 50),
        ],
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

  return service;
}

function clampLimit(value: number | undefined, fallback: number) {
  return Math.min(Math.max(value ?? fallback, 1), 100);
}

function userNotFound() {
  return new PlatformAdminServiceError(
    "admin_user_not_found",
    "User was not found.",
    404,
  );
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
