import { z } from "zod";

import { subscriptionPlanSchema } from "./credits.js";

const nullableTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .nullable();

export const adminUserStatusSchema = z.enum([
  "active",
  "suspended",
  "disabled",
]);
export type AdminUserStatus = z.infer<typeof adminUserStatusSchema>;

export const adminWorkspaceMembershipSchema = z.object({
  workspaceId: z.string().uuid(),
  workspaceName: z.string(),
  workspaceType: z.enum(["personal", "team"]),
  role: z.enum(["owner", "admin", "member"]),
  joinedAt: z.string().datetime({ offset: true }),
  plan: subscriptionPlanSchema,
  balance: z.number().int().nonnegative(),
  isOwner: z.boolean(),
});
export type AdminWorkspaceMembership = z.infer<
  typeof adminWorkspaceMembershipSchema
>;

export const adminWorkspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  type: z.enum(["personal", "team"]),
  createdAt: z.string().datetime({ offset: true }),
  ownerUserId: z.string().uuid(),
  ownerEmail: z.string().email(),
  ownerDisplayName: z.string(),
  memberCount: z.number().int().nonnegative(),
  projectCount: z.number().int().nonnegative(),
  plan: subscriptionPlanSchema,
  balance: z.number().int().nonnegative(),
});
export type AdminWorkspace = z.infer<typeof adminWorkspaceSchema>;

export const adminWorkspaceMemberSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string(),
  role: z.enum(["owner", "admin", "member"]),
  joinedAt: z.string().datetime({ offset: true }),
  status: adminUserStatusSchema,
});
export type AdminWorkspaceMember = z.infer<typeof adminWorkspaceMemberSchema>;

export const adminWorkspaceProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  canvasCount: z.number().int().nonnegative(),
});
export type AdminWorkspaceProject = z.infer<typeof adminWorkspaceProjectSchema>;

export const adminWorkspaceDetailSchema = z.object({
  workspace: adminWorkspaceSchema,
  members: z.array(adminWorkspaceMemberSchema),
  projects: z.array(adminWorkspaceProjectSchema),
});
export type AdminWorkspaceDetail = z.infer<typeof adminWorkspaceDetailSchema>;

export const adminOverviewSchema = z.object({
  totalUsers: z.number().int().nonnegative(),
  activeJobs: z.number().int().nonnegative(),
  failedJobs24h: z.number().int().nonnegative(),
  adjustments24h: z.number().int().nonnegative(),
});
export type AdminOverview = z.infer<typeof adminOverviewSchema>;

export const adminUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  lastSignInAt: nullableTimestampSchema,
  workspaceId: z.string().uuid().nullable(),
  workspaceName: z.string().nullable(),
  plan: subscriptionPlanSchema,
  balance: z.number().int().nonnegative(),
  isPlatformAdmin: z.boolean(),
  status: adminUserStatusSchema,
  statusReason: z.string().nullable(),
  statusChangedAt: nullableTimestampSchema,
});
export type AdminUser = z.infer<typeof adminUserSchema>;

export const adminUpdateUserRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    email: z.string().trim().email().optional(),
    plan: subscriptionPlanSchema.optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .refine(
    (value) =>
      value.displayName !== undefined ||
      value.email !== undefined ||
      value.plan !== undefined,
    { message: "Provide an email, display name, or plan." },
  );
export type AdminUpdateUserRequest = z.infer<
  typeof adminUpdateUserRequestSchema
>;

export const adminUpdateUserStatusRequestSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  status: adminUserStatusSchema,
});
export type AdminUpdateUserStatusRequest = z.infer<
  typeof adminUpdateUserStatusRequestSchema
>;

export const adminPasswordResetRequestSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
export type AdminPasswordResetRequest = z.infer<
  typeof adminPasswordResetRequestSchema
>;

export const adminPasswordResetResponseSchema = z.object({
  expiresAt: z.string().datetime({ offset: true }),
  resetToken: z.string().min(32),
});
export type AdminPasswordResetResponse = z.infer<
  typeof adminPasswordResetResponseSchema
>;

export const adminPlatformAdminSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  createdByEmail: z.string().email().nullable(),
  displayName: z.string(),
  email: z.string().email(),
  note: z.string(),
  userId: z.string().uuid(),
});
export type AdminPlatformAdmin = z.infer<typeof adminPlatformAdminSchema>;

export const adminPlatformAdminMutationRequestSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
export type AdminPlatformAdminMutationRequest = z.infer<
  typeof adminPlatformAdminMutationRequestSchema
>;

export const adminJobSchema = z.object({
  id: z.string().uuid(),
  jobType: z.string(),
  status: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  startedAt: nullableTimestampSchema,
  completedAt: nullableTimestampSchema,
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  workspaceName: z.string().nullable(),
  userEmail: z.string().email().nullable(),
  userDisplayName: z.string().nullable(),
});
export type AdminJob = z.infer<typeof adminJobSchema>;

export const adminAgentRunSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  sessionTitle: z.string().nullable(),
  threadId: z.string(),
  status: z.string(),
  model: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  completedAt: nullableTimestampSchema,
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  workspaceName: z.string().nullable(),
  projectName: z.string().nullable(),
  canvasName: z.string().nullable(),
  userEmail: z.string().email().nullable(),
  userDisplayName: z.string().nullable(),
});
export type AdminAgentRun = z.infer<typeof adminAgentRunSchema>;

export const adminCreditTransactionSchema = z.object({
  id: z.string().uuid(),
  transactionType: z.string(),
  amount: z.number().int(),
  balanceAfter: z.number().int().nonnegative(),
  description: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  workspaceId: z.string().uuid(),
  workspaceName: z.string().nullable(),
  userEmail: z.string().email().nullable(),
  userDisplayName: z.string().nullable(),
});
export type AdminCreditTransaction = z.infer<
  typeof adminCreditTransactionSchema
>;

export const adminAuditEventSchema = z.object({
  id: z.string().uuid(),
  action: z.string(),
  actorEmail: z.string().email(),
  targetEmail: z.string().email().nullable(),
  workspaceName: z.string().nullable(),
  metadata: z.record(z.unknown()),
  createdAt: z.string().datetime({ offset: true }),
});
export type AdminAuditEvent = z.infer<typeof adminAuditEventSchema>;

export const adminUserDetailSchema = z.object({
  user: adminUserSchema,
  workspaces: z.array(adminWorkspaceMembershipSchema),
  recentTransactions: z.array(adminCreditTransactionSchema),
  recentJobs: z.array(adminJobSchema),
  recentAgentRuns: z.array(adminAgentRunSchema),
});
export type AdminUserDetail = z.infer<typeof adminUserDetailSchema>;

export const adminCreditAdjustmentRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  targetUserId: z.string().uuid(),
  amount: z.number().int().min(1).max(500_000),
  reason: z.string().trim().min(3).max(500),
});
export type AdminCreditAdjustmentRequest = z.infer<
  typeof adminCreditAdjustmentRequestSchema
>;

export const adminCreditAdjustmentResponseSchema = z.object({
  transactionId: z.string().uuid(),
  balance: z.number().int().nonnegative(),
});
export type AdminCreditAdjustmentResponse = z.infer<
  typeof adminCreditAdjustmentResponseSchema
>;
