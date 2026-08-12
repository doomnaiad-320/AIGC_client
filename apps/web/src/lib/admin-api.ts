import type {
  AdminAgentRun,
  AdminAuditEvent,
  AdminBillingPlan,
  AdminBillingPlanMutation,
  AdminCreditAdjustmentRequest,
  AdminCreditAdjustmentResponse,
  AdminCreditTransaction,
  AdminJob,
  AdminOverview,
  AdminPasswordResetRequest,
  AdminPasswordResetResponse,
  AdminPlatformAdmin,
  AdminPlatformAdminMutationRequest,
  AdminUpdateBillingPlanDraft,
  AdminUpdateUserRequest,
  AdminUpdateUserStatusRequest,
  AdminUser,
  AdminUserDetail,
  AdminWorkspace,
  AdminWorkspaceDetail,
} from "@loomic/shared";

import { getServerBaseUrl } from "./env";
import { ApiApplicationError, ApiAuthError } from "./server-api";

const ADMIN_ERROR_MESSAGES: Record<string, string> = {
  unauthorized: "登录状态已失效，请重新登录。",
  platform_admin_required: "当前账号没有平台管理员权限。",
  admin_user_not_found: "未找到该用户。",
  admin_workspace_not_found: "未找到该工作区。",
  admin_query_failed: "无法查询管理后台数据。",
  admin_user_update_failed: "无法更新用户资料。",
  admin_user_plan_update_failed: "无法更新用户套餐。",
  admin_subscription_managed_externally:
    "该用户存在有效的在线订阅，请通过支付平台变更套餐。",
  admin_user_status_update_failed: "无法更新用户状态。",
  admin_password_reset_failed: "无法生成密码重置令牌。",
  admin_platform_admin_update_failed: "无法更新平台管理员权限。",
  credit_adjustment_failed: "无法增加点数，请检查增加数量。",
  admin_billing_plan_not_found: "未找到该套餐。",
  admin_billing_plan_draft_not_found: "该套餐没有可发布的草稿。",
  admin_billing_plan_draft_exists: "该套餐已经存在草稿，请直接编辑。",
  admin_billing_plan_update_failed: "无法保存套餐草稿。",
  admin_billing_plan_publish_failed: "无法发布套餐版本。",
  admin_request_failed: "管理后台请求失败，请稍后重试。",
};

