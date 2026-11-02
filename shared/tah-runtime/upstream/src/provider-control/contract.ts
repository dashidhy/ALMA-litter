import { z } from "zod";
import { contextWindowOptionsSchema } from "../contract/context-window.js";

import { normalizedFailureSchema } from "../contract/index.js";

export const TAH_PROVIDER_CONTROL_VERSION = 1 as const;
export const TAH_PROVIDER_CONTROL_MAX_MODELS = 64;
export const TAH_PROVIDER_CONTROL_MAX_EFFORTS_PER_MODEL = 16;

const operationID = z.string().uuid().refine((value) => value === value.toLowerCase());
const providerID = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/u);
const opaqueHandle = z.string()
  .min(1)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 256)
  .refine((value) => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value));
const displayText = z.string()
  .min(1)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 256)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const implementationVersion = z.string()
  .min(1)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 128)
  .refine((value) => !/[\u0000-\u001f\u007f\s]/u.test(value));

const requestEnvelope = {
  controlVersion: z.literal(TAH_PROVIDER_CONTROL_VERSION),
  operationID,
  providerID,
};

export const providerControlRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...requestEnvelope, kind: z.literal("describe") }),
  z.strictObject({ ...requestEnvelope, kind: z.literal("inspect_authentication") }),
  z.strictObject({ ...requestEnvelope, kind: z.literal("list_inference_catalog") }),
]);

export type ProviderControlRequestV1 = z.infer<typeof providerControlRequestSchema>;

const resultEnvelope = {
  controlVersion: z.literal(TAH_PROVIDER_CONTROL_VERSION),
  providerID,
};

export const providerDescriptionSchema = z.strictObject({
  ...resultEnvelope,
  kind: z.literal("provider_description"),
  displayName: displayText,
  implementationName: displayText,
  implementationVersion,
  capabilities: z.strictObject({
    authenticationInspection: z.literal(true),
    inferenceCatalog: z.literal(true),
    /**
     * Auth mutation needs a future, bounded multi-step ceremony with opaque
     * continuation authority and a separate one-shot secret channel. Control
     * v1 intentionally has no generic extension bag or pretend implementation.
     */
    authenticationMutation: z.literal("not_implemented_v1"),
  }),
});

export const providerAuthenticationSnapshotSchema = z.strictObject({
  ...resultEnvelope,
  kind: z.literal("authentication_snapshot"),
  state: z.enum(["valid", "invalid"]),
});

export const providerEffortCatalogEntrySchema = z.strictObject({
  handle: opaqueHandle,
  displayName: displayText,
});

export const providerModelCatalogEntrySchema = z.strictObject({
  handle: opaqueHandle,
  displayName: displayText,
  efforts: z.array(providerEffortCatalogEntrySchema)
    .max(TAH_PROVIDER_CONTROL_MAX_EFFORTS_PER_MODEL),
  defaultEffortHandle: opaqueHandle.nullable(),
  contextWindows: contextWindowOptionsSchema.optional(),
}).superRefine((value, context) => {
  const handles = value.efforts.map((entry) => entry.handle);
  if (new Set(handles).size !== handles.length) {
    context.addIssue({ code: "custom", path: ["efforts"], message: "effort handles must be unique" });
  }
  if (value.defaultEffortHandle !== null && !handles.includes(value.defaultEffortHandle)) {
    context.addIssue({
      code: "custom",
      path: ["defaultEffortHandle"],
      message: "default effort must name one listed opaque handle",
    });
  }
});

export const providerInferenceCatalogSchema = z.strictObject({
  ...resultEnvelope,
  kind: z.literal("inference_catalog"),
  models: z.array(providerModelCatalogEntrySchema)
    .min(1)
    .max(TAH_PROVIDER_CONTROL_MAX_MODELS),
  defaultModelHandle: opaqueHandle.nullable(),
}).superRefine((value, context) => {
  const handles = value.models.map((entry) => entry.handle);
  if (new Set(handles).size !== handles.length) {
    context.addIssue({ code: "custom", path: ["models"], message: "model handles must be unique" });
  }
  if (value.defaultModelHandle !== null && !handles.includes(value.defaultModelHandle)) {
    context.addIssue({
      code: "custom",
      path: ["defaultModelHandle"],
      message: "default model must name one listed opaque handle",
    });
  }
});

export const providerControlResultSchema = z.discriminatedUnion("kind", [
  providerDescriptionSchema,
  providerAuthenticationSnapshotSchema,
  providerInferenceCatalogSchema,
]);

export type ProviderDescriptionV1 = z.infer<typeof providerDescriptionSchema>;
export type ProviderAuthenticationSnapshotV1 = z.infer<
  typeof providerAuthenticationSnapshotSchema
>;
export type ProviderEffortCatalogEntryV1 = z.infer<typeof providerEffortCatalogEntrySchema>;
export type ProviderModelCatalogEntryV1 = z.infer<typeof providerModelCatalogEntrySchema>;
export type ProviderInferenceCatalogV1 = z.infer<typeof providerInferenceCatalogSchema>;
export type ProviderControlResultV1 = z.infer<typeof providerControlResultSchema>;

export const providerControlTerminalSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ok"), result: providerControlResultSchema }),
  z.strictObject({ status: z.literal("failed"), failure: normalizedFailureSchema }),
  z.strictObject({ status: z.literal("cancelled") }),
]);

export type ProviderControlTerminalV1 = z.infer<typeof providerControlTerminalSchema>;

export function parseProviderControlRequestV1(value: unknown): ProviderControlRequestV1 {
  return providerControlRequestSchema.parse(value);
}

export function parseProviderControlTerminalV1(value: unknown): ProviderControlTerminalV1 {
  return providerControlTerminalSchema.parse(value);
}

export function assertMatchingProviderControlTerminalV1(
  request: ProviderControlRequestV1,
  terminal: ProviderControlTerminalV1,
): void {
  if (terminal.status !== "ok") return;
  if (terminal.result.providerID !== request.providerID) {
    throw new TypeError("Provider control result belongs to another Provider");
  }
  const expectedKind = request.kind === "describe"
    ? "provider_description"
    : request.kind === "inspect_authentication"
      ? "authentication_snapshot"
      : "inference_catalog";
  if (terminal.result.kind !== expectedKind) {
    throw new TypeError("Provider control result does not match its request");
  }
}
