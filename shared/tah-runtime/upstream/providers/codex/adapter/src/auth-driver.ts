import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  AuthOperationError, cancelled,
  type AuthCatalog, type AuthDriver, type AuthDriverContext, type AuthDriverResult,
} from "../../../../src/auth-prototype/driver.js";
import { catalogSchema } from "../../../../src/auth-prototype/protocol.js";
import { isCodexAuthenticationRPCError } from "./failure.js";
import { CODEX_APP_SERVER_VERSION } from "./receipts.js";
import {
  CodexStdioAppServerFacadeV1, CodexAppServerTransportErrorV1,
  type CodexAppServerConnectionV1, type CodexAppServerFacadeV1,
} from "./process-facade.js";
import { projectCodexAccountUsage } from "./account-usage.js";

const MAX_BYTES = 64 * 1024;
const LOGIN_TIMEOUT_MS = 15 * 60_000;

export interface CodexAuthDriverOptions {
  readonly appServer?: CodexAppServerFacadeV1;
  readonly privateRoot?: string;
  readonly loginTimeoutMs?: number;
}

/** Guest-only device auth; the runtime is never given a thread, turn, or prompt. */
export async function runAuthDriver(context: AuthDriverContext): Promise<AuthDriverResult> {
  return createCodexAuthDriver()(context);
}

