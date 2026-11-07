import { AuthOperationError, cancelled, type AuthDriver, type AuthDriverResult } from "../../../../src/auth-prototype/driver.js";
import { catalogSchema, type AuthCatalog } from "../../../../src/auth-prototype/protocol.js";
import { providerAccountUsageSchema, type ProviderAccountUsageV1 } from "../../../../src/contract/account-usage.js";
import { KIMI_MODELS } from "./models.js";

export type KimiJSONRequest = (path: "models" | "usages", key: string, signal: AbortSignal) => Promise<unknown>;
const INVALID: AuthDriverResult = Object.freeze({ state: "invalid", credential: null, account: null,
  catalog: null, catalogUnavailable: false, accountUsage: null, accountUsageUnavailable: false });

/** Only the official service receives the key; redirects and response bodies never become UI errors. */
export const requestKimiJSON: KimiJSONRequest = async (path, key, signal) => {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  try {
    const response = await fetch(`https://api.kimi.com/coding/v1/${path}`, {
      headers: { Authorization: `Bearer ${key}`, "User-Agent": "Alma-Prototype/0.1" },
      redirect: "error", signal: combined,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AuthOperationError(response.status === 401 || response.status === 403 ? "auth_invalid" : "unavailable");
    }
    if (!response.body) throw new AuthOperationError("protocol");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        length += next.value.byteLength;
        if (length > 256 * 1024) throw new AuthOperationError("protocol");
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
    catch { throw new AuthOperationError("protocol"); }
  } catch (error) {
    if (signal.aborted) throw cancelled();
    if (combined.aborted) throw new AuthOperationError("timeout");
    if (error instanceof AuthOperationError) throw error;
    throw new AuthOperationError("unavailable");
  }
};

export function decodeKimiKey(bytes: Uint8Array): string {
  if (bytes.byteLength < 20 || bytes.byteLength > 4096) throw new AuthOperationError("auth_invalid");
  let key: string;
  try { key = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim(); }
  catch { throw new AuthOperationError("auth_invalid"); }
  if (!/^sk-[A-Za-z0-9_-]{20,}$/u.test(key)) throw new AuthOperationError("auth_invalid");
  return key;
}

export function projectKimiCatalog(value: unknown): AuthCatalog {
  const data = object(value).data;
  if (!Array.isArray(data) || data.length > 128) {
    throw new AuthOperationError("unavailable");
  }
  const available = new Set(data.map(entry => object(entry).id));
  const models = Object.entries(KIMI_MODELS).filter(([id]) => available.has(id)).map(([handle, model]) => ({
    handle, displayName: model.name, defaultEffortHandle: model.efforts.includes("low") ? "low" : "on",
    efforts: model.efforts.map(handle => ({ handle, displayName: handle === "on" ? "Thinking on (fixed)" : handle })),
  }));
  if (!models.length) throw new AuthOperationError("unavailable");
  return catalogSchema.parse({ defaultModelHandle: available.has("kimi-for-coding") ? "kimi-for-coding" : null, models });
}

export function projectKimiUsage(value: unknown): ProviderAccountUsageV1 {
  const usages = object(object(value).usages);
  const labels: Record<string, string> = { limit_5h: "5 hours", limit_month_total: "Monthly total", limit_month_code: "Monthly coding" };
  const buckets = Object.entries(labels).flatMap(([id, label]) => {
    const ratio = object(usages[id]).used_ratio;
    if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) return [];
    return [{ id, label, remainingPercent: (1 - ratio) * 100, quantity: null, period: null,
      unlimited: false, exhausted: ratio === 1 }];
  });
  if (!buckets.length) throw new AuthOperationError("protocol");
  return providerAccountUsageSchema.parse({ planLabel: null, buckets,
    summaryBucketIDs: ["limit_5h", "limit_month_total"].filter(id => buckets.some(b => b.id === id)),
    exhausted: buckets.some(b => b.exhausted) });
}

export function createKimiAuthDriver(request: KimiJSONRequest = requestKimiJSON): AuthDriver {
  return async context => {
    if (context.providerID !== "kimi") throw new AuthOperationError("protocol");
    if (context.signal.aborted) throw cancelled();
    let bytes: Uint8Array | null = null;
    try {
      bytes = context.kind === "authenticate" ? await context.challenge({ kind: "secret",
        title: "Authorize Kimi Code", label: "Kimi Code API key" }) : context.credential;
      if (context.signal.aborted) throw cancelled();
      if (!bytes) { if (context.kind === "authenticate") throw cancelled(); return INVALID; }
      const key = decodeKimiKey(bytes);
      // Successful models request validates the account even if the selected model is unavailable.
      const models = await request("models", key, context.signal);
      let catalog: AuthCatalog | null = null; let usage: ProviderAccountUsageV1 | null = null;
      try { catalog = projectKimiCatalog(models); } catch { /* Present unavailability, never invent a model. */ }
      try { usage = projectKimiUsage(await request("usages", key, context.signal)); }
      catch (error) {
        if (context.signal.aborted) throw cancelled();
        if (error instanceof AuthOperationError && error.code === "auth_invalid") throw error;
      }
      return { state: "valid", credential: context.kind === "authenticate" ? new TextEncoder().encode(key) : null,
        account: "Kimi Code", catalog, catalogUnavailable: catalog === null,
        accountUsage: usage, accountUsageUnavailable: usage === null };
    } catch (error) {
      if (error instanceof AuthOperationError && error.code === "auth_invalid") return INVALID;
      throw error;
    } finally { bytes?.fill(0); }
  };
}

export const runAuthDriver: AuthDriver = createKimiAuthDriver();
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
