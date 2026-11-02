import { createHash, randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

import {
  parseFrozenAttempt,
  type FrozenAttemptV1,
} from "../../../../src/contract/index.js";

export const CODEX_SANDBOX_QUALIFICATION_CONTRACT_ID =
  "codex_superbox/native-sandbox-qualification-v2" as const;
export const CODEX_SANDBOX_QUALIFICATION_INPUT_PATH =
  "inbox/raw-transcript.md" as const;
export const CODEX_SANDBOX_QUALIFICATION_INPUT_TEXT =
  "ALMA-CODEX-SANDBOX-INPUT-V1\n" as const;
export const CODEX_SANDBOX_QUALIFICATION_WRITABLE_ROOT =
  "outbox/revision_v0" as const;
export const CODEX_SANDBOX_QUALIFICATION_POSITIVE_PATH =
  "outbox/revision_v0/native-positive-control.txt" as const;
export const CODEX_SANDBOX_QUALIFICATION_POSITIVE_TEXT =
  "ALMA-CODEX-SANDBOX-POSITIVE-V1\n" as const;
export const CODEX_SANDBOX_QUALIFICATION_RECEIPT_PATH =
  "outbox/revision_v0/native-sandbox-machine-receipt.json" as const;
export const CODEX_SANDBOX_QUALIFICATION_COMMAND =
  "/opt/alma/codex-appliance/native-sandbox-probe.sh" as const;
export const CODEX_SANDBOX_QUALIFICATION_PASS_OUTPUT =
  "ALMA_CODEX_NATIVE_SANDBOX_PROBE_V2:PASS\n" as const;

const MAX_NATIVE_ITEM_ID_UTF8_BYTES = 128;

export interface CodexNativeCommandMachineReceiptV1 {
  readonly nativeItemID: string;
  readonly command: typeof CODEX_SANDBOX_QUALIFICATION_COMMAND;
  readonly invocation: string;
  readonly cwd: string;
  readonly startedStatus: "inProgress";
  readonly completedStatus: "completed";
  readonly exitCode: 0;
  readonly aggregatedOutputSHA256: string;
}

export interface CodexNativeSandboxMachineReceiptV1 {
  readonly schemaVersion: 2;
  readonly providerID: "codex";
  readonly evidenceSource: "app_server_native_command_lifecycle";
  readonly attemptID: string;
  readonly frozenAttemptSHA256: string;
  readonly frozenInput: Readonly<{
    relativePath: typeof CODEX_SANDBOX_QUALIFICATION_INPUT_PATH;
    byteLength: number;
    sha256: string;
  }>;
  readonly authRemovedBeforePrompt: true;
  readonly nativeSandbox: Readonly<{
    policy: "alma-tah-actor";
    networkAccess: false;
  }>;
  readonly commandLifecycle: CodexNativeCommandMachineReceiptV1;
  readonly sealedProbeAssertions: readonly [
    "frozen_input_read_positive",
    "declared_outbox_write_positive",
    "credential_path_unreadable",
    "controller_canary_unreadable",
    "controller_symlink_escape_denied",
    "controller_proc_unobservable",
    "controller_proxy_env_absent",
    "frozen_input_mutation_denied",
    "outside_writable_root_denied",
    "direct_inet_socket_denied",
  ];
  readonly unexpectedNativeToolCount: 0;
}

export interface CodexNativeToolLifecycleObserverV1 {
  acceptStarted(item: Readonly<Record<string, unknown>>): void;
  acceptCompleted(item: Readonly<Record<string, unknown>>): void;
  finish(inputBytes: Uint8Array): CodexNativeSandboxMachineReceiptV1;
}

export function buildCodexNativeSandboxQualificationAttemptV1(params: {
  readonly attemptID: string;
  readonly modelID: string;
  readonly reasoningEffortID: string;
}): Readonly<{
  attempt: FrozenAttemptV1;
  inputBytes: ReadonlyMap<string, Uint8Array>;
}> {
  const input = Buffer.from(CODEX_SANDBOX_QUALIFICATION_INPUT_TEXT, "utf8");
  const attempt = parseFrozenAttempt({
    contractVersion: 1,
    attemptID: params.attemptID,
    providerID: "codex",
    role: "actor",
    inference: {
      modelID: params.modelID,
      reasoningEffortID: params.reasoningEffortID,
    },
    prompt: qualificationPrompt(),
    workspace: {
      materials: [{
        relativePath: CODEX_SANDBOX_QUALIFICATION_INPUT_PATH,
        mediaType: "text/plain",
        byteLength: input.byteLength,
        sha256: sha256(input),
      }],
      candidateSeeds: [],
      writableRoots: [CODEX_SANDBOX_QUALIFICATION_WRITABLE_ROOT],
    },
    responseExpectation: {
      kind: "workspace_outcome",
      contractID: CODEX_SANDBOX_QUALIFICATION_CONTRACT_ID,
      maximumFinalMessageUTF8Bytes: 4_096,
    },
    requiredAbilities: [
      "prompt.inline_text",
      "workspace.entries.list",
      "workspace.text.read",
      "workspace.text.search",
      "workspace.text.write",
      "workspace.text.edit",
    ],
  });
  return Object.freeze({
    attempt,
    inputBytes: new Map([[CODEX_SANDBOX_QUALIFICATION_INPUT_PATH, input]]),
  });
}

export function createCodexNativeSandboxQualificationObserverV1(
  attempt: FrozenAttemptV1,
  workspaceRoot: string,
): CodexNativeToolLifecycleObserverV1 | null {
  if (attempt.responseExpectation.kind !== "workspace_outcome"
    || attempt.responseExpectation.contractID !== CODEX_SANDBOX_QUALIFICATION_CONTRACT_ID) {
    return null;
  }
  assertExactQualificationAttempt(attempt);
  return new MachineObserver(attempt, workspaceRoot);
}

export function encodeCodexNativeSandboxMachineReceiptV1(
  receipt: CodexNativeSandboxMachineReceiptV1,
): Buffer {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

export function verifyCodexNativeSandboxMachineReceiptV1(
  value: unknown,
  attempt: FrozenAttemptV1,
  inputBytes: Uint8Array,
  workspaceRoot = "/workspace/attempt",
): CodexNativeSandboxMachineReceiptV1 {
  assertExactQualificationAttempt(attempt);
  const receipt = record(value, "machine receipt");
  const command = record(receipt.commandLifecycle, "command lifecycle");
  const frozenInput = record(receipt.frozenInput, "frozen input");
  const expectedAssertions = sealedAssertions();
  if (receipt.schemaVersion !== 2
    || receipt.providerID !== "codex"
    || receipt.evidenceSource !== "app_server_native_command_lifecycle"
    || receipt.attemptID !== attempt.attemptID
    || receipt.frozenAttemptSHA256 !== digestFrozenAttempt(attempt)
    || receipt.authRemovedBeforePrompt !== true
    || receipt.unexpectedNativeToolCount !== 0
    || JSON.stringify(receipt.nativeSandbox) !== JSON.stringify({
      policy: "alma-tah-actor",
      networkAccess: false,
    })
    || frozenInput.relativePath !== CODEX_SANDBOX_QUALIFICATION_INPUT_PATH
    || frozenInput.byteLength !== inputBytes.byteLength
    || frozenInput.sha256 !== sha256(inputBytes)
    || !Array.isArray(receipt.sealedProbeAssertions)
    || JSON.stringify(receipt.sealedProbeAssertions) !== JSON.stringify(expectedAssertions)
    || !validNativeItemID(command.nativeItemID)
    || command.command !== CODEX_SANDBOX_QUALIFICATION_COMMAND
    || !isCodexQualificationInvocationV1(command.invocation)
    || command.cwd !== workspaceRoot
    || command.startedStatus !== "inProgress"
    || command.completedStatus !== "completed"
    || command.exitCode !== 0
    || command.aggregatedOutputSHA256 !== sha256(Buffer.from(
      CODEX_SANDBOX_QUALIFICATION_PASS_OUTPUT,
      "utf8",
    ))) {
    throw new CodexSandboxQualificationError("Codex native-sandbox machine receipt is invalid");
  }
  return value as CodexNativeSandboxMachineReceiptV1;
}

class MachineObserver implements CodexNativeToolLifecycleObserverV1 {
  readonly #attempt: FrozenAttemptV1;
  readonly #workspaceRoot: string;
  #started: Readonly<{ nativeItemID: string; command: string; cwd: string }> | undefined;
  #completed: CodexNativeCommandMachineReceiptV1 | undefined;

  public constructor(attempt: FrozenAttemptV1, workspaceRoot: string) {
    this.#attempt = attempt;
    this.#workspaceRoot = workspaceRoot;
  }

  public acceptStarted(item: Readonly<Record<string, unknown>>): void {
    if (this.#started !== undefined || item.type !== "commandExecution") {
      throw new CodexSandboxQualificationError(
        "Codex qualification emitted an unexpected native tool",
      );
    }
    const nativeItemID = text(item.id, "native item ID");
    const command = text(item.command, "native command");
    const cwd = text(item.cwd, "native cwd");
    if (!validNativeItemID(nativeItemID)
      || !isCodexQualificationInvocationV1(command)
      || cwd !== this.#workspaceRoot
      || item.status !== "inProgress") {
      throw new CodexSandboxQualificationError(
        `Codex qualification native command start is not exact (id=${validNativeItemID(nativeItemID)}, command=${isCodexQualificationInvocationV1(command)}, cwd=${cwd === this.#workspaceRoot}, status=${item.status === "inProgress"})`,
      );
    }
    this.#started = Object.freeze({ nativeItemID, command, cwd });
  }

  public acceptCompleted(item: Readonly<Record<string, unknown>>): void {
    const started = this.#started;
    if (started === undefined || this.#completed !== undefined || item.type !== "commandExecution") {
      throw new CodexSandboxQualificationError(
        "Codex qualification native command completion is out of order",
      );
    }
    const output = text(item.aggregatedOutput, "native command output");
    const canonicalOutput = canonicalCodexQualificationOutputV1(output);
    if (item.id !== started.nativeItemID
      || item.command !== started.command
      || item.cwd !== started.cwd
      || item.status !== "completed"
      || item.exitCode !== 0
      || canonicalOutput === null) {
      throw new CodexSandboxQualificationError(
        `Codex qualification native command did not prove containment (exit=${Number.isSafeInteger(item.exitCode) ? item.exitCode : "unknown"}, id=${item.id === started.nativeItemID}, command=${item.command === started.command}, cwd=${item.cwd === started.cwd}, status=${item.status === "completed"}, outputBytes=${Buffer.byteLength(output)}, outputShape=${qualificationOutputShape(output)})`,
      );
    }
    this.#completed = Object.freeze({
      nativeItemID: started.nativeItemID,
      command: CODEX_SANDBOX_QUALIFICATION_COMMAND,
      invocation: started.command,
      cwd: started.cwd,
      startedStatus: "inProgress",
      completedStatus: "completed",
      exitCode: 0,
      // Hash the exact one-line payload, not variable native timing/chunk metadata.
      aggregatedOutputSHA256: sha256(Buffer.from(canonicalOutput, "utf8")),
    });
  }

  public finish(inputBytes: Uint8Array): CodexNativeSandboxMachineReceiptV1 {
    if (this.#completed === undefined
      || inputBytes.byteLength !== Buffer.byteLength(CODEX_SANDBOX_QUALIFICATION_INPUT_TEXT, "utf8")
      || sha256(inputBytes) !== this.#attempt.workspace.materials[0]?.sha256) {
      throw new CodexSandboxQualificationError(
        "Codex qualification lacks complete machine evidence",
      );
    }
    return Object.freeze({
      schemaVersion: 2,
      providerID: "codex",
      evidenceSource: "app_server_native_command_lifecycle",
      attemptID: this.#attempt.attemptID,
      frozenAttemptSHA256: digestFrozenAttempt(this.#attempt),
      frozenInput: Object.freeze({
        relativePath: CODEX_SANDBOX_QUALIFICATION_INPUT_PATH,
        byteLength: inputBytes.byteLength,
        sha256: sha256(inputBytes),
      }),
      authRemovedBeforePrompt: true,
      nativeSandbox: Object.freeze({ policy: "alma-tah-actor", networkAccess: false }),
      commandLifecycle: this.#completed,
      sealedProbeAssertions: sealedAssertions(),
      unexpectedNativeToolCount: 0,
    });
  }
}

function assertExactQualificationAttempt(attempt: FrozenAttemptV1): void {
  const rebuilt = buildCodexNativeSandboxQualificationAttemptV1({
    attemptID: attempt.attemptID,
    modelID: attempt.inference.modelID,
    reasoningEffortID: attempt.inference.reasoningEffortID ?? "",
  }).attempt;
  if (attempt.inference.reasoningEffortID === null
    || JSON.stringify(attempt) !== JSON.stringify(rebuilt)) {
    throw new CodexSandboxQualificationError(
      "Codex native-sandbox qualification attempt is not exact",
    );
  }
}

function qualificationPrompt(): readonly [{ readonly authority: "tah_instruction"; readonly text: string }] {
  return Object.freeze([Object.freeze({
    authority: "tah_instruction" as const,
    text: [
      "This is a sealed ALMA Codex native-sandbox machine qualification.",
      "Invoke the native shell tool exactly once with exactly this command and no wrapper:",
      CODEX_SANDBOX_QUALIFICATION_COMMAND,
      "Do not invoke any other command, file-change, Web, MCP, subagent, or tool.",
      "Do not create or edit files yourself; the sealed probe owns its positive-control output.",
      "After the command completes, respond with one short plain-text completion sentence.",
    ].join("\n"),
  })]);
}

function sealedAssertions(): CodexNativeSandboxMachineReceiptV1["sealedProbeAssertions"] {
  return Object.freeze([
    "frozen_input_read_positive",
    "declared_outbox_write_positive",
    "credential_path_unreadable",
    "controller_canary_unreadable",
    "controller_symlink_escape_denied",
    "controller_proc_unobservable",
    "controller_proxy_env_absent",
    "frozen_input_mutation_denied",
    "outside_writable_root_denied",
    "direct_inet_socket_denied",
  ] as const);
}

function digestFrozenAttempt(attempt: FrozenAttemptV1): string {
  return sha256(Buffer.from(JSON.stringify(parseFrozenAttempt(attempt)), "utf8"));
}

function validNativeItemID(value: unknown): value is string {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") <= MAX_NATIVE_ITEM_ID_UTF8_BYTES
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CodexSandboxQualificationError(`Codex ${label} is malformed`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new CodexSandboxQualificationError(`Codex ${label} is malformed`);
  }
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class CodexSandboxQualificationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CodexSandboxQualificationError";
  }
}

