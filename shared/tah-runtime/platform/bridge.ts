import { AppBridgeError } from '../upstream/src/app-runtime/bridge.js';
declare const __almaPlatformCall: (method: string, value: unknown) => Promise<unknown>;

export async function nativeCall<T = unknown>(method: string, value: unknown): Promise<T> {
  try { return await __almaPlatformCall(method, value) as T; }
  catch (error) {
    const code = (error as {code?: string})?.code;
    if (code && ['unavailable','invalid_request','busy','cancelled','integrity_locked'].includes(code)) {
      throw new AppBridgeError(code as ConstructorParameters<typeof AppBridgeError>[0]);
    }
    throw error;
  }
}
