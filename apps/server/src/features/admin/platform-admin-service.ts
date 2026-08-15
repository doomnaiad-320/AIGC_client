import { createHash, randomBytes } from "node:crypto";

import type {
  AdminAgentRun,
  AdminAuditEvent,
  AdminBillingOverview,
  AdminBillingPlan,
  AdminBillingPlanMutation,
  AdminCreditAdjustmentRequest,
  AdminCreditAdjustmentResponse,
  AdminCreditTransaction,
  AdminJob,
  AdminOverview,
  AdminPasswordResetRequest,
  AdminPasswordResetResponse,
  AdminPaymentProviderConfig,
  AdminPlatformAdmin,
  AdminPlatformAdminMutationRequest,
  AdminSaveTopUpPackDraft,
  AdminTopUpPack,
  AdminUpdateBillingPlanDraft,
  AdminUpdatePaymentProviderConfig,
  AdminUpdateUserRequest,
  AdminUpdateUserStatusRequest,
  AdminUser,
  AdminUserDetail,
  AdminWorkspace,
  AdminWorkspaceDetail,
  AdminWorkspaceMember,
  AdminWorkspaceMembership,
  AdminWorkspaceProject,
} from "@loomic/shared";

import type { AdminDbClient } from "../../db/client.js";
import type { BillingCatalogService } from "../billing/billing-catalog-service.js";
import { createDuluPayClient } from "../payments/dulupay-client.js";
import type { PaymentCredentialCrypto } from "../payments/payment-credential-crypto.js";

