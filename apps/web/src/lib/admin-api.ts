import type {
  AdminAuditEvent,
  AdminCreditAdjustmentRequest,
  AdminCreditAdjustmentResponse,
  AdminCreditTransaction,
  AdminJob,
  AdminOverview,
  AdminUser,
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

export function fetchAdminUsers(accessToken: string, search = "") {
  const query = new URLSearchParams({ limit: "100" });
  if (search.trim()) query.set("search", search.trim());
  return get<{ users: AdminUser[] }>(accessToken, `/api/admin/users?${query}`);
}

export function fetchAdminJobs(accessToken: string) {
  return get<{ jobs: AdminJob[] }>(accessToken, "/api/admin/jobs?limit=100");
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