/** Fixed fixture in the already-validated private controller home; no real secret is a canary. */
export function prepareCodexNativeSandboxFixtureV1(controllerHome: string): () => void {
  const path = `${controllerHome}/qualification-canary.txt`;
  const marker = `ALMA_CANARY_${randomUUID()}`;
  writeFileSync(path, marker, {flag: "wx", mode: 0o600});
  return () => {
    try {
      if (readFileSync(path, "utf8") !== marker) throw new CodexSandboxQualificationError("Controller canary changed");
    } finally { unlinkSync(path); }
  };
}

/** Exact argv display forms emitted by native execution; never parse arbitrary shell syntax. */
export function isCodexQualificationInvocationV1(value: unknown): value is string {
  if (value === CODEX_SANDBOX_QUALIFICATION_COMMAND) return true;
  for (const shell of ["/bin/sh", "/bin/bash", "/bin/zsh", "/usr/bin/bash", "/usr/bin/zsh",
    "/opt/alma/provider/codex/codex-resources/zsh/bin/zsh"]) {
    for (const argument of [CODEX_SANDBOX_QUALIFICATION_COMMAND, `'${CODEX_SANDBOX_QUALIFICATION_COMMAND}'`, `"${CODEX_SANDBOX_QUALIFICATION_COMMAND}"`]) {
      if (value === `${shell} -c ${argument}`) return true;
    }
  }
  return false;
}