export class PlatformAdminServiceError extends Error {
  constructor(
    readonly code:
      | "platform_admin_required"
      | "admin_user_not_found"
      | "admin_workspace_not_found"
      | "admin_query_failed"
      | "admin_user_update_failed"
      | "admin_user_plan_update_failed"
      | "admin_subscription_managed_externally"
      | "admin_user_status_update_failed"
      | "admin_password_reset_failed"
      | "admin_platform_admin_update_failed"
      | "admin_billing_plan_not_found"
      | "admin_billing_plan_draft_not_found"
      | "admin_billing_plan_draft_exists"
      | "admin_billing_plan_update_failed"
      | "admin_billing_plan_publish_failed"
      | "admin_top_up_pack_update_failed"
      | "admin_top_up_pack_publish_failed"
      | "admin_payment_provider_update_failed"
      | "admin_payment_provider_test_failed"
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
  listUserWorkspaces(userId: string): Promise<AdminWorkspaceMembership[]>;
  listWorkspaces(input?: {
    limit?: number;
    search?: string;
    type?: string;
  }): Promise<AdminWorkspace[]>;
  getWorkspaceDetail(workspaceId: string): Promise<AdminWorkspaceDetail>;
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
  listBillingPlans(): Promise<AdminBillingPlan[]>;
  getBillingOverview(): Promise<AdminBillingOverview>;
  updateBillingPlanDraft(
    actorUserId: string,
    planCode: string,
    input: AdminUpdateBillingPlanDraft,
  ): Promise<AdminBillingPlan[]>;
  createBillingPlanDraft(
    actorUserId: string,
    planCode: string,
    input: AdminBillingPlanMutation,
  ): Promise<AdminBillingPlan[]>;
  publishBillingPlan(
    actorUserId: string,
    planCode: string,
    input: AdminBillingPlanMutation,
  ): Promise<AdminBillingPlan[]>;
  listTopUpPacks(): Promise<AdminTopUpPack[]>;
  saveTopUpPackDraft(
    actorUserId: string,
    input: AdminSaveTopUpPackDraft,
  ): Promise<AdminTopUpPack[]>;
  publishTopUpPack(
    actorUserId: string,
    code: string,
    input: AdminBillingPlanMutation,
  ): Promise<AdminTopUpPack[]>;
  getPaymentProviderConfig(): Promise<AdminPaymentProviderConfig>;
  updatePaymentProviderConfig(
    actorUserId: string,
    input: AdminUpdatePaymentProviderConfig,
  ): Promise<AdminPaymentProviderConfig>;
  testPaymentProvider(): Promise<{ merchantStatus: number; payStatus: number }>;
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

const WORKSPACE_COLUMNS = `
  w.id,
  w.name,
  w.type::text as type,
  w.created_at as "createdAt",
  w.owner_user_id as "ownerUserId",
  owner.email as "ownerEmail",
  coalesce(owner_profile.display_name, split_part(owner.email, '@', 1)) as "ownerDisplayName",
  coalesce(member_stats.member_count, 0)::int as "memberCount",
  coalesce(project_stats.project_count, 0)::int as "projectCount",
  coalesce(s.plan::text, 'free') as plan,
  coalesce(cb.balance, 0)::int as balance
`;

const WORKSPACE_JOINS = `
  join public.app_users owner on owner.id = w.owner_user_id
  left join public.profiles owner_profile on owner_profile.id = owner.id
  left join public.subscriptions s on s.workspace_id = w.id
  left join public.credit_balances cb on cb.workspace_id = w.id
  left join lateral (
    select count(*)::int as member_count
    from public.workspace_members wm
    where wm.workspace_id = w.id
  ) member_stats on true
  left join lateral (
    select count(*)::int as project_count
    from public.projects p
    where p.workspace_id = w.id
  ) project_stats on true
`;

export function createPlatformAdminService(options: {
  getAdminClient: () => AdminDbClient;
  billingCatalogService: BillingCatalogService;
  credentialCrypto: PaymentCredentialCrypto;
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

      const [workspaces, recentTransactions, recentJobs, recentAgentRuns] =
        await Promise.all([
          service.listUserWorkspaces(userId),
          user.workspaceId
            ? service.listTransactions({
                limit: 20,
                workspaceId: user.workspaceId,
              })
            : Promise.resolve([]),
          service.listJobs({ limit: 20, userId }),
          service.listAgentRuns({ limit: 20, userId }),
        ]);

      return {
        recentAgentRuns,
        recentJobs,
        recentTransactions,
        user,
        workspaces,
      };
    },

    async listUserWorkspaces(userId) {
      const { data, error } = await getAdmin().query<AdminWorkspaceMembership>(
        `
          select
            w.id as "workspaceId",
            w.name as "workspaceName",
            w.type::text as "workspaceType",
            wm.role::text as role,
            wm.created_at as "joinedAt",
            coalesce(s.plan::text, 'free') as plan,
            coalesce(cb.balance, 0)::int as balance,
            (w.owner_user_id = wm.user_id) as "isOwner"
          from public.workspace_members wm
          join public.workspaces w on w.id = wm.workspace_id
          left join public.subscriptions s on s.workspace_id = w.id
          left join public.credit_balances cb on cb.workspace_id = w.id
          where wm.user_id = $1::uuid
          order by w.created_at asc, w.id asc
        `,
        [userId],
      );
      return getMany(data, error, "Unable to load user workspaces.");
    },

    async listWorkspaces(input = {}) {
      const search = input.search?.trim() || null;
      const type = input.type?.trim() || null;
      const limit = clampLimit(input.limit, 50);
      const { data, error } = await getAdmin().query<AdminWorkspace>(
        `
          select ${WORKSPACE_COLUMNS}
          from public.workspaces w
          ${WORKSPACE_JOINS}
          where (
            $1::text is null
            or w.name ilike '%' || $1 || '%'
            or owner.email ilike '%' || $1 || '%'
            or coalesce(owner_profile.display_name, '') ilike '%' || $1 || '%'
          )
            and ($2::text is null or w.type::text = $2)
          order by w.created_at desc, w.id asc
          limit $3::int
        `,
        [search, type, limit],
      );
      return getMany(data, error, "Unable to load workspaces.");
    },

    async getWorkspaceDetail(workspaceId) {
      const { data, error } = await getAdmin().query<AdminWorkspace>(
        `
          select ${WORKSPACE_COLUMNS}
          from public.workspaces w
          ${WORKSPACE_JOINS}
          where w.id = $1::uuid
          limit 1
        `,
        [workspaceId],
      );
      if (error) {
        throw new PlatformAdminServiceError(
          "admin_query_failed",
          "Unable to load workspace detail.",
          500,
        );
      }
      const workspace = data?.[0];
      if (!workspace) {
        throw new PlatformAdminServiceError(
          "admin_workspace_not_found",
          "Workspace was not found.",
          404,
        );
      }

      const [membersResult, projectsResult] = await Promise.all([
        getAdmin().query<AdminWorkspaceMember>(
          `
            select
              wm.user_id as "userId",
              u.email,
              coalesce(p.display_name, split_part(u.email, '@', 1)) as "displayName",
              wm.role::text as role,
              wm.created_at as "joinedAt",
              u.status
            from public.workspace_members wm
            join public.app_users u on u.id = wm.user_id
            left join public.profiles p on p.id = wm.user_id
            where wm.workspace_id = $1::uuid
            order by
              case wm.role when 'owner' then 0 when 'admin' then 1 else 2 end,
              wm.created_at asc,
              wm.user_id asc
          `,
          [workspaceId],
        ),
        getAdmin().query<AdminWorkspaceProject>(
          `
            select
              p.id,
              p.name,
              p.slug,
              p.created_at as "createdAt",
              coalesce(canvas_stats.canvas_count, 0)::int as "canvasCount"
            from public.projects p
            left join lateral (
              select count(*)::int as canvas_count
              from public.canvases c
              where c.project_id = p.id
            ) canvas_stats on true
            where p.workspace_id = $1::uuid
            order by p.created_at desc, p.id asc
            limit 100
          `,
          [workspaceId],
        ),
      ]);

      const members = getMany(
        membersResult.data,
        membersResult.error,
        "Unable to load workspace members.",
      );
      const projects = getMany(
        projectsResult.data,
        projectsResult.error,
        "Unable to load workspace projects.",
      );
      return { members, projects, workspace };
    },

    async updateUser(actorUserId, userId, input) {
      const email = input.email?.trim().toLowerCase() ?? null;
      const displayName = input.displayName?.trim() ?? null;
      const plan = input.plan ?? null;
      const { data, error } = await getAdmin().query<{
        activeSubscriptionId: string | null;
        id: string;
        planBlocked: boolean;
        workspaceId: string | null;
      }>(
        `
          with target as materialized (
            select
              u.id,
              u.email,
              coalesce(p.display_name, split_part(u.email, '@', 1)) as display_name,
              w.id as workspace_id,
              coalesce(s.plan::text, 'free') as plan_before,
              s.lemon_squeezy_subscription_id as active_subscription_id,
              (
                $5::public.subscription_plan is not null
                and $5::text is distinct from coalesce(s.plan::text, 'free')
                and (
                  w.id is null
                  or s.lemon_squeezy_subscription_id is not null
                )
              ) as plan_blocked
            from public.app_users u
            left join public.profiles p on p.id = u.id
            left join lateral (
              select id
              from public.workspaces
              where owner_user_id = u.id
              order by created_at asc, id asc
              limit 1
            ) w on true
            left join public.subscriptions s on s.workspace_id = w.id
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
              and not t.plan_blocked
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
          updated_subscription as (
            insert into public.subscriptions (workspace_id, plan, updated_at)
            select t.workspace_id, $5::public.subscription_plan, now()
            from target t
            where t.workspace_id is not null
              and not t.plan_blocked
              and $5::public.subscription_plan is not null
              and $5::text is distinct from t.plan_before
            on conflict (workspace_id) do update
            set plan = excluded.plan,
                billing_period = null,
                current_period_start = null,
                current_period_end = null,
                canceled_at = null,
                updated_at = now()
            returning workspace_id, plan::text
          ),
          profile_audit as (
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
                'reason', $6::text
              )
            from target t
            join synced_profile p on p.id = t.id
            where t.email is distinct from p.email
               or t.display_name is distinct from p.display_name
          ),
          plan_audit as (
            insert into public.admin_audit_events (
              actor_user_id,
              action,
              target_user_id,
              target_workspace_id,
              metadata
            )
            select
              $1::uuid,
              'subscription.plan_changed',
              t.id,
              u.workspace_id,
              jsonb_build_object(
                'plan_before', t.plan_before,
                'plan_after', u.plan,
                'reason', $6::text,
                'credits_changed', false
              )
            from target t
            join updated_subscription u on u.workspace_id = t.workspace_id
          )
          select
            t.id,
            t.workspace_id as "workspaceId",
            t.active_subscription_id as "activeSubscriptionId",
            t.plan_blocked as "planBlocked"
          from target t
          left join synced_profile p on p.id = t.id
        `,
        [actorUserId, userId, email, displayName, plan, input.reason],
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
      const result = data?.[0];
      if (!result) throw userNotFound();
      if (result.planBlocked) {
        if (result.activeSubscriptionId) {
          throw new PlatformAdminServiceError(
            "admin_subscription_managed_externally",
            "This plan is managed by an active external subscription.",
            409,
          );
        }
        throw new PlatformAdminServiceError(
          "admin_user_plan_update_failed",
          "The user does not own a workspace.",
          400,
        );
      }
      if (plan && result.workspaceId) {
        const { error: billingSyncError } = await getAdmin().rpc(
          "sync_workspace_billing_plan_from_legacy",
          {
            p_workspace_id: result.workspaceId,
            p_legacy_plan: plan,
            p_actor_user_id: actorUserId,
            p_reason: input.reason,
          },
        );
        if (billingSyncError) {
          throw new PlatformAdminServiceError(
            "admin_user_plan_update_failed",
            "Unable to synchronize the versioned billing plan.",
            500,
          );
        }
      }
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
        p_idempotency_key: input.idempotencyKey,
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

    async listBillingPlans() {
      try {
        return await options.billingCatalogService.listAdminPlans();
      } catch {
        throw new PlatformAdminServiceError(
          "admin_query_failed",
          "Unable to load billing plans.",
          500,
        );
      }
    },

    async getBillingOverview() {
      try {
        return await options.billingCatalogService.getAdminOverview();
      } catch {
        throw new PlatformAdminServiceError(
          "admin_query_failed",
          "Unable to load billing overview.",
          500,
        );
      }
    },

    async updateBillingPlanDraft(actorUserId, planCode, input) {
      const entitlements = {
        "api.enabled": input.entitlements.apiEnabled,
        "brand_kits.max_count": input.entitlements.maxBrandKits,
        "generation.allowed_model_groups":
          input.entitlements.allowedModelGroups,
        "generation.max_concurrent_jobs": input.entitlements.maxConcurrentJobs,
        "generation.watermark": input.entitlements.watermark,
        "image.max_quality": input.entitlements.maxImageQuality,
        "projects.max_count": input.entitlements.maxProjects,
        "queue.priority": input.entitlements.queuePriority,
        "team.max_seats": input.entitlements.maxTeamSeats,
        "video.max_resolution": input.entitlements.maxVideoResolution,
      };
      const { error } = await getAdmin().rpc("admin_save_billing_plan_draft", {
        p_actor_user_id: actorUserId,
        p_plan_code: planCode,
        p_currency: input.currency,
        p_monthly_price_minor: input.monthlyPriceMinor,
        p_annual_price_minor: input.annualPriceMinor,
        p_monthly_subscription_credits: input.monthlySubscriptionCredits,
        p_daily_credits: input.dailyCredits,
        p_top_up_eligible: input.topUpEligible,
        p_entitlements: entitlements,
        p_reason: input.reason,
      });
      if (error) {
        throw mapBillingError(error.message, "update");
      }
      return service.listBillingPlans();
    },

    async createBillingPlanDraft(actorUserId, planCode, input) {
      const { error } = await getAdmin().rpc(
        "admin_create_billing_plan_draft",
        {
          p_actor_user_id: actorUserId,
          p_plan_code: planCode,
          p_reason: input.reason,
        },
      );
      if (error) {
        throw mapBillingError(error.message, "create");
      }
      return service.listBillingPlans();
    },

    async publishBillingPlan(actorUserId, planCode, input) {
      const { error } = await getAdmin().rpc("admin_publish_billing_plan", {
        p_actor_user_id: actorUserId,
        p_plan_code: planCode,
        p_reason: input.reason,
      });
      if (error) {
        throw mapBillingError(error.message, "publish");
      }
      return service.listBillingPlans();
    },

    async listTopUpPacks() {
      const { data, error } = await getAdmin().query<{
        code: string;
        createdAt: string;
        credits: number;
        descriptionZh: string;
        id: string;
        minimumPlanCode: "pro" | "team";
        nameZh: string;
        priceMinor: number;
        providerAmountMinor: number | null;
        providerCurrency: "CNY" | null;
        publishedAt: string | null;
        retiredAt: string | null;
        sortOrder: number;
        status: "draft" | "published" | "retired";
        version: number;
      }>(
        `select
           pack.id,
           pack.code,
           pack.version,
           pack.name_zh as "nameZh",
           pack.description_zh as "descriptionZh",
           pack.credits,
           pack.price_minor as "priceMinor",
           pack.status,
           pack.minimum_plan_code as "minimumPlanCode",
           pack.sort_order as "sortOrder",
           pack.published_at as "publishedAt",
           pack.retired_at as "retiredAt",
           pack.created_at as "createdAt",
           price.currency as "providerCurrency",
           price.amount_minor as "providerAmountMinor"
         from public.billing_top_up_packs pack
         left join public.billing_top_up_pack_provider_prices price
           on price.top_up_pack_id = pack.id
          and price.provider_code = 'dulupay'
         order by pack.sort_order, pack.code, pack.version desc`,
      );
      if (error) {
        throw new PlatformAdminServiceError(
          "admin_query_failed",
          "Unable to load top-up packs.",
          500,
        );
      }

      const grouped = new Map<string, AdminTopUpPack>();
      for (const row of data ?? []) {
        const version = {
          id: row.id,
          code: row.code,
          version: Number(row.version),
          nameZh: row.nameZh,
          descriptionZh: row.descriptionZh,
          credits: Number(row.credits),
          currency: "USD" as const,
          priceMinor: Number(row.priceMinor),
          status: row.status,
          minimumPlanCode: row.minimumPlanCode,
          sortOrder: Number(row.sortOrder),
          providerPrice:
            row.providerCurrency === "CNY" && row.providerAmountMinor
              ? {
                  providerCode: "dulupay" as const,
                  currency: "CNY" as const,
                  amountMinor: Number(row.providerAmountMinor),
                }
              : null,
          publishedAt: row.publishedAt,
          retiredAt: row.retiredAt,
          createdAt: row.createdAt,
        };
        const current = grouped.get(row.code) ?? {
          code: row.code,
          draft: null,
          published: null,
          retiredVersions: [],
        };
        if (row.status === "draft") current.draft = version;
        else if (row.status === "published") current.published = version;
        else current.retiredVersions.push(version);
        grouped.set(row.code, current);
      }
      return [...grouped.values()];
    },

    async saveTopUpPackDraft(actorUserId, input) {
      const { error } = await getAdmin().query(
        `select public.admin_save_top_up_pack_draft(
           $1::uuid, $2::text, $3::text, $4::text, $5::integer,
           $6::integer, $7::text, $8::integer, $9::integer, $10::text
         )`,
        [
          actorUserId,
          input.code,
          input.nameZh,
          input.descriptionZh,
          input.credits,
          input.priceMinor,
          input.minimumPlanCode,
          input.sortOrder,
          input.dulupayAmountMinor,
          input.reason,
        ],
      );
      if (error) {
        throw new PlatformAdminServiceError(
          "admin_top_up_pack_update_failed",
          "Unable to save the top-up pack draft.",
          400,
        );
      }
      return service.listTopUpPacks();
    },

    async publishTopUpPack(actorUserId, code, input) {
      const { error } = await getAdmin().query(
        "select public.admin_publish_top_up_pack($1::uuid, $2::text, $3::text)",
        [actorUserId, code, input.reason],
      );
      if (error) {
        throw new PlatformAdminServiceError(
          "admin_top_up_pack_publish_failed",
          "Unable to publish the top-up pack.",
          400,
        );
      }
      return service.listTopUpPacks();
    },

    async getPaymentProviderConfig() {
      const { data, error } = await getAdmin().query<{
        allowedMethods: Array<"alipay" | "wxpay">;
        apiBaseUrl: string;
        callbackToleranceSeconds: number;
        displayName: string;
        enabled: boolean;
        hasMerchantPrivateKey: boolean;
        merchantId: string | null;
        platformPublicKey: string | null;
        providerCode: "dulupay";
        updatedAt: string;
      }>(
        `select
           provider_code as "providerCode",
           display_name as "displayName",
           enabled,
           api_base_url as "apiBaseUrl",
           merchant_id as "merchantId",
           merchant_private_key_ciphertext is not null as "hasMerchantPrivateKey",
           platform_public_key as "platformPublicKey",
           allowed_methods as "allowedMethods",
           callback_tolerance_seconds as "callbackToleranceSeconds",
           updated_at as "updatedAt"
         from public.payment_provider_configs
         where provider_code = 'dulupay'
         limit 1`,
      );
      if (error || !data?.[0]) {
        throw new PlatformAdminServiceError(
          "admin_query_failed",
          "Unable to load payment provider configuration.",
          500,
        );
      }
      return {
        ...data[0],
        encryptionReady: options.credentialCrypto.ready,
      };
    },

    async updatePaymentProviderConfig(actorUserId, input) {
      if (input.merchantPrivateKey && !options.credentialCrypto.ready) {
        throw new PlatformAdminServiceError(
          "admin_payment_provider_update_failed",
          "PAYMENT_CONFIG_ENCRYPTION_KEY is required before saving credentials.",
          503,
        );
      }
      let encryptedPrivateKey: string | null = null;
      if (input.merchantPrivateKey) {
        try {
          createDuluPayClient({
            apiBaseUrl: input.apiBaseUrl,
            merchantId: input.merchantId,
            merchantPrivateKey: input.merchantPrivateKey,
            platformPublicKey: input.platformPublicKey,
          });
          encryptedPrivateKey = options.credentialCrypto.encrypt(
            input.merchantPrivateKey,
          );
        } catch {
          throw new PlatformAdminServiceError(
            "admin_payment_provider_update_failed",
            "The DuluPay URL or RSA keys are invalid.",
            400,
          );
        }
      }

      const { error } = await getAdmin().query(
        `select public.admin_save_payment_provider_config(
           $1::uuid, $2::boolean, $3::text, $4::text, $5::text,
           $6::boolean, $7::text, $8::text[], $9::integer, $10::text
         )`,
        [
          actorUserId,
          input.enabled,
          input.apiBaseUrl,
          input.merchantId,
          encryptedPrivateKey,
          Boolean(input.merchantPrivateKey),
          input.platformPublicKey,
          input.allowedMethods,
          input.callbackToleranceSeconds,
          input.reason,
        ],
      );
      if (error) {
        throw new PlatformAdminServiceError(
          "admin_payment_provider_update_failed",
          "Unable to save the payment provider configuration.",
          400,
        );
      }
      return service.getPaymentProviderConfig();
    },

    async testPaymentProvider() {
      const config = await service.getPaymentProviderConfig();
      const { data, error } = await getAdmin().query<{
        merchantPrivateKeyCiphertext: string | null;
      }>(
        `select merchant_private_key_ciphertext as "merchantPrivateKeyCiphertext"
         from public.payment_provider_configs
         where provider_code = 'dulupay'`,
      );
      const ciphertext = data?.[0]?.merchantPrivateKeyCiphertext;
      if (
        error ||
        !ciphertext ||
        !config.merchantId ||
        !config.platformPublicKey ||
        !options.credentialCrypto.ready
      ) {
        throw new PlatformAdminServiceError(
          "admin_payment_provider_test_failed",
          "DuluPay credentials are incomplete.",
          400,
        );
      }
      try {
        const client = createDuluPayClient({
          apiBaseUrl: config.apiBaseUrl,
          merchantId: config.merchantId,
          merchantPrivateKey: options.credentialCrypto.decrypt(ciphertext),
          platformPublicKey: config.platformPublicKey,
        });
        const result = await client.getMerchantInfo();
        return {
          merchantStatus: Number(result.status ?? 0),
          payStatus: Number(result.pay_status ?? 0),
        };
      } catch {
        throw new PlatformAdminServiceError(
          "admin_payment_provider_test_failed",
          "DuluPay connection test failed.",
          502,
        );
      }
    },
  };

  return service;
}

function mapBillingError(
  message: string,
  operation: "create" | "publish" | "update",
) {
  if (message.includes("BILLING_PLAN_NOT_FOUND")) {
    return new PlatformAdminServiceError(
      "admin_billing_plan_not_found",
      "Billing plan was not found.",
      404,
    );
  }
  if (message.includes("BILLING_PLAN_DRAFT_EXISTS")) {
    return new PlatformAdminServiceError(
      "admin_billing_plan_draft_exists",
      "A draft already exists for this billing plan.",
      409,
    );
  }
  if (message.includes("BILLING_PLAN_DRAFT_NOT_FOUND")) {
    return new PlatformAdminServiceError(
      "admin_billing_plan_draft_not_found",
      "No draft exists for this billing plan.",
      404,
    );
  }
  return new PlatformAdminServiceError(
    operation === "publish"
      ? "admin_billing_plan_publish_failed"
      : "admin_billing_plan_update_failed",
    operation === "publish"
      ? "Unable to publish billing plan."
      : "Unable to update billing plan draft.",
    500,
  );
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