export function createCodexAuthDriver(options: CodexAuthDriverOptions = {}): AuthDriver {
  return async (context) => {
    let home: string | undefined;
    let connection: CodexAppServerConnectionV1 | undefined;
    let loginID: string | undefined;
    let result: AuthDriverResult | undefined;
    let failure: unknown;
    try {
      checkAbort(context.signal);
      if (context.providerID !== "codex") throw new AuthOperationError("protocol");
      if (context.kind === "inspect" && context.credential === null) {
        return { state: "invalid", credential: null, account: null, catalog: null, catalogUnavailable: false,
          accountUsage: null, accountUsageUnavailable: false };
      }
      const root = options.privateRoot ?? "/run/alma/auth-home";
      mkdirSync(root, { recursive: true, mode: 0o700 });
      if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new AuthOperationError("protocol");
      home = mkdtempSync(join(root, "codex-auth-"));
      // Force file storage in this fresh Guest home; never consult a user keyring.
      writeFileSync(join(home, "config.toml"), 'cli_auth_credentials_store = "file"\n', { mode: 0o600, flag: "wx" });
      if (context.kind === "inspect") {
        const credential = context.credential!;
        validateCredential(credential);
        writeFileSync(join(home, "auth.json"), credential, { mode: 0o600, flag: "wx" });
      }
      connection = await (options.appServer ?? new CodexStdioAppServerFacadeV1()).start({
        executablePath: "/opt/alma/provider/codex/bin/codex",
        // Auth appliances use ordinary NAT. Omitting controllerProxy makes the
        // existing facade construct a fresh environment with no proxy variables.
        controllerHome: home, workspaceRoot: home,
      });
      checkAbort(context.signal);
      const rpc = (method: string, params: unknown): Promise<unknown> => {
        checkAbort(context.signal);
        return bounded(connection!.request(method, params), context.signal, 60_000);
      };
      const initialized = object(await rpc("initialize", {
        clientInfo: { name: "alma-auth-prototype", title: "ALMA Authorization", version: "1.0.0" },
        capabilities: { experimentalApi: false },
      }));
      if (initialized.codexHome !== home || initialized.platformOs !== "linux"
        || initialized.platformFamily !== "unix" || typeof initialized.userAgent !== "string"
        || !new RegExp(`(?:^|[/ ])${CODEX_APP_SERVER_VERSION.replaceAll(".", "\\.")}(?:$|[ (;])`, "u").test(initialized.userAgent)) {
        throw new AuthOperationError("protocol");
      }
      await bounded(connection.notify("initialized"), context.signal, 60_000);
      if (context.kind === "authenticate") {
        const login = object(await rpc("account/login/start", { type: "chatgptDeviceCode" }));
        if (login.type !== "chatgptDeviceCode" || !isID(login.loginId)) throw new AuthOperationError("protocol");
        loginID = login.loginId;
        if (typeof login.verificationUrl !== "string" || login.verificationUrl.length > 2048
          || !display(login.userCode)) throw new AuthOperationError("protocol");
        let url: URL;
        try { url = new URL(login.verificationUrl); }
        catch { throw new AuthOperationError("protocol"); }
        if (url.origin !== "https://auth.openai.com" || url.username || url.password) throw new AuthOperationError("protocol");
        // Displaying a device challenge requires no secret response. Guest acknowledges it immediately.
        const reply = await bounded(context.challenge({
          kind: "device_code", title: "Authorize Codex", verificationURL: login.verificationUrl,
          userCode: login.userCode as string,
        }).then((reply) => {
          if (context.signal.aborted) { reply?.fill(0); throw cancelled(); }
          return reply;
        }), context.signal, options.loginTimeoutMs ?? LOGIN_TIMEOUT_MS);
        if (reply !== null) {
          reply.fill(0);
          throw new AuthOperationError("protocol");
        }
        await bounded(waitForLogin(connection, loginID), context.signal, options.loginTimeoutMs ?? LOGIN_TIMEOUT_MS);
        loginID = undefined;
      }
      // Managed auth refreshes and persists rotated tokens. A permanent refresh
      // failure makes account null; transient refresh failures retain cached account.
      const receipt = object(await rpc("account/read", { refreshToken: context.kind === "inspect" }));
      if (receipt.requiresOpenaiAuth !== true || !Object.hasOwn(receipt, "account")) throw new AuthOperationError("protocol");
      if (receipt.account === null) {
        if (context.kind === "authenticate") throw new AuthOperationError("auth_invalid");
        result = { state: "invalid", credential: null, account: null, catalog: null, catalogUnavailable: false,
          accountUsage: null, accountUsageUnavailable: false };
      } else {
        const account = object(receipt.account);
        if (account.type !== "chatgpt") throw new AuthOperationError("protocol");
        let catalog: AuthCatalog | null = null;
        try { catalog = await readCatalog(rpc); }
        catch (error) {
          if (isCodexAuthenticationRPCError(error)) throw new AuthOperationError("auth_invalid");
          // Catalog availability is independent of auth and credential rotation.
          if (error instanceof AuthOperationError
            && (error.code === "protocol" || error.code === "auth_invalid")) throw error;
          checkAbort(context.signal);
        }
        let accountUsage = null;
        try { accountUsage = projectCodexAccountUsage(await rpc("account/rateLimits/read", {})); }
        catch { checkAbort(context.signal); }
        result = {
          state: "valid", credential: null, account: display(account.email),
          catalog, catalogUnavailable: catalog === null,
          accountUsage, accountUsageUnavailable: accountUsage === null,
        };
      }
    } catch (error) {
      if (isCodexAuthenticationRPCError(error)
        || (error instanceof AuthOperationError && error.code === "auth_invalid")) {
        if (context.kind === "inspect") {
          result = { state: "invalid", credential: null, account: null, catalog: null, catalogUnavailable: false,
            accountUsage: null, accountUsageUnavailable: false };
        } else failure = new AuthOperationError("auth_invalid");
      } else failure = error;
    }

    let stopped = connection === undefined;
    try {
      if (connection !== undefined) {
        if (loginID !== undefined) {
          // A cancellation receipt is advisory; confirmed process exit is authoritative.
          try { await bounded(connection.request("account/login/cancel", { loginId: loginID }), undefined, 2_000); }
          catch { /* Always continue through close and Guest cleanup. */ }
        }
        const exit = await bounded(connection.close(), undefined, 5_000);
        stopped = true;
        if (exit.code !== 0 && !context.signal.aborted) throw new AuthOperationError("cleanup");
      }
      if (result !== undefined && home !== undefined && !context.signal.aborted) {
        // Read only the credential created/imported in this operation's fresh home,
        // after the runtime has stopped writing it, and before removing that home.
        result = {
          ...result,
          credential: exportCredential(join(home, "auth.json"), { allowMissing: result.state === "invalid" }),
        };
      }
    } catch { failure = new AuthOperationError("cleanup"); }
    finally {
      context.credential?.fill(0);
      if (home !== undefined && stopped) {
        try { rmSync(home, { recursive: true, force: true }); }
        catch { failure = new AuthOperationError("cleanup"); }
      }
    }
    if (failure instanceof AuthOperationError && failure.code === "cleanup") {
      result?.credential?.fill(0);
      throw failure;
    }
    if (context.signal.aborted || (failure instanceof DOMException && failure.name === "AbortError")) {
      result?.credential?.fill(0);
      throw cancelled();
    }
    if (failure !== undefined) {
      result?.credential?.fill(0);
      if (failure instanceof AuthOperationError) throw failure;
      if (failure instanceof CodexAppServerTransportErrorV1 && failure.code === "request_timeout") throw new AuthOperationError("timeout");
      throw new AuthOperationError("unavailable");
    }
    if (result === undefined) throw new AuthOperationError("protocol");
    return result;
  };
}

