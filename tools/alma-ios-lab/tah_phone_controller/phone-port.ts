// Qualification-only USB port. No calls at import time; every subprocess is injectable.
import { execFile } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import type { PhonePort, PhoneBinding, PhoneRequest } from "./controller.js";
import { projectPhonePayload, bindingKey, assertSelection } from "./controller.js";
import { catalogSchema } from "../../../../ALMA/app/TAH/src/auth-prototype/protocol.js";
import { inspectionFailures } from "../../../../ALMA/app/TAH/src/auth-prototype/inspection.js";
import { projectCodexAccountUsage } from "../../../../ALMA/app/TAH/providers/codex/adapter/src/account-usage.js";
import { CodexEventNormalizerV1 } from "../../../../ALMA/app/TAH/providers/codex/adapter/src/event-normalizer.js";
import { resolveCodexNativeProfile } from "../../../../ALMA/app/TAH/providers/codex/adapter/src/native-profile.js";
import type { NormalizedEventV1, TahAttemptResultV1 } from "../../../../ALMA/app/TAH/src/contract/index.js";

let transportLeased = false; // Serialize all instances in this host process through admission.
const BUNDLE = "com.alma.litter.agent-probe";
const UDID = process.env.ALMA_IOS_DEVICE ?? "";
const CLI = new URL("../.cache/device-tools/bin/pymobiledevice3", import.meta.url).pathname;
const sha = (x: string | Uint8Array) => createHash("sha256").update(x).digest("hex");
const hex = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{64}$/u.test(x);
const uuid = (x: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(x);
export class PhonePortError extends Error {
  constructor(public code: string) { super(code); }
}
const need: (ok: unknown, code: string) => asserts ok = (ok, code) => { if (!ok) throw new PhonePortError(code); };
export type RunCommand = (args: string[], timeoutMs: number, signal?: AbortSignal) => Promise<string>;
export const usbCommand: RunCommand = (args, timeout, signal) => new Promise((resolve, reject) => {
  if (!UDID) { reject(new PhonePortError("device_not_configured")); return; }
  const env = { ...process.env, PYMOBILEDEVICE3_UDID: UDID, NO_COLOR: "1" };
  for (const key of ["PYMOBILEDEVICE3_NATIVE", "PYMOBILEDEVICE3_RSD", "PYMOBILEDEVICE3_TUNNEL"]) delete env[key];
  execFile(CLI, args, { timeout, signal, maxBuffer: 4 * 1024 * 1024,
    env }, (error, stdout, stderr) => {
    if (!error) return resolve(stdout);
    const diagnostic = `${stderr} ${error.message}`.toLowerCase(); // Never return CLI bodies.
    const code = /devicelocked|device is locked|passwordprotected/.test(diagnostic) ? "device_locked"
      : /rsd|connectionreset|connectionterminated|broken pipe|incompleteread/.test(diagnostic) ? "rsd_disconnected"
      : /object_not_found|objectnotfound|filenotfound|no such file/.test(diagnostic) ? "status_missing"
      : signal?.aborted ? "cleanup_unconfirmed_cancelled" : "command_failed_or_timed_out";
    reject(new PhonePortError(code));
  });
});
const parse = (text: string) => JSON.parse(text.replace(/\x1b\[[0-9;]*m/gu, "").trim());
function pidOf(value: any): number {
  const ids = new Set<number>();
  const visit = (v: any) => { if (v && typeof v === "object") for (const [key, x] of Object.entries(v)) {
    if ((key === "processIdentifier" || key === "pid") && Number.isSafeInteger(x) && (x as number) > 0) ids.add(x as number);
    else visit(x);
  } };
  visit(value); need(ids.size === 1, "process_identity_unconfirmed"); return [...ids][0]!;
}
function observedBinding(record: any, expectedProfile: string): PhoneBinding {
  const o = record.observation, i = o?.inspection;
  const fingerprint = o?.actualAccountFingerprint ?? o?.identity?.actualAccountFingerprint;
  const failure = typeof o?.failure === "string" && /^[a-z0-9_]{1,80}$/u.test(o.failure) ? o.failure : "unknown";
  need(o?.outcome === "observed", `native_observation_failed_${failure}`);
  need(hex(fingerprint) && record.profileDigest === expectedProfile, "identity_mismatch");
  need(i?.validChatGPT === true && Array.isArray(i.models), "authorization_invalid");
  const defaults = i.models.filter((m: any) => m.isDefault === true);
  need(defaults.length <= 1, "catalog_defaults_invalid");
  const catalog = catalogSchema.parse({ models: i.models.map((m: any) => {
    need(typeof m.id === "string" && typeof m.model === "string" && Array.isArray(m.supportedReasoningEfforts)
      && Array.isArray(m.effortDescriptions), "catalog_shape_invalid");
    need(JSON.stringify(m.supportedReasoningEfforts) === JSON.stringify(m.effortDescriptions.map((e: any) => e.handle)), "catalog_efforts_invalid");
    return { handle: m.model, displayName: m.displayName, efforts: m.effortDescriptions,
      defaultEffortHandle: m.defaultReasoningEffort };
  }), defaultModelHandle: defaults[0]?.model ?? null });
  const accountUsage = projectCodexAccountUsage(i.rawQuotaResponse);
  const failures = inspectionFailures({ state: "valid", credential: null, account: null, catalog,
    catalogUnavailable: false, accountUsage, accountUsageUnavailable: accountUsage === null });
  need(failures.length === 0, "inspection_incomplete");
  return { providerID: "codex", accountFingerprint: fingerprint, profileDigest: expectedProfile, catalog,
    authorization: { state: "valid", phase: "idle", inspecting: false, replacement: null,
      inspection: { id: record.runID, state: "succeeded", startedAt: record.startedAt,
        finishedAt: record.finishedAt, failures } } };
}
export interface PhonePortOptions {
  workRoot: string; profileFile: string; expectedProfileDigest: string;
  command?: RunCommand; sleep?: (ms: number) => Promise<void>;
  executableSuffix?: string;
}
export function createPhonePort(options: PhonePortOptions): PhonePort {
  const run = options.command ?? usbCommand;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const suffix = options.executableSuffix ?? "/AlmaLocalAgentProbe.app/AlmaLocalAgentProbe";
  let busy = false, poisoned = false;
  let pending: { token: object; key: string; binding: PhoneBinding; result: TahAttemptResultV1 } | undefined;
  const attempts = new Set<string>();
  const key = (r: PhoneRequest) => sha(JSON.stringify([r.runID, bindingKey(r.binding), projectPhonePayload(r.built), r.channels]));
  async function operation(request?: PhoneRequest, event?: (e: NormalizedEventV1) => Promise<void>, signal?: AbortSignal) {
    need(!busy && !poisoned && !pending && !transportLeased, "port_busy_or_locked"); busy = true; transportLeased = true;
    const deadline = Date.now() + 240_000;
    const challenge = randomUUID();
    const started = Date.now();
    let launched = false;
    const call = async (args: string[], max = 20_000) => {
      need(!signal?.aborted && Date.now() < deadline, "cleanup_unconfirmed_deadline");
      return run(args, Math.min(max, deadline - Date.now()), signal);
    };
    const core = (name: string, ...args: string[]) => call(["developer", "core-device", name, "--userspace", ...args], 45_000);
    const list = async () => { const p = parse(await core("list-processes")); need(Array.isArray(p), "process_list_invalid");
      p.forEach(pidOf); return p as any[]; };
    const isProbe = (p: any) => JSON.stringify(p).includes(BUNDLE) || JSON.stringify(p).includes(suffix);
    try {
      need(hex(options.expectedProfileDigest), "profile_required");
      const profile = JSON.parse(await fs.readFile(options.profileFile, "utf8"));
      need(profile.digest === options.expectedProfileDigest && profile.inputs?.schema === "alma.phone.qualification-build/v1", "compiled_profile_mismatch");
      await fs.mkdir(options.workRoot, { recursive: true, mode: 0o700 });
      const dir = await fs.mkdtemp(join(options.workRoot, "operation-"));
      need(!(await list()).some(isProbe), "probe_process_already_running");
      if (request) {
        need(uuid(request.runID) && uuid(request.built.attempt.attemptID) && !attempts.has(request.built.attempt.attemptID), "attempt_replay");
        need(request.binding.profileDigest === options.expectedProfileDigest && !request.built.attempt.requiredAbilities.includes("web"), "unsupported_profile_or_web");
        assertSelection(request.binding, request.built.attempt.inference);
        const payload = projectPhonePayload(request.built);
        need(JSON.stringify(payload) === JSON.stringify(request.payload), "payload_changed");
        const inbound = join(dir, "inbound-attempt.json");
        await fs.writeFile(inbound, JSON.stringify({ schema: "alma.phone-attempt/v1", runID: request.runID,
          challenge, expectedAccountFingerprint: request.binding.accountFingerprint,
          profileDigest: options.expectedProfileDigest, ...payload,
          developerInstructions: request.channels.instructions, turnInputText: request.channels.referenceMessage }), { flag: "wx", mode: 0o600 });
        await call(["apps", "push", "--udid", UDID, BUNDLE, inbound, "Documents/inbound-attempt.json"]);
        attempts.add(request.built.attempt.attemptID);
      }
      // No kill-existing, console, installation, native tunnel, or automatic relaunch.
      launched = true;
      const launch = parse(await core("launch-application", "--no-kill-existing", BUNDLE, "--", "--prepare-only",
        request ? "--run-tah-attempt" : "--inspect-tah-auth", "--qualification-run-id", challenge));
      const pid = pidOf(launch);
      let record: any;
      while (Date.now() < deadline) {
        const local = join(dir, `observation-${randomUUID()}.json`);
        try {
          await call(["apps", "pull", "--udid", UDID, BUNDLE, "Documents/tah-observation.json", local]);
          need((await fs.stat(local)).size <= 32 * 1024 * 1024, "observation_too_large");
          const value = JSON.parse(await fs.readFile(local, "utf8"));
          if (value.runID === challenge) { record = value; break; }
          await fs.unlink(local); // Discard only this operation's stale local copy.
        } catch (error) { if (!(error instanceof PhonePortError && error.code === "status_missing")) throw error; }
        await sleep(500);
      }
      need(record?.schema === "alma.phone-observation/v1" && record.pid === pid && record.runID === challenge
        && record.kind === (request ? "attempt" : "inspection") && record.profileDigest === options.expectedProfileDigest
        && record.requiresExternalProcessExitVerification === true, "observation_identity_mismatch");
      const begin = Date.parse(record.startedAt), end = Date.parse(record.finishedAt);
      need(Number.isFinite(begin) && Number.isFinite(end) && begin >= started - 5000 && end >= begin && end <= Date.now() + 5000, "observation_time_mismatch");
      let absent = 0;
      while (absent < 2) {
        const processes = await list();
        const same = processes.find(p => pidOf(p) === pid);
        need(!processes.some(p => isProbe(p) && pidOf(p) !== pid), "unexpected_probe_process");
        if (same) { need(isProbe(same), "pid_reused_or_process_unidentified"); absent = 0; }
        else absent++;
        if (absent < 2) await sleep(500);
      }
      // Success below means confirmed PID absence plus nonce/profile binding, not a measured exit code.
      const binding = observedBinding(record, options.expectedProfileDigest);
      if (!request) return binding;
      need(bindingKey(binding) === bindingKey(request.binding), "account_catalog_changed");
      const o = record.observation, a = request.built.attempt, identity = o.identity;
      for (const [field, value] of Object.entries({ runID: request.runID, challenge, attemptID: a.attemptID,
        attemptSHA256: request.payload.attemptSHA256, role: a.role, profileDigest: options.expectedProfileDigest,
        expectedAccountFingerprint: binding.accountFingerprint, actualAccountFingerprint: binding.accountFingerprint }))
        need(identity?.[field] === value, "attempt_identity_mismatch");
      need(o.quiescenceObserved === true && o.terminal?.status === "completed" && o.terminal.errorPresent === false, "terminal_not_completed");
      const cwd = `/workspace/attempts/${a.attemptID}/view`;
      const thread = o.threadReceipt, turn = o.turnReceipt;
      need(thread?.model === a.inference.modelID && thread.ephemeral === true && thread.cwd === cwd
        && (a.inference.reasoningEffortID === null || thread.reasoningEffort === a.inference.reasoningEffortID)
        && typeof thread.threadID === "string" && thread.threadID.length > 0, "thread_receipt_mismatch");
      need(typeof turn?.turnID === "string" && turn.turnID.length > 0 && turn.status === "inProgress" && turn.errorPresent === false, "turn_receipt_mismatch");
      const destination = join(dir, "afc"); await fs.mkdir(destination);
      await call(["apps", "pull", "--udid", UDID, BUNDLE,
        `Library/Application Support/alma-local-workspace/attempts/${a.attemptID}/view`, destination]);
      const result = await verifySnapshot(request, o.snapshot, join(destination, "view"));
      const events: NormalizedEventV1[] = [];
      const expectation = a.responseExpectation;
      const normalizer = new CodexEventNormalizerV1({ profile: resolveCodexNativeProfile(a, cwd), workspaceRoot: cwd,
        controllerHome: "/__qualification_redaction_only__", threadID: thread.threadID, turnID: turn.turnID,
        maximumFinalBytes: expectation.kind === "workspace_outcome" ? expectation.maximumFinalMessageUTF8Bytes : expectation.maximumUTF8Bytes,
        emit: e => events.push({ ...e, attemptID: a.attemptID, sequence: events.length + 1 } as NormalizedEventV1) });
      need(Array.isArray(o.notifications) && o.notifications.length <= 8192, "notifications_invalid");
      for (const n of o.notifications) { need(n.kind === "notification", "unexpected_server_request"); normalizer.accept(n); }
      const terminal = normalizer.finish();
      need(terminal.kind === "end_turn" && terminal.finalText === o.terminal.finalText, "canonical_final_mismatch");
      for (const e of events) { need(!signal?.aborted && Date.now() < deadline, "cleanup_unconfirmed_deadline"); await event!(e); }
      const token = Object.freeze({});
      pending = { token, key: key(request), binding, result: { ...result, terminal } };
      return token;
    } catch (error) {
      poisoned = true;
      // Never kill an uncertain PID or turn an aborted CLI into successful App cleanup.
      throw new PhonePortError(error instanceof PhonePortError ? error.code : launched ? "cleanup_or_admission_unconfirmed" : "preflight_failed");
    } finally { busy = false; if (!pending) transportLeased = false; }
  }
  return {
    inspect: signal => operation(undefined, undefined, signal) as Promise<PhoneBinding>,
    runFresh: (r, e, signal) => operation(r, e, signal),
    async admitReaped(receipt, request) {
      need(pending && receipt === pending.token && pending.key === key(request), "unrecognized_or_changed_receipt");
      const admitted = pending; pending = undefined; transportLeased = false;
      return { binding: admitted.binding, result: admitted.result };
    },
  };
}
async function verifySnapshot(request: PhoneRequest, snapshot: any, view: string) {
  need(snapshot?.immutableInputsUnchanged === true && Array.isArray(snapshot.candidateEntries)
    && snapshot.candidateEntries.length <= 512, "snapshot_invalid");
  const actual = new Map<string, Buffer | null>();
  let total = 0;
  async function walk(path: string, relative = "", depth = 0) {
    need(depth <= 32 && actual.size <= 1024, "physical_tree_limit");
    for (const entry of await fs.readdir(path, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      need(!entry.isSymbolicLink() && !/[\x00-\x1f\\]/u.test(rel), "physical_type_invalid");
      if (entry.isDirectory()) { actual.set(rel, null); await walk(join(path, entry.name), rel, depth + 1); }
      else {
        need(entry.isFile(), "physical_type_invalid");
        const size = (await fs.stat(join(path, entry.name))).size; total += size;
        need(size <= 16 * 1024 * 1024 && total <= 68 * 1024 * 1024, "physical_byte_limit");
        actual.set(rel, await fs.readFile(join(path, entry.name)));
      }
    }
  }
  await walk(view);
  const expected = new Map<string, Buffer | null>();
  const add = (path: string, bytes: Buffer | null) => {
    need(path.split("/").every(p => p && p !== "." && p !== "..") && !path.includes("\\"), "snapshot_path_invalid");
    need(!expected.has(path), "snapshot_duplicate"); expected.set(path, bytes);
  };
  for (const m of request.built.attempt.workspace.materials) add(m.relativePath, Buffer.from(request.built.inputBytes.get(m.relativePath)!));
  const roots = request.built.attempt.workspace.writableRoots;
  const candidateManifest: TahAttemptResultV1["candidateManifest"][number][] = [];
  const candidateFiles = new Map<string, Uint8Array>(); let candidateBytes = 0;
  for (const entry of snapshot.candidateEntries) {
    need(roots.some(root => entry.relativePath === root || entry.relativePath.startsWith(`${root}/`)), "candidate_outside_scope");
    if (entry.kind === "directory") { need(entry.byteLength === null, "directory_metadata_invalid"); add(entry.relativePath, null); }
    else {
      need(entry.kind === "file" && typeof entry.base64 === "string" && hex(entry.sha256), "candidate_invalid");
      const bytes = Buffer.from(entry.base64, "base64"); candidateBytes += bytes.length;
      need(bytes.toString("base64") === entry.base64 && bytes.length === entry.byteLength && sha(bytes) === entry.sha256 && candidateBytes <= 4 * 1024 * 1024, "candidate_digest_invalid");
      add(entry.relativePath, bytes); candidateFiles.set(entry.relativePath, bytes);
    }
    if (!roots.includes(entry.relativePath)) candidateManifest.push({ relativePath: entry.relativePath, kind: entry.kind, byteLength: entry.byteLength });
  }
  need(candidateBytes === snapshot.totalCandidateBytes && roots.every(root => expected.get(root) === null), "candidate_total_or_root_invalid");
  for (const path of [...expected.keys()]) {
    const parts = path.split("/"); parts.pop();
    while (parts.length) { const parent = parts.join("/"); need(!expected.has(parent) || expected.get(parent) === null, "tree_collision"); expected.set(parent, null); parts.pop(); }
  }
  need(actual.size === expected.size, "physical_snapshot_not_exact");
  for (const [path, bytes] of expected) {
    const observed = actual.get(path);
    need(bytes === null ? observed === null : observed instanceof Buffer && observed.equals(bytes), "physical_snapshot_mismatch");
  }
  candidateManifest.sort((a, b) => Buffer.compare(Buffer.from(a.relativePath), Buffer.from(b.relativePath)));
  return { candidateManifest, candidateFiles };
}
