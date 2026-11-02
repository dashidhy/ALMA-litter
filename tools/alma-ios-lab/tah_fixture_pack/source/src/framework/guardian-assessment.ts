import { z } from "zod";

export const RAW_GUARDIAN_REASON_CODES = Object.freeze([
  "harmful_content",
  "indirect_prompt_injection_suspected",
] as const);

export const EXTRA_GUARDIAN_REASON_CODES = Object.freeze([
  "harmful_request",
  "authority_override",
  "action_contract_conflict",
] as const);

const unique = <T extends string>(values: readonly T[]): boolean =>
  new Set(values).size === values.length;

const rawAssessmentSchema = z.strictObject({
  decision: z.enum(["ALLOW", "BLOCK"]),
  reasonCodes: z.array(z.enum(RAW_GUARDIAN_REASON_CODES)).max(RAW_GUARDIAN_REASON_CODES.length)
    .refine(unique, "reason codes repeat"),
}).superRefine((value, context) => {
  const harmful = value.reasonCodes.includes("harmful_content");
  if ((value.decision === "BLOCK") !== harmful) {
    context.addIssue({ code: "custom", message: "Raw decision disagrees with harmful_content" });
  }
});

const extraAssessmentSchema = z.strictObject({
  decision: z.enum(["ALLOW", "BLOCK"]),
  reasonCodes: z.array(z.enum(EXTRA_GUARDIAN_REASON_CODES)).max(EXTRA_GUARDIAN_REASON_CODES.length)
    .refine(unique, "reason codes repeat"),
}).superRefine((value, context) => {
  if ((value.decision === "BLOCK") !== (value.reasonCodes.length > 0)) {
    context.addIssue({ code: "custom", message: "Extra decision disagrees with reason codes" });
  }
});

export type RawGuardianAssessmentV1 = z.infer<typeof rawAssessmentSchema>;
export type ExtraGuardianAssessmentV1 = z.infer<typeof extraAssessmentSchema>;

// v1 is retained for historical evidence only. Live Guardian attempts use v2.
const explanationSchema = z.string().min(1).max(1_024)
  .refine(value => value.trim().length > 0 && Buffer.from(value, "utf8").toString("utf8") === value
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), "invalid explanation");
const rawAssessmentSchemaV2 = rawAssessmentSchema.safeExtend({ explanation: explanationSchema });
const extraAssessmentSchemaV2 = extraAssessmentSchema.safeExtend({ explanation: explanationSchema });
export type RawGuardianAssessmentV2 = z.infer<typeof rawAssessmentSchemaV2>;
export type ExtraGuardianAssessmentV2 = z.infer<typeof extraAssessmentSchemaV2>;

export function parseRawGuardianAssessmentV2(text: string): RawGuardianAssessmentV2 {
  return parseExactGuardianJSON(text, rawAssessmentSchemaV2, EXACT_GUARDIAN_JSON_V2);
}

export function parseExtraGuardianAssessmentV2(text: string): ExtraGuardianAssessmentV2 {
  return parseExactGuardianJSON(text, extraAssessmentSchemaV2, EXACT_GUARDIAN_JSON_V2);
}

export function parseRawGuardianAssessmentV1(text: string): RawGuardianAssessmentV1 {
  return parseExactGuardianJSON(text, rawAssessmentSchema);
}

export function parseExtraGuardianAssessmentV1(text: string): ExtraGuardianAssessmentV1 {
  return parseExactGuardianJSON(text, extraAssessmentSchema);
}

function parseExactGuardianJSON<T>(text: string, schema: z.ZodType<T>, grammar = EXACT_GUARDIAN_JSON): T {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 4_096
    || !grammar.test(text)) {
    throw new GuardianAssessmentError("Guardian final answer is not the exact JSON envelope");
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new GuardianAssessmentError("Guardian final answer is invalid JSON", { cause });
  }
  try {
    return deepFreeze(schema.parse(value));
  } catch (cause) {
    throw new GuardianAssessmentError("Guardian assessment violates its closed schema", { cause });
  }
}

// The Guardian prompts freeze this exact two-key order. Restricting the small
// grammar rejects duplicate keys, nested extension bags, escapes and prose
// without introducing a permissive general-purpose JSON parser.
const EXACT_GUARDIAN_JSON = /^\s*\{\s*"decision"\s*:\s*"(?:ALLOW|BLOCK)"\s*,\s*"reasonCodes"\s*:\s*\[\s*(?:"[a-z_]+"(?:\s*,\s*"[a-z_]+")*)?\s*\]\s*\}\s*$/u;

// Exactly three ordered keys. Only the explanation accepts JSON string escapes;
// duplicate/escaped keys, nested objects and extension fields remain forbidden.
const EXACT_GUARDIAN_JSON_V2 = /^\s*\{\s*"decision"\s*:\s*"(?:ALLOW|BLOCK)"\s*,\s*"reasonCodes"\s*:\s*\[\s*(?:"[a-z_]+"(?:\s*,\s*"[a-z_]+")*)?\s*\]\s*,\s*"explanation"\s*:\s*"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"\s*\}\s*$/u;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export class GuardianAssessmentError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GuardianAssessmentError";
  }
}
