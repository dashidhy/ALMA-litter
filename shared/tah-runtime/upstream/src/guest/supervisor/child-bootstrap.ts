import { writeSync } from "node:fs";
import { createReadStream } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { DedicatedProviderChildEndpointV1 } from "./child-endpoint.js";

/**
 * Trusted generic bootstrap entry. This module deliberately has no Provider
 * import. The sole Provider module path is fixed by appliance composition and
 * dynamically loaded by the child endpoint only after the containment gate.
 */
export async function runDedicatedProviderChildBootstrapV1(
  fixedProviderModulePath: string,
): Promise<void> {
  if (!isAbsolute(fixedProviderModulePath) || fixedProviderModulePath.includes("\0")) {
    throw new TypeError("Dedicated Provider module path must be fixed and absolute");
  }
  const endpoint = new DedicatedProviderChildEndpointV1(
    pathToFileURL(fixedProviderModulePath).href,
    writeStandardOutputExactly,
  );
  const credentialInput = createReadStream("", { fd: 3, autoClose: true });
  const credentialTask = (async () => {
    for await (const chunk of credentialInput) endpoint.pushCredential(asBytes(chunk));
    endpoint.finishCredential();
  })();
  const controlTask = (async () => {
    for await (const chunk of process.stdin) endpoint.pushControl(asBytes(chunk));
    endpoint.finishControl();
  })();
  try {
    await Promise.all([
      credentialTask,
      controlTask,
      endpoint.waitUntilStopped(),
    ]);
  } finally {
    credentialInput.destroy();
    process.stdin.destroy();
  }
}

function writeStandardOutputExactly(bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(
      process.stdout.fd,
      bytes,
      offset,
      bytes.byteLength - offset,
    );
    if (written <= 0) throw new Error("Dedicated Provider output made no progress");
    offset += written;
  }
}

function asBytes(chunk: string | Buffer): Uint8Array {
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

const invokedEntryPath = process.argv[1];
if (invokedEntryPath !== undefined
  && import.meta.url === pathToFileURL(invokedEntryPath).href) {
  const providerModulePath = process.argv[2];
  if (providerModulePath === undefined || process.argv.length !== 3) {
    process.exitCode = 1;
  } else {
    try {
      await runDedicatedProviderChildBootstrapV1(providerModulePath);
    } catch {
      // The internal protocol carries bounded normalized semantics only. Never
      // echo raw exceptions or credential-bearing state to stderr.
      process.exitCode = 1;
    }
  }
}
