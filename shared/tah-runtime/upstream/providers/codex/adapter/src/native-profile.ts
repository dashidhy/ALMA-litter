import type { FrozenAttemptV1 } from "../../../../src/contract/index.js";
import {
  resolveNativeGrant,
  type NativeAbilityMapping,
} from "../../../../src/guest/adapter-kit/index.js";

const CODEX_ABILITY_MAPPING: NativeAbilityMapping = Object.freeze({
  "prompt.inline_text": Object.freeze({
    settings: Object.freeze({ "input.channel": "turn_text" }),
  }),
  "workspace.entries.list": filesystemReadFragment(),
  "workspace.text.read": filesystemReadFragment(),
  "workspace.text.search": filesystemReadFragment(),
  "workspace.text.write": filesystemWriteFragment(),
  "workspace.text.edit": filesystemWriteFragment(),
  web: Object.freeze({
    tools: Object.freeze(["web_search"]),
    permissions: Object.freeze(["provider_web"]),
  }),
});

const DISABLED_CODEX_FEATURES = Object.freeze([
  "apps",
  "auth_elicitation",
  "agent_message_board",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "code_mode",
  "code_mode_host",
  "code_mode_only",
  "code_mode_prewarm",
  "code_mode_only_strict_3p_tools",
  "code_mode_tool_search",
  "cli_daybreak",
  "chronicle",
  "computer_use",
  "content_item_kinds",
  "context_management",
  "default_mode_request_user_input",
  "fast_mode",
  "goals",
  "guardian_approval",
  "guardianv2",
  "guardian_ext",
  "hooks",
  "image_generation",
  "in_app_browser",
  "in_app_chat",
  "in_app_dictation",
  "in_app_voice",
  "in_app_local_automation",
  "in_app_updates",
  "memories",
  "external_agent_memory_import",
  "mentions_v2",
  "multi_agent",
  "multi_agent_v2",
  "multi_agent_v2_dynamic_tools",
  "multi_agent_mode",
  "enable_fanout",
  "executor_capability_discovery",
  "incremental_tools",
  "plugin_hooks",
  "plugin_sharing",
  "plugins",
  "remote_plugin",
  "remote_control",
  "realtime_conversation",
  "recommended_plugins",
  "shell_snapshot",
  "skill_mcp_dependency_install",
  "skill_search",
  "sleep_tool",
  "send_async_message",
  "send_message_to_user_async",
  "step_model_switching",
  "tool_search",
  "tool_call_mcp_elicitation",
  "tool_suggest",
  "unbounded_connection_retries",
  "ultrafast_mode",
  "view_image",
  "workspace_dependencies",
] as const);

export interface CodexNativeProfileV1 {
  readonly providerID: "codex";
  readonly baseline: "all_disabled";
  readonly modelID: string;
  readonly reasoningEffortID: string | null;
  readonly nativeMechanisms: readonly string[];
  readonly approvalPolicy: "never";
  readonly permissionProfileID: "alma-tah-actor" | "alma-tah-guardian";
  readonly writableRoots: readonly string[];
  readonly runtimeWorkspaceRoots: readonly string[];
  readonly threadConfig: Readonly<Record<string, unknown>>;
  readonly ephemeral: true;
  readonly reasoningSummary: "concise";
}

