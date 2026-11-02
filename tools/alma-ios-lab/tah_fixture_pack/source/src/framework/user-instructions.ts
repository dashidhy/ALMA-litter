export interface UserRevisionInstructionV1 {
  readonly revisionIndex: number;
  readonly initial: string | null;
  readonly retries: readonly string[];
}

export type UserInstructionLedgerV1 = readonly UserRevisionInstructionV1[];

export const EXTRA_INSTRUCTIONS_HEADER = "# Extra Instructions" as const;
const MAX_INSTRUCTION_BYTES = 64 * 1024;
const MAX_LEDGER_BYTES = 1024 * 1024;

export function appendUserRevisionInstructionV1(
  ledger: UserInstructionLedgerV1,
  revisionIndex: number,
  instruction: string,
): UserInstructionLedgerV1 {
  validateLedgerShape(ledger);
  if (!Number.isSafeInteger(revisionIndex) || revisionIndex < 0 || revisionIndex !== ledger.length) {
    throw new UserInstructionError("Revision instruction index is not the next logical revision");
  }
  const normalized = normalizeInstruction(instruction);
  if (revisionIndex > 0 && normalized === null) {
    throw new UserInstructionError("A later revision requires a non-empty instruction");
  }
  return freezeLedger([
    ...ledger,
    { revisionIndex, initial: normalized, retries: [] },
  ]);
}

export function appendUserRetryInstructionV1(
  ledger: UserInstructionLedgerV1,
  revisionIndex: number,
  instruction: string,
): UserInstructionLedgerV1 {
  validateLedgerShape(ledger);
  if (revisionIndex < 0 || ledger.at(-1)?.revisionIndex !== revisionIndex) {
    throw new UserInstructionError("Retry must belong to the current logical revision");
  }
  const normalized = normalizeInstruction(instruction);
  if (normalized === null) throw new UserInstructionError("Retry instruction must not be empty");
  return freezeLedger(ledger.map((entry) => entry.revisionIndex === revisionIndex
    ? { ...entry, retries: [...entry.retries, normalized] }
    : entry));
}

export function renderUserInstructionLedgerV1(ledger: UserInstructionLedgerV1): string {
  validateLedgerShape(ledger);
  const sections = ledger.map((entry) => {
    const body = entry.initial === null ? "N/A" : quoteInstruction(entry.initial);
    const retries = entry.retries.flatMap((retry, index) => [
      "",
      `### Retry instruction ${index + 1}`,
      "",
      quoteInstruction(retry),
    ]);
    return [
      `## revision v${entry.revisionIndex}`,
      "",
      body,
      ...retries,
    ].join("\n");
  });
  const result = `${EXTRA_INSTRUCTIONS_HEADER}\n\n${sections.join("\n\n")}\n`;
  if (Buffer.byteLength(result, "utf8") > MAX_LEDGER_BYTES) {
    throw new UserInstructionError("Extra Instructions ledger exceeds its byte bound");
  }
  return result;
}

function quoteInstruction(value: string): string {
  return value.split("\n").map((line) => `> ${line}`).join("\n");
}

function normalizeInstruction(value: string): string | null {
  if (typeof value !== "string" || /[\u0000\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new UserInstructionError("User instruction contains forbidden control data");
  }
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
  if (normalized.length === 0) return null;
  if (Buffer.byteLength(normalized, "utf8") > MAX_INSTRUCTION_BYTES) {
    throw new UserInstructionError("User instruction exceeds its byte bound");
  }
  return normalized;
}

function validateLedgerShape(ledger: UserInstructionLedgerV1): void {
  if (!Array.isArray(ledger)) throw new UserInstructionError("Instruction ledger is invalid");
  for (let index = 0; index < ledger.length; index += 1) {
    const entry = ledger[index];
    if (entry === undefined || entry.revisionIndex !== index
      || (entry.initial !== null && normalizeInstruction(entry.initial) !== entry.initial)
      || !Array.isArray(entry.retries)
      || entry.retries.some((retry: string) => normalizeInstruction(retry) !== retry)) {
      throw new UserInstructionError("Instruction ledger is not canonical");
    }
    if (index > 0 && entry.initial === null) {
      throw new UserInstructionError("Later revision instruction is empty");
    }
  }
}

function freezeLedger(entries: readonly UserRevisionInstructionV1[]): UserInstructionLedgerV1 {
  const frozen = entries.map((entry) => Object.freeze({
    revisionIndex: entry.revisionIndex,
    initial: entry.initial,
    retries: Object.freeze([...entry.retries]),
  }));
  return Object.freeze(frozen);
}

export class UserInstructionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UserInstructionError";
  }
}
