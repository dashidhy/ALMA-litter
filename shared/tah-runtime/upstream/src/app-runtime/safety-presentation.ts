import { z } from "zod";
import { parseExtraGuardianAssessmentV1, parseRawGuardianAssessmentV1, parseExtraGuardianAssessmentV2, parseRawGuardianAssessmentV2 } from "../framework/guardian-assessment.js";

export const safetyExplanationsSchema = z.array(z.strictObject({
  subject: z.enum(["raw", "extra"]), decision: z.enum(["ALLOW", "BLOCK"]),
  reasonCodes: z.array(z.string()).max(3), explanation: z.string().min(1).max(1024),
  interactionLanguage: z.enum(["en", "zh-CN"]), checkedAt: z.string(), cached: z.boolean(),
})).max(2);
export type SafetyExplanation = z.infer<typeof safetyExplanationsSchema>[number];
export function safetyExplanation(subject: "raw" | "extra", value: unknown, interactionLanguage: "en" | "zh-CN", checkedAt: string, cached = false): SafetyExplanation {
  const assessment = (subject === "raw" ? parseRawGuardianAssessmentV2 : parseExtraGuardianAssessmentV2)(JSON.stringify(value));
  return {subject, ...assessment, interactionLanguage, checkedAt, cached};
}
function assessmentParser(raw: boolean, value: unknown) {
  const v2 = value !== null && typeof value === "object" && "explanation" in value;
  return (raw ? v2 ? parseRawGuardianAssessmentV2 : parseRawGuardianAssessmentV1
    : v2 ? parseExtraGuardianAssessmentV2 : parseExtraGuardianAssessmentV1)(JSON.stringify(value));
}

/** Historical v1 and new v2 assessments keep the same closed reason codes. */
export function safetyReasonCodes(phase: string, result: unknown, rawAssessment?: unknown): readonly string[] | undefined {
  if (phase === "raw_blocked" && rawAssessment !== undefined) {
    const assessment = assessmentParser(true, rawAssessment);
    return assessment.decision === "BLOCK" ? assessment.reasonCodes : undefined;
  }
  if (phase === "extra_blocked" && result && typeof result === "object" && "kind" in result
    && result.kind === "extra_blocked" && "assessment" in result) {
    const assessment = assessmentParser(false, result.assessment);
    return assessment.decision === "BLOCK" ? assessment.reasonCodes : undefined;
  }
  return undefined; // Older records can lack a Raw assessment; do not invent one.
}
