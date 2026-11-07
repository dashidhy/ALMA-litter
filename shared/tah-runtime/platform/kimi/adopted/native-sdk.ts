import type { NativeApproval } from "./policy.js";

/** Narrow, version-pinned native SDK surface. The bundle is inside the Guest image only. */
export interface KimiSession {
  setApprovalHandler(handler: (request: NativeApproval) => Promise<{ decision: "approved" | "rejected" }>): void;
  setQuestionHandler(handler: () => null): void;
  reloadSession(): Promise<{ agents: Record<string, NativeAgent> }>;
  onEvent(handler: (event: NativeEvent) => void): unknown;
  prompt(text: string, options: { promptId: string }): Promise<unknown>;
  cancel(): Promise<unknown>;
  close(): Promise<void>;
}
export interface NativeAgent {
  type: string;
  tools: { name: string; active: boolean }[];
  permission: { rules: { pattern: string; decision: string; scope: string }[] };
  config: { systemPrompt: string; modelAlias: string; thinkingEffort: string };
}
export interface NativeEvent { readonly type: string; readonly [name: string]: unknown }
export interface KimiHarness {
  createSession(options: {workDir: string; model: string; permission: "manual"; thinking: string}): Promise<KimiSession>;
  close(): Promise<void>;
}
export interface KimiSDK {
  createKimiHarness(options: { homeDir: string; configPath: string;
    identity: {productName: string; version: string; platform: string}; skillDirs: string[];
    telemetry: { track(): void; flush(): Promise<void> }; uiCapabilities: string[] }): KimiHarness;
}
