import { z } from "zod";

/** Capacity selection, not context-occupancy telemetry or a permission grant. */
export const contextWindowTokensSchema = z.number().int().positive();
export const contextWindowOptionsSchema = z.strictObject({
  availableTokens: z.array(contextWindowTokensSchema).min(1).max(32).readonly(),
  defaultTokens: contextWindowTokensSchema.nullable(),
}).superRefine((value, context) => {
  if (new Set(value.availableTokens).size !== value.availableTokens.length
    || (value.defaultTokens !== null && !value.availableTokens.includes(value.defaultTokens))) {
    context.addIssue({ code: "custom", message: "Invalid context-window options" });
  }
}).readonly();
export type ContextWindowOptionsV1 = z.infer<typeof contextWindowOptionsSchema>;