function authHeaders(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

function jsonHeaders(accessToken: string) {
  return { ...authHeaders(accessToken), "content-type": "application/json" };
}

async function handleError(response: Response): Promise<never> {
  if (response.status === 401) {
    throw new ApiAuthError(ADMIN_ERROR_MESSAGES.unauthorized);
  }
  const payload = await response.json().catch(() => null);
  const code = payload?.error?.code ?? "admin_request_failed";
  throw new ApiApplicationError(
    code,
    ADMIN_ERROR_MESSAGES[code] ?? "管理后台请求失败，请稍后重试。",
  );
}

async function get<T>(accessToken: string, path: string): Promise<T> {
  const response = await fetch(`${getServerBaseUrl()}${path}`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleError(response);
  return (await response.json()) as T;
}

export function fetchAdminMe(accessToken: string) {
  return get<{ isPlatformAdmin: boolean }>(accessToken, "/api/admin/me");
}

export function fetchAdminOverview(accessToken: string) {
  return get<{ overview: AdminOverview }>(accessToken, "/api/admin/overview");
}

export function fetchAdminUsers(accessToken: string, search = "", status = "") {
  const query = new URLSearchParams({ limit: "100" });
  if (search.trim()) query.set("search", search.trim());
  if (status.trim()) query.set("status", status.trim());
  return get<{ users: AdminUser[] }>(accessToken, `/api/admin/users?${query}`);
}

export function fetchAdminUserDetail(accessToken: string, userId: string) {
  return get<{ detail: AdminUserDetail }>(
    accessToken,
    `/api/admin/users/${userId}`,
  );
}

export function fetchAdminWorkspaces(accessToken: string) {
  return get<{ workspaces: AdminWorkspace[] }>(
    accessToken,
    "/api/admin/workspaces?limit=100",
  );
}

export function fetchAdminWorkspaceDetail(
  accessToken: string,
  workspaceId: string,
) {
  return get<{ detail: AdminWorkspaceDetail }>(
    accessToken,
    `/api/admin/workspaces/${workspaceId}`,
  );
}

export function fetchAdminJobs(accessToken: string) {
  return get<{ jobs: AdminJob[] }>(accessToken, "/api/admin/jobs?limit=100");
}

export function fetchAdminAgentRuns(accessToken: string) {
  return get<{ runs: AdminAgentRun[] }>(
    accessToken,
    "/api/admin/agent-runs?limit=100",
  );
}

export function fetchAdminTransactions(accessToken: string) {
  return get<{ transactions: AdminCreditTransaction[] }>(
    accessToken,
    "/api/admin/credit-transactions?limit=100",
  );
}

export function fetchAdminAuditEvents(accessToken: string) {
  return get<{ events: AdminAuditEvent[] }>(
    accessToken,
    "/api/admin/audit-events?limit=100",
  );
}

export function fetchAdminBillingPlans(accessToken: string) {
  return get<{ plans: AdminBillingPlan[] }>(
    accessToken,
    "/api/admin/billing/plans",
  );
}

async function mutate<T>(
  accessToken: string,
  path: string,
  method: "PATCH" | "POST" | "PUT" | "DELETE",
  body: unknown,
) {
  const response = await fetch(`${getServerBaseUrl()}${path}`, {
    method,
    headers: jsonHeaders(accessToken),
    body: JSON.stringify(body),
  });
  if (!response.ok) return handleError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function updateAdminUser(
  accessToken: string,
  userId: string,
  input: AdminUpdateUserRequest,
) {
  return mutate<{ detail: AdminUserDetail }>(
    accessToken,
    `/api/admin/users/${userId}`,
    "PATCH",
    input,
  );
}

export function updateAdminUserStatus(
  accessToken: string,
  userId: string,
  input: AdminUpdateUserStatusRequest,
) {
  return mutate<{ detail: AdminUserDetail }>(
    accessToken,
    `/api/admin/users/${userId}/status`,
    "PATCH",
    input,
  );
}

export function issueAdminPasswordReset(
  accessToken: string,
  userId: string,
  input: AdminPasswordResetRequest,
) {
  return mutate<AdminPasswordResetResponse>(
    accessToken,
    `/api/admin/users/${userId}/password-reset`,
    "POST",
    input,
  );
}

export function fetchPlatformAdmins(accessToken: string) {
  return get<{ administrators: AdminPlatformAdmin[] }>(
    accessToken,
    "/api/admin/platform-admins",
  );
}

export function grantPlatformAdmin(
  accessToken: string,
  userId: string,
  input: AdminPlatformAdminMutationRequest,
) {
  return mutate<void>(
    accessToken,
    `/api/admin/platform-admins/${userId}`,
    "PUT",
    input,
  );
}

export function revokePlatformAdmin(
  accessToken: string,
  userId: string,
  input: AdminPlatformAdminMutationRequest,
) {
  return mutate<void>(
    accessToken,
    `/api/admin/platform-admins/${userId}`,
    "DELETE",
    input,
  );
}

export async function adjustAdminCredits(
  accessToken: string,
  input: AdminCreditAdjustmentRequest,
) {
  const response = await fetch(
    `${getServerBaseUrl()}/api/admin/credit-adjustments`,
    {
      method: "POST",
      headers: jsonHeaders(accessToken),
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) return handleError(response);
  return (await response.json()) as AdminCreditAdjustmentResponse;
}

export function updateAdminBillingPlanDraft(
  accessToken: string,
  planCode: string,
  input: AdminUpdateBillingPlanDraft,
) {
  return mutate<{ plans: AdminBillingPlan[] }>(
    accessToken,
    `/api/admin/billing/plans/${planCode}/draft`,
    "PATCH",
    input,
  );
}

export function createAdminBillingPlanDraft(
  accessToken: string,
  planCode: string,
  input: AdminBillingPlanMutation,
) {
  return mutate<{ plans: AdminBillingPlan[] }>(
    accessToken,
    `/api/admin/billing/plans/${planCode}/draft`,
    "POST",
    input,
  );
}

export function publishAdminBillingPlan(
  accessToken: string,
  planCode: string,
  input: AdminBillingPlanMutation,
) {
  return mutate<{ plans: AdminBillingPlan[] }>(
    accessToken,
    `/api/admin/billing/plans/${planCode}/publish`,
    "POST",
    input,
  );
}
