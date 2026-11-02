import { z } from "zod";

const displayText = z.string().min(1).max(256)
  .refine((value) => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value));
const bucketID = z.string().min(1).max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
const percentage = z.number().finite().min(0).max(100);
const quantity = z.number().finite().nonnegative();

export const providerUsageQuantitySchema = z.strictObject({
  total: quantity.nullable(),
  used: quantity.nullable(),
  remaining: quantity.nullable(),
  unit: displayText,
}).superRefine((value, context) => {
  if (value.total === null && value.used === null && value.remaining === null) {
    context.addIssue({ code: "custom", message: "Usage quantity has no reported value" });
  }
  if (value.total !== null && ((value.used !== null && value.used > value.total)
    || (value.remaining !== null && value.remaining > value.total))) {
    context.addIssue({ code: "custom", message: "Usage quantity exceeds its reported total" });
  }
}).readonly();

export const providerUsagePeriodSchema = z.strictObject({
  kind: z.enum(["resets", "expires"]),
  at: z.string().datetime(),
}).readonly();

export const providerUsageBucketSchema = z.strictObject({
  id: bucketID,
  label: displayText,
  remainingPercent: percentage.nullable(),
  quantity: providerUsageQuantitySchema.nullable(),
  period: providerUsagePeriodSchema.nullable(),
  unlimited: z.boolean(),
  exhausted: z.boolean(),
}).superRefine((value, context) => {
  if (!value.unlimited && value.remainingPercent === null && value.quantity === null) {
    context.addIssue({ code: "custom", message: "Usage bucket has no displayable balance" });
  }
  if (value.unlimited && (value.exhausted || value.remainingPercent === 0)) {
    context.addIssue({ code: "custom", message: "Unlimited usage bucket is inconsistent" });
  }
}).readonly();

/** Provider-neutral account entitlement, never inferred from model tokens. */
export const providerAccountUsageSchema = z.strictObject({
  planLabel: displayText.nullable(),
  buckets: z.array(providerUsageBucketSchema).min(1).max(16).readonly(),
  // Adapter-selected account-wide/plan balances for compact task surfaces. Missing metadata
  // means no summary, never an invitation for the UI to guess from labels or array order.
  summaryBucketIDs: z.array(bucketID).max(2).readonly().default([]),
  exhausted: z.boolean(),
}).superRefine((value, context) => {
  if (new Set(value.buckets.map((bucket) => bucket.id)).size !== value.buckets.length) {
    context.addIssue({ code: "custom", message: "Usage bucket identities repeat" });
  }
  if (new Set(value.summaryBucketIDs).size !== value.summaryBucketIDs.length
    || value.summaryBucketIDs.some((id) => !value.buckets.some((bucket) => bucket.id === id))) {
    context.addIssue({ code: "custom", message: "Usage summary references must be unique existing buckets" });
  }
}).readonly();

export type ProviderAccountUsageV1 = z.infer<typeof providerAccountUsageSchema>;
export type ProviderUsageBucketV1 = z.infer<typeof providerUsageBucketSchema>;
