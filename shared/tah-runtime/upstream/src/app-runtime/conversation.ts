import { z } from "zod";
import { AppBridgeError } from "./bridge.js";
import type { JournalRecord, ServiceJournal } from "./journal.js";
import { frozenAttemptSchema } from "../contract/index.js";
import { outcomeCriticResultSchema } from "../framework/outcome-critic.js";
import { appPresentationSchema, publicPresentation } from "./presentation.js";
import { safetyReasonCodes, safetyExplanationsSchema } from "./safety-presentation.js";

const cursorSchema = z.strictObject({ version: z.literal(1), actionID: z.uuid(), before: z.number().int().nonnegative().max(1_000_000) });
const operationSchema = z.object({ cycleID: z.uuid(), phase: z.string().max(64), revisionIndex: z.number().int().min(0).max(127),
  interactionLanguage: z.enum(["en", "zh-CN"]).default("en"),
  providerID: z.string().max(64), inference: frozenAttemptSchema.shape.inference, instructions: z.string().max(64 * 1024), result: z.unknown().nullable(),
  submissionKind: z.enum(["send", "retry"]).optional(), safetyExplanations: safetyExplanationsSchema.optional(), presentation: appPresentationSchema.optional(), rawAssessment: z.unknown().optional(), error: z.string().max(4096).nullable().optional() });

/** App-owned user input, Framework verdicts and the public final answer of a committed result.
 * Never serialize native Provider objects, credentials or private reasoning into conversation. */
export function publicConversation(record: JournalRecord) {
  const op = operationSchema.parse(record.value);
  const retry = op.phase === "running" && op.submissionKind === "retry";
  const user = op.phase === "running" && !retry;
  let text = retry ? "Retrying the exact frozen attempt." : user ? op.instructions || "Generate the initial outcomes." : op.phase.replaceAll("_", " ");
  let criticSummary = "";
  let criticRounds: Array<{round: number; decision: string; issues: Array<{code: string; relativePath: string}>; omittedIssueCount?: number}> = [];
  if (!user && op.result && typeof op.result === "object" && "criticRounds" in op.result) {
    const rounds = z.array(z.object({ round: z.union([z.literal(0), z.literal(1)]), result: outcomeCriticResultSchema })).max(2).parse(op.result.criticRounds);
    // Structured metadata must not bypass the bounded text preview/XPC budget.
    // Preserve full results in the journal and the existing full-text path.
    let remainingIssueBytes = 16 * 1024;
    criticRounds = rounds.map(value => {
      const issues: Array<{code: string; relativePath: string}> = [];
      for (const issue of value.result.issues) {
        const projected = {code: issue.code, relativePath: issue.relativePath};
        const bytes = Buffer.byteLength(JSON.stringify(projected)) + 1;
        if (issues.length >= 16 || bytes > remainingIssueBytes) break;
        issues.push(projected); remainingIssueBytes -= bytes;
      }
      const omittedIssueCount = value.result.issues.length - issues.length;
      return {round: value.round, decision: value.result.decision, issues,
        ...(omittedIssueCount ? {omittedIssueCount} : {})};
    });
    for (const round of rounds) criticSummary += `\nRule Critic ${round.round + 1}: ${round.result.decision}`
      + round.result.issues.map(issue => `\n${issue.code}: ${issue.relativePath}`).join("");
    text += criticSummary;
  }
  const completed = z.object({ kind: z.literal("completed"), publicationCommitID: z.string(), finalText: z.string().max(4 * 1024 * 1024)
    .refine(text => Buffer.byteLength(text) <= 4 * 1024 * 1024) }).safeParse(op.result);
  const isFinalAnswer = op.phase === "completed" && completed.success && completed.data.publicationCommitID === `publication/${op.cycleID}`;
  if (isFinalAnswer) text = completed.data.finalText;
  const textKind = isFinalAnswer ? "final_answer" : user ? op.instructions ? "user_input" : "initial_request" : retry ? "retry_notice" : "workflow_status";
  const preview = [...text].slice(0, 1500).join("");
  const reasons = safetyReasonCodes(op.phase, op.result, op.rawAssessment);
  return { id: record.operationID, position: record.version, cycleID: op.cycleID, role: user ? "user" : "workflow",
    phase: op.phase, revisionIndex: op.revisionIndex, providerID: op.providerID, modelID: op.inference.modelID,
    interactionLanguage: op.interactionLanguage,
    textKind,
    ...(reasons ? { safetyReasonCodes: reasons } : {}),
    ...(!user && op.safetyExplanations ? {safetyExplanations: op.safetyExplanations.filter(value => value.subject === "extra" && value.decision === "BLOCK")} : {}),
    ...(criticRounds.length ? {criticRounds} : {}),
    text: preview, truncated: preview.length !== text.length, fullText: text,
    ...(isFinalAnswer ? { isFinalAnswer: true, criticSummary: [...criticSummary.trim()].slice(0, 1500).join("") } : {}),
    ...(!user && op.error ? { errorText: op.error } : {}),
    ...(op.presentation && !user ? { presentation: publicPresentation(op.presentation, op.phase) } : {}) };
}

/** Descending immutable journal positions are the cursor fence. New appends do
 * not shift old pages or repeat entries. A cursor never grants cross-Action access. */
export async function conversationPage(journal: Pick<ServiceJournal, "head" | "readRange">, actionID: string, cursor: string | null, visibleCycles?: ReadonlySet<string>) {
  z.uuid().parse(actionID);
  const head = await journal.head(`operation/${actionID}`);
  let before = head.version;
  if (cursor !== null) {
    if (cursor.length > 512) throw new AppBridgeError("invalid_request");
    let parsed: z.infer<typeof cursorSchema>;
    try { parsed = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))); }
    catch { throw new AppBridgeError("invalid_request"); }
    if (parsed.actionID !== actionID || parsed.before > head.version) throw new AppBridgeError("invalid_request");
    before = parsed.before;
  }
  const items: Array<Omit<ReturnType<typeof publicConversation>, "fullText">> = [];
  let nextBefore = before;
  do {
  const after = Math.max(0, nextBefore - 8);
  const records = await journal.readRange(`operation/${actionID}`, after, nextBefore);
  if (records.length !== nextBefore - after) throw new AppBridgeError("integrity_locked");
  for (const record of [...records].reverse()) {
    const op = operationSchema.parse(record.value);
    if (op.phase === "editing" || (visibleCycles && !visibleCycles.has(op.cycleID))) { nextBefore = record.version - 1; continue; }
    const { fullText: _private, ...item } = publicConversation(record);
    if (items.length && Buffer.byteLength(JSON.stringify([...items, item])) > 96 * 1024) break;
    items.push(item); nextBefore = record.version - 1;
  }
  } while (items.length === 0 && nextBefore > 0);
  return { items, nextCursor: nextBefore === 0 ? null : Buffer.from(JSON.stringify({ version: 1, actionID, before: nextBefore })).toString("base64url") };
}
