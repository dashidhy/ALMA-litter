import { AppRuntimeBridge, type AppBridgeHandler } from "./bridge.js";

/** No socket, HTTP server, environment-based backend selection, or runtime installation. */
export function serveAppRuntime(handlers: (bridge: AppRuntimeBridge) => Readonly<Record<string, AppBridgeHandler>>): AppRuntimeBridge {
  const table: Record<string, AppBridgeHandler> = Object.create(null) as Record<string, AppBridgeHandler>;
  const bridge = new AppRuntimeBridge(bytes => new Promise((resolve, reject) => {
    process.stdout.write(bytes, error => error ? reject(error) : resolve());
  }), table, () => { process.stdin.destroy(); process.exitCode = 1; });
  Object.assign(table, handlers(bridge));
  process.stdin.on("data", (bytes: Buffer) => { try { bridge.push(bytes); } catch { bridge.close(); } });
  process.stdin.on("end", () => bridge.close());
  process.stdin.on("error", () => bridge.close());
  process.stdout.on("error", () => bridge.close());
  process.once("SIGTERM", () => { bridge.close(); });
  return bridge;
}
