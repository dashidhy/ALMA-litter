import type {AuthDriverResult} from "./driver.js";

export type AuthInspectionFailure = "authorization_invalid" | "models_unavailable" | "usage_unavailable"
  | "unavailable" | "timeout" | "protocol" | "cleanup" | "storage" | "cancelled" | "interrupted";
export interface AuthInspection {
  readonly id: string;
  readonly state: "checking" | "succeeded" | "failed";
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly failures: readonly AuthInspectionFailure[];
}

/** AuthDriver resolves only after confirmed Guest/process cleanup. Missing
 * capabilities are failures even if a Provider supplied a valid credential. */
export function inspectionFailures(result: AuthDriverResult): AuthInspectionFailure[] {
  if (result.state !== "valid") return ["authorization_invalid"];
  const failures: AuthInspectionFailure[] = [];
  if (!result.catalog?.models.length || result.catalogUnavailable) failures.push("models_unavailable");
  const usage = result.accountUsage;
  const usableUsage = usage?.summaryBucketIDs.some(id => usage.buckets.some(bucket => bucket.id === id
    && (bucket.unlimited || bucket.remainingPercent !== null || bucket.quantity?.remaining != null)));
  if (!usableUsage || result.accountUsageUnavailable) failures.push("usage_unavailable");
  return failures;
}

/** A stored credential alone is never an execution admission receipt. */
export function authorizationCheckSucceeded(value: {
  state: string; phase: string; inspecting: boolean; inspection: AuthInspection | null; replacement?: unknown;
}): boolean {
  return value.state === "valid" && value.phase === "idle" && !value.inspecting && value.replacement == null
    && value.inspection?.state === "succeeded" && value.inspection.finishedAt !== null && value.inspection.failures.length === 0;
}
