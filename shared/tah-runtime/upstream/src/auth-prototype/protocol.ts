import { z } from "zod";
import { contextWindowOptionsSchema } from "../contract/context-window.js";
import { providerAccountUsageSchema } from "../contract/account-usage.js";

export const AUTH_PROVIDERS = Object.freeze([
  Object.freeze({ id: "codex" as const, displayName: "Codex" }),
  Object.freeze({ id: "qoder" as const, displayName: "Qoder" }),
  Object.freeze({ id: "kimi" as const, displayName: "Kimi Code (Prototype)" }),
  Object.freeze({ id: "zcode" as const, displayName: "ZCode" }),
]);
export const providerIDSchema = z.enum(["codex", "qoder", "kimi", "zcode"]);
export type AuthProviderID = z.infer<typeof providerIDSchema>;
export const MAX_CREDENTIAL_BYTES = 64 * 1024;
export const MAX_WIRE_BYTES = 192 * 1024;
const text = z.string().min(1).max(256).refine((s) => !/[\u0000-\u001f\u007f]/u.test(s));
const handle = text.refine((s) => s.trim() === s);
export const catalogSchema = z.strictObject({
  models: z.array(z.strictObject({
    handle, displayName: text,
    efforts: z.array(z.strictObject({ handle, displayName: text })).max(16),
    defaultEffortHandle: handle.nullable(),
    contextWindows: contextWindowOptionsSchema.optional(),
  })).min(1).max(64),
  defaultModelHandle: handle.nullable(),
}).superRefine((catalog, context) => {
  const models = new Set(catalog.models.map((model) => model.handle));
  if (models.size !== catalog.models.length
    || (catalog.defaultModelHandle !== null && !models.has(catalog.defaultModelHandle))) {
    context.addIssue({ code: "custom", message: "Invalid catalog model handles" });
  }
  for (const model of catalog.models) {
    const efforts = new Set(model.efforts.map((effort) => effort.handle));
    if (efforts.size !== model.efforts.length
      || (model.defaultEffortHandle !== null && !efforts.has(model.defaultEffortHandle))) {
      context.addIssue({ code: "custom", message: "Invalid catalog effort handles" });
    }
  }
});
export type AuthCatalog = z.infer<typeof catalogSchema>;
const verificationURL = z.string().max(2048).url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
});
export const challengeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("device_code"), title: text, verificationURL, userCode: text }),
  z.strictObject({ kind: z.literal("secret"), title: text, label: text }),
]);
export type AuthChallenge = z.infer<typeof challengeSchema>;
export const failureCodeSchema = z.enum([
  "unavailable", "protocol", "timeout", "cleanup", "auth_invalid", "storage",
]);
export type AuthFailureCode = z.infer<typeof failureCodeSchema>;
export const helloSchema = z.strictObject({
  type: z.literal("hello"), version: z.literal(1), operationID: z.string().uuid(),
  providerID: providerIDSchema, kind: z.enum(["authenticate", "inspect"]),
});
export type AuthHello = z.infer<typeof helloSchema>;
const encodedCredential = z.string().min(4).max(Math.ceil(MAX_CREDENTIAL_BYTES / 3) * 4)
  .refine((value) => /^[A-Za-z0-9+/]*={0,2}$/u.test(value)
    && Buffer.from(value, "base64").toString("base64") === value
    && Buffer.from(value, "base64").byteLength <= MAX_CREDENTIAL_BYTES);
export const inputFrameSchema = z.discriminatedUnion("type", [
  helloSchema,
  z.strictObject({ type: z.literal("credential"), data: encodedCredential.nullable() }),
  z.strictObject({ type: z.literal("input"), challengeID: z.string().uuid(), data: encodedCredential }),
  z.strictObject({ type: z.literal("cancel") }),
]);
const resultFrameSchema = z.strictObject({
  type: z.literal("result"), state: z.enum(["valid", "invalid"]), account: text.nullable(),
  catalog: catalogSchema.nullable(), catalogUnavailable: z.boolean(),
  accountUsage: providerAccountUsageSchema.nullable(), accountUsageUnavailable: z.boolean(),
}).superRefine((value, context) => {
  if ((value.catalog !== null && value.catalogUnavailable)
    || (value.accountUsage !== null && value.accountUsageUnavailable)
    || (value.state === "invalid" && (value.account !== null || value.catalog !== null
      || value.catalogUnavailable || value.accountUsage !== null || value.accountUsageUnavailable))) {
    context.addIssue({ code: "custom", message: "Inconsistent auth result" });
  }
});
export const outputFrameSchema = z.discriminatedUnion("type", [
  helloSchema.extend({ type: z.literal("ready") }),
  z.strictObject({ type: z.literal("challenge"), challengeID: z.string().uuid(), challenge: challengeSchema }),
  z.strictObject({ type: z.literal("credential"), data: encodedCredential }),
  resultFrameSchema,
  z.strictObject({ type: z.literal("failure"), code: failureCodeSchema }),
  z.strictObject({ type: z.literal("cancelled") }),
]);
export type AuthOutputFrame = z.infer<typeof outputFrameSchema>;

export class AuthOperationError extends Error {
  public constructor(public readonly code: AuthFailureCode) {
    super(`Authorization operation failed (${code})`);
    this.name = "AuthOperationError";
  }
}

export function cancelled(): DOMException { return new DOMException("Cancelled", "AbortError"); }
