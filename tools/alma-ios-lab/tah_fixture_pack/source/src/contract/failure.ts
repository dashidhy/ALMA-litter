import { z } from "zod";

export const NORMALIZED_FAILURE_FAMILIES = Object.freeze([
  "authentication",
  "configuration",
  "capability",
  "provider_availability",
  "rate_or_quota",
  "protocol",
  "policy",
  "resource",
  "cancellation",
  "cleanup",
  "unknown_provider",
] as const);

export type NormalizedFailureFamily = (typeof NORMALIZED_FAILURE_FAMILIES)[number];

export const normalizedFailureSchema = z.strictObject({
  family: z.enum(NORMALIZED_FAILURE_FAMILIES),
  code: z.string().min(1).max(128).regex(/^[a-z][a-z0-9_]*$/u),
  retryable: z.boolean(),
  message: z.string().min(1).max(1_024),
});

export type NormalizedFailureV1 = z.infer<typeof normalizedFailureSchema>;
