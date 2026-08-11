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
  AdminWorkspace,
  AdminWorkspaceDetail,
} from "@loomic/shared";

import { getServerBaseUrl } from "./env";
import { ApiApplicationError, ApiAuthError } from "./server-api";

function authHeaders(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

function jsonHeaders(accessToken: string) {
  return { ...authHeaders(accessToken), "content-type": "application/json" };
}

async function handleError(response: Response): Promise<never> {
  if (response.status === 401) throw new ApiAuthError();
  const payload = await response.json().catch(() => null);
  throw new ApiApplicationError(
    payload?.error?.code ?? "admin_request_failed",
    payload?.error?.message ?? "Unable to complete admin request.",
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
