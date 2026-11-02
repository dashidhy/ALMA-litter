import { providerAccountUsageSchema, type ProviderAccountUsageV1, type ProviderUsageBucketV1 } from "../../../../src/contract/account-usage.js";

const MAX_LIMITS = 16;

/** Maps Codex rate-limit windows into the Provider-neutral account entitlement view. */
export function projectCodexAccountUsage(input: unknown): ProviderAccountUsageV1 | null {
  const root = record(input);
  if (root === undefined) return null;
  const views = rateLimitViews(root);
  const buckets: ProviderUsageBucketV1[] = [];
  const summaryBucketIDs: string[] = [];
  let planLabel: string | null = null;
  let creditsAdded = false;
  for (let index = 0; index < views.length && buckets.length < 16; index += 1) {
    const [mapID, snapshot] = views[index]!;
    const limitID = identifier(snapshot.limitId) ?? identifier(mapID) ?? `limit-${index + 1}`;
    const limitName = display(snapshot.limitName);
    planLabel ??= planName(snapshot.planType);
    for (const side of ["primary", "secondary"] as const) {
      if (buckets.length >= 16) break;
      const window = record(snapshot[side]);
      const usedPercent = percentage(window?.usedPercent);
      if (window === undefined || usedPercent === null) continue;
      const duration = positiveInteger(window.windowDurationMins);
      const periodLabel = duration === null ? (side === "primary" ? "Primary limit" : "Secondary limit")
        : durationLabel(duration);
      const prefix = limitName !== null && limitName !== limitID ? `${limitName} · ` : "";
      const remainingPercent = 100 - usedPercent;
      buckets.push(Object.freeze({
        id: `${limitID}:${side}`,
        label: `${prefix}${periodLabel}`,
        remainingPercent,
        quantity: null,
        period: resetPeriod(window.resetsAt),
        unlimited: false,
        exhausted: remainingPercent === 0 || snapshot.rateLimitReachedType != null,
      }));
      // `codex` is the general account rate-limit identity. Model-specific limits and
      // credits/individual spend controls remain available only in the full usage detail.
      if (limitID === "codex") summaryBucketIDs.push(`${limitID}:${side}`);
    }
    const individual = record(snapshot.individualLimit);
    const individualRemaining = percentage(individual?.remainingPercent);
    if (individual !== undefined && individualRemaining !== null && buckets.length < 16) {
      buckets.push(Object.freeze({
        id: `${limitID}:individual`, label: `${limitName === null ? "" : `${limitName} · `}Individual limit`,
        remainingPercent: individualRemaining, quantity: null, period: resetPeriod(individual.resetsAt),
        unlimited: false, exhausted: individualRemaining === 0 || snapshot.spendControlReached === true,
      }));
    }
    if (!creditsAdded && buckets.length < 16) {
      const credits = record(snapshot.credits);
      const unlimited = credits?.unlimited === true;
      const balance = decimal(credits?.balance);
      if (unlimited || balance !== null) {
        buckets.push(Object.freeze({
          id: `${limitID}:credits`, label: "Workspace credits", remainingPercent: null,
          quantity: balance === null ? null : Object.freeze({ total: null, used: null, remaining: balance, unit: "credits" }),
          period: null, unlimited, exhausted: !unlimited && credits?.hasCredits === false,
        }));
        creditsAdded = true;
      }
    }
  }
  if (buckets.length === 0) return null;
  const parsed = providerAccountUsageSchema.safeParse({
    planLabel,
    buckets,
    summaryBucketIDs,
    exhausted: buckets.every((bucket) => bucket.exhausted),
  });
  return parsed.success ? parsed.data : null;
}

function rateLimitViews(root: Record<string, unknown>): Array<[string | null, Record<string, unknown>]> {
  const byID = record(root.rateLimitsByLimitId);
  if (byID !== undefined) {
    const entries = Object.entries(byID);
    if (entries.length > MAX_LIMITS) return [];
    const result = entries.flatMap(([id, value]) => {
      const snapshot = record(value);
      return snapshot === undefined ? [] : [[id, snapshot] as [string, Record<string, unknown>]];
    });
    if (result.length > 0) {
      const general = ([id, snapshot]: [string | null, Record<string, unknown>]): boolean =>
        (identifier(snapshot.limitId) ?? identifier(id)) === "codex";
      const fallback = record(root.rateLimits);
      if (!result.some(general) && fallback !== undefined && identifier(fallback.limitId) === "codex") {
        result.unshift(["codex", fallback]);
      }
      // Preserve the general windows under the bounded projection even if specialty buckets
      // arrive first. Summary selection still uses explicit IDs, not this presentation order.
      return result.sort((left, right) => Number(general(right)) - Number(general(left)));
    }
  }
  const fallback = record(root.rateLimits);
  return fallback === undefined ? [] : [[null, fallback]];
}

function durationLabel(minutes: number): string {
  if (minutes === 60) return "Hourly";
  if (minutes === 24 * 60) return "Daily";
  if (minutes === 7 * 24 * 60) return "Weekly";
  if (minutes % (24 * 60) === 0) return `${String(minutes / (24 * 60))}-day`;
  if (minutes % 60 === 0) return `${String(minutes / 60)}-hour`;
  return `${String(minutes)}-minute`;
}

function planName(value: unknown): string | null {
  const raw = display(value);
  if (raw === null) return null;
  return raw.split("_").map((part) => part.length === 0 ? part
    : `${part[0]!.toUpperCase()}${part.slice(1)}`).join(" ");
}

function resetPeriod(value: unknown): ProviderUsageBucketV1["period"] {
  const seconds = nonnegativeInteger(value);
  if (seconds === null || seconds > Math.floor(8.64e15 / 1_000)) return null;
  const at = new Date(seconds * 1_000).toISOString();
  return Object.freeze({ kind: "resets", at });
}

function percentage(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}
function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null;
}
function nonnegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}
function decimal(value: unknown): number | null {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}
function identifier(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value) ? value : null;
}
function display(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
