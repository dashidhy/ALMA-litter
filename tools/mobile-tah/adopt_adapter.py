"""Generate reviewed mobile seams around the original Codex Adapter algorithm.
No framework, role ordering, prompt, or normalized event logic is rewritten.
"""
from pathlib import Path
import hashlib,json,difflib
root=Path(__file__).resolve().parents[2]/'shared/tah-runtime'
source=root/'upstream/providers/codex/adapter/src/guest-adapter.ts'
s=source.read_text(); original=s
s=s.replace('"../../../../src/','"../../upstream/src/').replace('"./','"../../upstream/providers/codex/adapter/src/')
def change(before,after):
 global s
 if s.count(before)!=1: raise ValueError('Adapter seam drift: '+before[:100])
 s=s.replace(before,after)
change('export interface CodexGuestAdapterOptionsV1 {','''export interface MobileCodexAuthPort {
  readonly home: string;
  install(credential: import("../../upstream/src/guest/runtime/adapter.js").GuestOpaqueCredentialHandleV1 | null): Promise<void>;
  verifyBeforeTurn(): Promise<void>;
  removeBeforeTurn(): Promise<void>;
  removeAfterProcessExit(): Promise<void>;
}
export interface CodexGuestAdapterOptionsV1 {
  readonly auth: MobileCodexAuthPort;
  readonly requiresRemoteControlStatus: boolean;
  readonly resolveProfile: typeof resolveCodexNativeProfile;
  readonly assertRuntimeReceipt: typeof assertInitializeReceipt;
  readonly assertClosed: (receipt: unknown) => void;''')
change('readonly #auth: CodexAuthMaterialGuardV1;','readonly #auth: MobileCodexAuthPort;\n  readonly #options: CodexGuestAdapterOptionsV1;')
change('''    this.#auth = new CodexAuthMaterialGuardV1(
      options.controllerHome ?? CODEX_CONTROLLER_HOME,
      options.workspaceRoot,
    );''','''    this.#options = options;
    this.#auth = options.auth;
    if (!options.appServer) throw new TypeError("Mobile Provider backend is required");''')
change('if (!remoteControlDisabled) throw startupRemoteControlFailure();','if (this.#options.requiresRemoteControlStatus && !remoteControlDisabled) throw startupRemoteControlFailure();')
change('const profile = resolveCodexNativeProfile(context.attempt, this.#workspaceRoot);','const profile = this.#options.resolveProfile(context.attempt, this.#workspaceRoot);')
change('assertInitializeReceipt(initialize, this.#auth.home);','this.#options.assertRuntimeReceipt(initialize, this.#auth.home);')
for method in ['install(context.credential)','verifyBeforeTurn()','removeBeforeTurn()']:
 change('this.#auth.'+method+';','await this.#auth.'+method+';')
s=s.replace('this.#auth.removeAfterProcessExit();','await this.#auth.removeAfterProcessExit();')
change('if (receipt.code !== 0) throw new Error("Codex app-server exited unsuccessfully");','this.#options.assertClosed(receipt);')
change('      if (event.method === "account/updated") {','      if (event.method === "account/login/completed") {\n        if (params.success !== true || params.loginId != null || params.error != null) throw codexAuthenticationFailure();\n        continue;\n      }\n      if (event.method === "account/updated") {')
s=s.replace('params.authMode !== \"chatgpt\" && params.authMode !== \"apikey\"', 'params.authMode !== \"chatgpt\" && params.authMode !== \"apikey\" && params.authMode !== \"chatgptAuthTokens\"')
s=s.replace('/** One-operation Codex Adapter intended to run inside a fresh SuperBox Guest. */','/** Original Codex Adapter with explicit mobile transport/auth/lifecycle seams. See adaptation.json. */')
output=root/'platform/codex/guest-adapter.ts';output.parent.mkdir(parents=True,exist_ok=True);output.write_text(s)
(root/'platform/codex/adaptation.patch').write_text(''.join(difflib.unified_diff(original.splitlines(True),s.splitlines(True),fromfile='Mac/guest-adapter.ts',tofile='Mobile/guest-adapter.ts')))
(root/'platform/codex/adaptation.json').write_text(json.dumps({'sourceSHA256':hashlib.sha256(original.encode()).hexdigest(),'adaptedSHA256':hashlib.sha256(s.encode()).hexdigest(),'seams':['import location','native opaque auth lifecycle (async)','in-process transport has no remote-control service/status notification; unexpected enablement still rejected','required injected App Server facade','iOS 0.166 initialize receipt verification','explicit iOS native profile resolver','in-process quiescence receipt instead of fabricated process exit'],'unchanged':['request ordering','prompt projection','model/effort receipt checks','native event normalization','terminal resolution','cancellation order']},indent=2)+'\n')
print('mobile Codex Adapter adopted with explicit platform seams')

receipt_source=root/'upstream/providers/codex/adapter/src/receipts.ts'
receipt_original=receipt_source.read_text()
receipt=receipt_original.replace('"./failure.js"','"../../upstream/providers/codex/adapter/src/failure.js"').replace('"./native-profile.js"','"../../upstream/providers/codex/adapter/src/native-profile.js"').replace('"0.163.0"','"0.166.0"').replace('receipt.platformOs !== "linux"','receipt.platformOs !== "ios"').replace('pinned Linux appliance','pinned iOS runtime')
receipt=receipt.replace('sameLegacyProjection(receipt.sandbox, profile.writableRoots)','sameLegacyProjection(receipt.sandbox, (profile as CodexNativeProfileV1 & { runtimeWritableRoots?: readonly string[] }).runtimeWritableRoots ?? profile.writableRoots)')
(root/'platform/codex/receipts.ts').write_text(receipt)
(root/'platform/codex/receipts.patch').write_text(''.join(difflib.unified_diff(receipt_original.splitlines(True),receipt.splitlines(True),fromfile='Mac/receipts.ts',tofile='Mobile/receipts.ts')))

normalizer_source=root/'upstream/providers/codex/adapter/src/event-normalizer.ts'
normalizer_original=normalizer_source.read_text()
normalizer=normalizer_original.replace('"../../../../src/','"../../upstream/src/').replace('"./','"../../upstream/providers/codex/adapter/src/').replace('params.authMode !== "chatgpt" && params.authMode !== "apikey"','params.authMode !== "chatgpt" && params.authMode !== "apikey" && params.authMode !== "chatgptAuthTokens"')
(root/'platform/codex/event-normalizer.ts').write_text(normalizer)
(root/'platform/codex/event-normalizer.patch').write_text(''.join(difflib.unified_diff(normalizer_original.splitlines(True),normalizer.splitlines(True),fromfile='Mac/event-normalizer.ts',tofile='Mobile/event-normalizer.ts')))