export function resolveCodexNativeProfile(
  attempt: FrozenAttemptV1,
  guestWorkspaceRoot: string,
): CodexNativeProfileV1 {
  if (attempt.providerID !== "codex") {
    throw new CodexProfileError("provider_mismatch", "Codex Adapter received another Provider");
  }
  if (attempt.inference.contextWindowTokens !== undefined) {
    throw new CodexProfileError("unsupported_context_window", "Codex uses its native default context window");
  }
  assertAbsoluteGuestPath(guestWorkspaceRoot);
  const grant = resolveNativeGrant(attempt.requiredAbilities, CODEX_ABILITY_MAPPING);
  const permissionSet = new Set(grant.permissions);
  const writable = permissionSet.has("workspace_write");
  if (!permissionSet.has("workspace_read")) {
    throw new CodexProfileError("invalid_mapping", "Codex filesystem grant lost read authority");
  }
  if (writable !== (attempt.role === "actor")) {
    throw new CodexProfileError("invalid_mapping", "Codex sandbox mode disagrees with the TAH role");
  }
  const webEnabled = permissionSet.has("provider_web");
  const nativeWritableRoots = Object.freeze(
    attempt.workspace.writableRoots.map((root) => `${guestWorkspaceRoot}/${root}`),
  );
  const permissionProfileID = writable ? "alma-tah-actor" as const : "alma-tah-guardian" as const;
  const features = Object.fromEntries([
    ...DISABLED_CODEX_FEATURES.map((name) => [name, false] as const),
    ["shell_tool", true],
    ["unified_exec", true],
  ]);
  const threadConfig = deepFreeze({
    agents: { enabled: false },
    allow_login_shell: false,
    analytics: { enabled: false },
    feedback: { enabled: false },
    features,
    history: { persistence: "none" },
    hooks: {},
    mcp_servers: {},
    ...(attempt.inference.reasoningEffortID === null
      ? {}
      : { model_reasoning_effort: attempt.inference.reasoningEffortID }),
    model_reasoning_summary: "concise",
    project_doc_max_bytes: 0,
    // A custom profile does not implicitly grant writes to cwd or manufacture
    // builtin .git/.codex carveouts in the root-owned frozen input workspace.
    // Do not mix this with legacy sandbox_mode/sandbox_workspace_write.
    default_permissions: permissionProfileID,
    permissions: {
      [permissionProfileID]: {
        filesystem: {
          ":minimal": "read",
          [guestWorkspaceRoot]: "read",
          "/opt/alma/provider/codex": "read",
          "/opt/alma/bootstrap/busybox": "read",
          "/opt/alma/codex-appliance/native-sandbox-probe.sh": "read",
          "/opt/alma/codex-appliance/native-network-probe.mjs": "read",
          "/opt/alma/node": "read",
          "/run/alma": "deny",
          ...Object.fromEntries(nativeWritableRoots.map((root) => [root, "write"])),
        },
        network: { enabled: false },
      },
    },
    shell_environment_policy: {
      inherit: "none",
      ignore_default_excludes: false,
      set: {
        // Model-controlled commands have a workspace home, not the credential
        // controller home. Never source controller shell startup files.
        HOME: guestWorkspaceRoot,
        BASH_ENV: "/dev/null",
        ENV: "/dev/null",
        SHELL: "/bin/bash",
        PATH: [
          "/opt/alma/provider/codex/codex-path",
          "/opt/alma/provider/codex/codex-resources",
          ...(attempt.role === "actor" ? ["/opt/alma/node/bin"] : []),
          "/usr/bin",
          "/bin",
        ].join(":"),
      },
    },
    show_raw_agent_reasoning: false,
    tools: {
      experimental_request_user_input: { enabled: false },
      ...(webEnabled ? { web_search: {} } : {}),
    },
    web_search: webEnabled ? "live" : "disabled",
  });

  return Object.freeze({
    providerID: "codex",
    baseline: grant.baseline,
    modelID: attempt.inference.modelID,
    reasoningEffortID: attempt.inference.reasoningEffortID,
    nativeMechanisms: Object.freeze([...grant.tools]),
    approvalPolicy: "never",
    permissionProfileID,
    writableRoots: nativeWritableRoots,
    runtimeWorkspaceRoots: Object.freeze([guestWorkspaceRoot]),
    threadConfig,
    ephemeral: true,
    reasoningSummary: "concise",
  });
}

function filesystemReadFragment() {
  return Object.freeze({
    tools: Object.freeze(["apply_patch", "shell_tool", "unified_exec"]),
    permissions: Object.freeze(["workspace_read"]),
  });
}

function filesystemWriteFragment() {
  return Object.freeze({
    tools: Object.freeze(["apply_patch", "shell_tool", "unified_exec"]),
    permissions: Object.freeze(["workspace_read", "workspace_write"]),
  });
}

function assertAbsoluteGuestPath(value: string): void {
  if (
    !value.startsWith("/") ||
    value === "/" ||
    value.endsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.split("/").some((part, index) => index > 0 && (part.length === 0 || part === "." || part === ".."))
  ) {
    throw new CodexProfileError("invalid_workspace", "Codex Guest workspace path is invalid");
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export type CodexProfileErrorCode =
  | "unsupported_context_window"
  | "provider_mismatch"
  | "invalid_mapping"
  | "invalid_workspace";

export class CodexProfileError extends Error {
  public constructor(
    public readonly code: CodexProfileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CodexProfileError";
  }
}
