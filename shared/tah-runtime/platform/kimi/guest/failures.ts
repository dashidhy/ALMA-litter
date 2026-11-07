import type { NormalizedFailureV1 } from "../../../upstream/src/contract/index.js";
import type { NativeEvent } from "../adopted/native-sdk.js";

export class KimiFailure extends Error {
  constructor(readonly failure: NormalizedFailureV1) { super(failure.code); }
}
export function failure(family: NormalizedFailureV1["family"], code: string, message: string, retryable = false): KimiFailure {
  return new KimiFailure({ family, code: `kimi_${code}`, retryable, message });
}

export function retryDetail(event: NativeEvent): string {
  const names = ["ChatProviderError", "APIConnectionError", "APITimeoutError", "APIStatusError", "APIEmptyResponseError", "APIOverloadedError"];
  const parts = ["Kimi is retrying a model request"];
  if (typeof event.errorName === "string" && names.includes(event.errorName)) {
    parts.push(event.errorName);
  }
  if (typeof event.statusCode === "number" && Number.isInteger(event.statusCode) && event.statusCode >= 400 && event.statusCode <= 599) {
    parts.push(`HTTP ${event.statusCode}`);
  }
  if (typeof event.nextAttempt === "number" && Number.isSafeInteger(event.nextAttempt) && event.nextAttempt > 0 && event.nextAttempt <= 100) {
    parts.push(`attempt ${event.nextAttempt}`);
  }
  return parts.join(" · ");
}

export function nativeFailure(event: NativeEvent): KimiFailure {
  type NativeError = { code?: unknown; status?: unknown; statusCode?: unknown; name?: unknown; message?: unknown;
    details?: { statusCode?: unknown }; cause?: NativeError };
  let error = event.error as NativeError | undefined;
  for (let depth = 0; error && depth < 8; depth++, error = error.cause) {
    const code = error.code;
    const status = error.details?.statusCode ?? error.statusCode ?? error.status;
    for (const category of ["kimi_http_timeout", "kimi_http_failed", "kimi_response_limit", "kimi_headers_limit", "kimi_redirect_denied", "kimi_ack_timeout", "kimi_http_cancelled"]) {
      if (error.message === category || error.message === `Error: ${category}`) {
        const resource = category === "kimi_response_limit" || category === "kimi_headers_limit";
        return failure(resource ? "resource" : "provider_availability", category.slice(5),
          `Kimi's native transport reported ${category}.`, !resource);
      }
    }
    if (status === 429 || code === "provider.rate_limit") {
      return failure("rate_or_quota", "rate_limited", "Kimi Code returned HTTP 429 (rate, capacity or quota limit). Retry later or explicitly choose another available model.", true);
    }
    if (status === 529 || code === "provider.overloaded") {
      return failure("provider_availability", "overloaded", "Kimi Code is temporarily overloaded. Retry later or explicitly choose another available model.", true);
    }
    if (status === 401 || code === "auth.token_unauthorized") {
      return failure("authentication", "auth_invalid", "Kimi Code authorization is no longer valid.");
    }
    if (status === 403) {
      return failure("configuration", "model_access_denied", "This Kimi Code account does not permit the requested model or capability.");
    }
    if (code === "context.overflow") {
      return failure("resource", "context_limit", "The Kimi model context limit was exceeded.");
    }
    if (code === "loop.max_steps_exceeded") {
      return failure("resource", "step_limit", "Kimi reached the native step limit.");
    }
    if (code === "provider.connection_error") {
      return failure("provider_availability", "connection_failed", "Kimi's model request connection failed or timed out.", true);
    }
    if (code === "compaction.failed") {
      return failure("provider_availability", "compaction_failed", "Kimi could not compact the current context.", true);
    }
    if (code === "compaction.unable") {
      return failure("resource", "compaction_unable", "Kimi could not reduce the current context sufficiently.");
    }
    if (code === "provider.filtered") {
      return failure("provider_availability", "filtered", "Kimi's provider filtered the model response.");
    }
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) {
      return failure("provider_availability", `http_${status}`, `Kimi's model request returned HTTP ${status}.`, status >= 500 || status === 408 || status === 409);
    }
    if (code === "provider.api_error") {
      return failure("provider_availability", "api_error", "Kimi's provider returned an API or streaming response error.", true);
    }
  }
  if (event.interruptReason === "max_steps") {
    return failure("resource", "step_limit", "Kimi reached the native step limit.");
  }
  return failure("provider_availability", "turn_failed", "Kimi Code did not complete the native turn.", true);
}