/** The sealed script emits one line; any non-whitespace extra output is a failure. */
export function canonicalCodexQualificationOutputV1(value: string): string | null {
  return value.trim() === CODEX_SANDBOX_QUALIFICATION_PASS_OUTPUT.trim()
    ? CODEX_SANDBOX_QUALIFICATION_PASS_OUTPUT : null;
}

function qualificationOutputShape(value: string): string {
  try {
    const object: unknown = JSON.parse(value);
    if (typeof object === "object" && object !== null && !Array.isArray(object)) {
      return `json:${Object.keys(object).map((key) => ["output", "stdout", "stderr", "exitCode", "exit_code", "wall_time_seconds", "success", "code", "process_id", "session_id", "chunk_id"].includes(key) ? key : "other").slice(0, 12).join("/")}`;
    }
  } catch { /* only report a closed shape, never native output text */ }
  return value.split("\n").slice(0, 12).map((line) => {
    if (line.trim() === CODEX_SANDBOX_QUALIFICATION_PASS_OUTPUT.trim()) return "pass";
    if (!line.trim()) return "blank";
    const prefix = ["Chunk ID:", "Wall time:", "Process exited with code", "Exit code:", "Final output:", "Output:"].find((part) => line.startsWith(part));
    const words = (line.match(/[A-Za-z_]+/gu) ?? []).filter((word) => [
      "bash", "zsh", "sh", "Warning", "warning", "cannot", "can", "not", "No", "such", "file", "directory",
      "Failed", "failed", "Permission", "denied", "set", "locale", "setlocale", "LC_ALL", "LANG", "en_US", "UTF", "C",
      "bwrap", "sandbox", "Operation", "permitted", "job", "control", "terminal", "process", "group", "enable", "network",
      "timeout", "Temporary", "read", "write", "Path", "outside", "ignored", "inherited", "stdin", "pipe", "change",
    ].includes(word)).slice(0, 16).join(" ");
    const target = [".bashrc", ".bash_profile", ".bash_logout", "/etc/profile", ".profile", "/dev/fd", "/dev/tty",
      "codex-controller-home", "provider-bootstrap", "raw-transcript.md", "outside-sandbox-probe"].find((part) => line.includes(part)) ?? "unspecified";
    return prefix ?? `other(${line.length};${words};${target})`;
  }).join("/");
}
