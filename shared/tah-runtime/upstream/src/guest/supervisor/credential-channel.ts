import { SUPERBOX_MAX_CREDENTIAL_DECODED_BYTES } from "../../superbox/wire.js";

export const DEDICATED_PROVIDER_MAX_CREDENTIAL_BYTES =
  SUPERBOX_MAX_CREDENTIAL_DECODED_BYTES;
export const DEDICATED_PROVIDER_CREDENTIAL_HEADER_BYTES = 4;

export type DedicatedProviderCredentialChannelErrorCode =
  | "invalid_input"
  | "invalid_state"
  | "oversize"
  | "trailing_bytes"
  | "truncated";

/**
 * One-shot raw credential encoding for a dedicated pipe.
 *
 * The returned bytes borrow this object's mutable storage. Call `clear()` in
 * the writer's `finally` block after the pipe write has settled; doing so also
 * zeroes every previously provided view. No text or JSON representation is
 * created.
 */
export class DedicatedProviderCredentialEncodingV1 {
  readonly #frame: Buffer;
  #provided = false;
  #cleared = false;

  public constructor(credential: Uint8Array | null) {
    if (credential !== null && !(credential instanceof Uint8Array)) {
      throw new DedicatedProviderCredentialChannelError(
        "invalid_input",
        "Credential must be opaque bytes or null",
      );
    }
    const credentialLength = credential?.byteLength ?? 0;
    if (credential !== null && credentialLength === 0) {
      throw new DedicatedProviderCredentialChannelError(
        "invalid_input",
        "Present credentials must contain at least one byte",
      );
    }
    if (credentialLength > DEDICATED_PROVIDER_MAX_CREDENTIAL_BYTES) {
      throw new DedicatedProviderCredentialChannelError(
        "oversize",
        "Credential exceeds the dedicated pipe bound",
      );
    }

    this.#frame = Buffer.alloc(
      DEDICATED_PROVIDER_CREDENTIAL_HEADER_BYTES + credentialLength,
    );
    this.#frame.writeUInt32BE(credentialLength, 0);
    if (credential !== null) this.#frame.set(credential, DEDICATED_PROVIDER_CREDENTIAL_HEADER_BYTES);
  }

  public get byteLength(): number {
    return this.#frame.byteLength;
  }

  /** Returns one borrowed view; ownership remains with this clearable object. */
  public provide(): Uint8Array {
    if (this.#cleared || this.#provided) {
      throw new DedicatedProviderCredentialChannelError(
        "invalid_state",
        "Credential encoding is no longer available",
      );
    }
    this.#provided = true;
    return new Uint8Array(
      this.#frame.buffer,
      this.#frame.byteOffset,
      this.#frame.byteLength,
    );
  }

  /** Idempotently zeroes the header and all secret payload bytes. */
  public clear(): void {
    this.#frame.fill(0);
    this.#cleared = true;
  }
}

type CredentialDecoderState = "receiving" | "finished" | "consumed" | "cleared" | "violated";

/**
 * Streaming one-shot decoder for the dedicated raw credential pipe.
 *
 * `finish()` represents pipe EOF and must precede `consume()`, so trailing
 * bytes cannot arrive after a credential is accepted. A non-null consumed
 * value is a borrowed view into decoder-owned mutable storage. Call `clear()`
 * after its consumer has finished with it.
 */
export class DedicatedProviderCredentialDecoderV1 {
  readonly #header = Buffer.alloc(DEDICATED_PROVIDER_CREDENTIAL_HEADER_BYTES);
  #headerBytes = 0;
  #expectedPayloadBytes: number | undefined;
  #payload: Buffer | undefined;
  #payloadBytes = 0;
  #state: CredentialDecoderState = "receiving";

  public push(bytes: Uint8Array): void {
    this.#requireReceiving();
    if (!(bytes instanceof Uint8Array)) {
      this.#violation("invalid_input", "Credential pipe must contain raw bytes");
    }
    if (bytes.byteLength === 0) return;

    let offset = 0;
    if (this.#headerBytes < DEDICATED_PROVIDER_CREDENTIAL_HEADER_BYTES) {
      const count = Math.min(
        DEDICATED_PROVIDER_CREDENTIAL_HEADER_BYTES - this.#headerBytes,
        bytes.byteLength,
      );
      this.#header.set(bytes.subarray(0, count), this.#headerBytes);
      this.#headerBytes += count;
      offset += count;
      if (this.#headerBytes === DEDICATED_PROVIDER_CREDENTIAL_HEADER_BYTES) {
        this.#acceptHeader();
      }
    }

    const expected = this.#expectedPayloadBytes;
    if (expected === undefined) return;
    const remainingPayload = expected - this.#payloadBytes;
    const available = bytes.byteLength - offset;
    const count = Math.min(remainingPayload, available);
    if (count > 0) {
      this.#payload!.set(bytes.subarray(offset, offset + count), this.#payloadBytes);
      this.#payloadBytes += count;
      offset += count;
    }
    if (offset !== bytes.byteLength) {
      this.#violation(
        "trailing_bytes",
        "Credential pipe contains bytes after its declared payload",
      );
    }
  }

  /** Marks pipe EOF and verifies that the one declared value is exact. */
  public finish(): void {
    this.#requireReceiving();
    if (this.#headerBytes !== DEDICATED_PROVIDER_CREDENTIAL_HEADER_BYTES
      || this.#expectedPayloadBytes === undefined
      || this.#payloadBytes !== this.#expectedPayloadBytes) {
      this.#violation("truncated", "Credential pipe ended before its declared payload");
    }
    this.#state = "finished";
  }

  /**
   * Consumes the decoded value exactly once. The returned payload is borrowed
   * decoder storage and is zeroed by a subsequent `clear()` call.
   */
  public consume(): Uint8Array | null {
    if (this.#state !== "finished") {
      throw new DedicatedProviderCredentialChannelError(
        "invalid_state",
        "Credential decoder is not ready to consume",
      );
    }
    this.#state = "consumed";
    if (this.#expectedPayloadBytes === 0) return null;
    const payload = this.#payload!;
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }

  /** Idempotently zeroes every decoder-owned mutable buffer. */
  public clear(): void {
    this.#zeroInternalBuffers();
    if (this.#state !== "violated") this.#state = "cleared";
  }

  #acceptHeader(): void {
    const length = this.#header.readUInt32BE(0);
    if (length > DEDICATED_PROVIDER_MAX_CREDENTIAL_BYTES) {
      this.#violation("oversize", "Credential pipe declares an oversized payload");
    }
    this.#expectedPayloadBytes = length;
    this.#payload = Buffer.alloc(length);
  }

  #requireReceiving(): void {
    if (this.#state !== "receiving") {
      throw new DedicatedProviderCredentialChannelError(
        "invalid_state",
        "Credential decoder is one-shot and no longer accepts input",
      );
    }
  }

  #violation(
    code: Exclude<DedicatedProviderCredentialChannelErrorCode, "invalid_state">,
    message: string,
  ): never {
    this.#zeroInternalBuffers();
    this.#state = "violated";
    throw new DedicatedProviderCredentialChannelError(code, message);
  }

  #zeroInternalBuffers(): void {
    this.#header.fill(0);
    this.#payload?.fill(0);
  }
}

export class DedicatedProviderCredentialChannelError extends Error {
  public constructor(
    public readonly code: DedicatedProviderCredentialChannelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DedicatedProviderCredentialChannelError";
  }
}
