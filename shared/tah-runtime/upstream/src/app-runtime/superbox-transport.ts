import { z } from "zod";
import { AppBridgeError, type AppRuntimeBridge } from "./bridge.js";
import type { SuperBoxDuplexChildTransportV1, SuperBoxProcessExitReceiptV1 } from "../superbox/process-client.js";

const exitSchema = z.strictObject({ exitCode: z.number().int().nullable(), destroyed: z.boolean() });
const chunkSchema = z.strictObject({ data: z.string().max(87384).nullable() });
const MAX_CHUNK = 64 * 1024;

/** Swift owns the VM; Node retains the shared Guest protocol validator unchanged. */
export async function openServiceSuperBoxTransport(
  bridge: AppRuntimeBridge, routeID: string, operationID: string,
): Promise<SuperBoxDuplexChildTransportV1> {
  z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/u).parse(routeID);
  z.uuid().parse(operationID);
  z.strictObject({ opened: z.literal(true) }).parse(await bridge.call("vm.open", { routeID, operationID }));
  let receipt: SuperBoxProcessExitReceiptV1 | undefined;
  let exitPromise: Promise<SuperBoxProcessExitReceiptV1> | undefined;
  let reading = false;
  return {
    stdout: {
      async *[Symbol.asyncIterator]() {
        if (reading) throw new AppBridgeError("invalid_request");
        reading = true;
        while (true) {
          const { data } = chunkSchema.parse(await bridge.call("vm.read", { operationID }));
          if (data === null) return;
          const bytes = Buffer.from(data, "base64");
          if (bytes.length === 0 || bytes.length > MAX_CHUNK || bytes.toString("base64") !== data) {
            throw new AppBridgeError("invalid_request");
          }
          yield bytes;
        }
      },
    },
    async write(bytes) {
      if (receipt !== undefined || bytes.byteLength === 0) throw new AppBridgeError("invalid_request");
      for (let offset = 0; offset < bytes.byteLength; offset += MAX_CHUNK) {
        await bridge.call("vm.write", { operationID, data: Buffer.from(bytes.subarray(offset, offset + MAX_CHUNK)).toString("base64") });
      }
    },
    closeInput() {
      if (receipt === undefined) throw new AppBridgeError("invalid_request");
    },
    async destroy() { await bridge.call("vm.destroy", { operationID }); },
    waitForExit() {
      exitPromise ??= bridge.call("vm.wait", { operationID }).then(value => {
        receipt = exitSchema.parse(value);
        return receipt;
      });
      return exitPromise;
    },
  };
}
