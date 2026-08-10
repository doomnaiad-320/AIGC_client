import { z } from "zod";

import { subscriptionPlanSchema } from "./credits.js";

const nullableTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .nullable();

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
});
export type AdminUser = z.infer<typeof adminUserSchema>;

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

export const adminCreditAdjustmentRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  targetUserId: z.string().uuid(),
  amount: z
    .number()
    .int()
    .min(-500_000)
    .max(500_000)
    .refine((value) => value !== 0),
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