async function waitForLogin(connection: CodexAppServerConnectionV1, loginID: string): Promise<void> {
  for await (const event of connection.events()) {
    if (event.kind === "server_request") throw new AuthOperationError("protocol");
    if (event.method !== "account/login/completed") continue;
    const completion = object(event.params);
    if (completion.loginId !== loginID) continue;
    if (typeof completion.success !== "boolean") throw new AuthOperationError("protocol");
    if (!completion.success) throw new AuthOperationError("auth_invalid");
    return;
  }
  throw new AuthOperationError("protocol");
}

async function readCatalog(rpc: (method: string, params: unknown) => Promise<unknown>): Promise<AuthCatalog> {
  const models: AuthCatalog["models"] = [];
  let defaultModelHandle: string | null = null;
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let page = 0; page < 16; page++) {
    const data = object(await rpc("model/list", { includeHidden: false, limit: 64, ...(cursor ? { cursor } : {}) }));
    if (!Array.isArray(data.data) || data.data.length > 64) throw new AuthOperationError("protocol");
    for (const item of data.data) {
      const model = object(item);
      const handle = display(model.id ?? model.model);
      if (!handle || model.hidden !== false || !Array.isArray(model.supportedReasoningEfforts)
        || model.supportedReasoningEfforts.length > 16) throw new AuthOperationError("protocol");
      const efforts = model.supportedReasoningEfforts.map((item: unknown) => {
        const handle = display(object(item).reasoningEffort);
        if (!handle) throw new AuthOperationError("protocol");
        return { handle, displayName: handle };
      });
      const defaultEffort = display(model.defaultReasoningEffort);
      if (model.isDefault === true) {
        if (defaultModelHandle !== null) throw new AuthOperationError("protocol");
        defaultModelHandle = handle;
      }
      models.push({
        handle, displayName: display(model.displayName) ?? handle, efforts,
        defaultEffortHandle: efforts.some((effort) => effort.handle === defaultEffort) ? defaultEffort : null,
      });
    }
    if (models.length > 64) throw new AuthOperationError("protocol");
    if (data.nextCursor === null || data.nextCursor === undefined) {
      const parsed = catalogSchema.safeParse({ models, defaultModelHandle });
      if (!parsed.success) throw new AuthOperationError("protocol");
      return parsed.data;
    }
    cursor = display(data.nextCursor);
    if (!cursor || seen.has(cursor)) throw new AuthOperationError("protocol");
    seen.add(cursor);
  }
  throw new AuthOperationError("protocol");
}

function validateCredential(bytes: Uint8Array): void {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) throw new AuthOperationError("protocol");
  try { object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
  catch { throw new AuthOperationError("protocol"); }
}

function exportCredential(path: string, options: { allowMissing: boolean }): Uint8Array | null {
  let descriptor: number;
  try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    // A permanent refresh failure can remove the Guest file. Null means there
    // is no replacement credential; Host retains its binding and records invalid.
    if (options.allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let bytes: Buffer | undefined;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > MAX_BYTES
      || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid())) {
      throw new AuthOperationError("protocol");
    }
    bytes = readFileSync(descriptor);
    if (bytes.byteLength !== stat.size) throw new AuthOperationError("protocol");
    validateCredential(bytes);
    return Uint8Array.from(bytes);
  } finally { bytes?.fill(0); closeSync(descriptor); }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new AuthOperationError("protocol");
  return value as Record<string, unknown>;
}

function display(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
}

function isID(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value);
}

function checkAbort(signal: AbortSignal): void { if (signal.aborted) throw cancelled(); }

async function bounded<T>(work: Promise<T>, signal: AbortSignal | undefined, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort!: () => void;
  const stop = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(cancelled());
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => reject(new AuthOperationError("timeout")), milliseconds);
    if (signal?.aborted) onAbort();
  });
  try { return await Promise.race([work, stop]); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
}
