import { z } from "zod";

import {
  attemptTerminalSchema,
  frozenAttemptSchema,
  normalizedEventSchema,
} from "../contract/index.js";
import {
  providerControlRequestSchema,
  providerControlTerminalSchema,
} from "../provider-control/contract.js";

export const SUPERBOX_WIRE_VERSION = 3 as const;
export const SUPERBOX_MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const SUPERBOX_MAX_CHUNK_DECODED_BYTES = 1024 * 1024;
export const SUPERBOX_MAX_CREDENTIAL_DECODED_BYTES = 256 * 1024;
const CREDENTIAL_BINARY_TAG = 0;
const CREDENTIAL_OPERATION_ID_BYTES = 36;
const CREDENTIAL_BINARY_PREFIX_BYTES = 1 + CREDENTIAL_OPERATION_ID_BYTES;

const operationID = z.string().uuid().refine((value) => value === value.toLowerCase());
const providerID = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const operationKind = z.enum(["attempt", "control"]);
const relativePath = z.string().min(1).max(1_024).superRefine((value, context) => {
  if (value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)) {
    context.addIssue({ code: "custom", message: "path must be a portable relative path" });
    return;
  }
  if (value.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    context.addIssue({ code: "custom", message: "path contains an invalid component" });
  }
});
const canonicalBase64 = (maximumDecodedBytes: number, description: string) => z.string()
  .max(Math.ceil(maximumDecodedBytes / 3) * 4)
  .refine(
    (value) => {
      if (value.length % 4 !== 0
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
        return false;
      }
      const decoded = Buffer.from(value, "base64");
      return decoded.byteLength <= maximumDecodedBytes
        && decoded.toString("base64") === value;
    },
    `${description} must use bounded canonical base64`,
  );

const base64Chunk = canonicalBase64(SUPERBOX_MAX_CHUNK_DECODED_BYTES, "chunk");
export const superBoxFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("host_hello"),
    wireVersion: z.literal(SUPERBOX_WIRE_VERSION),
    operationID,
    providerID,
    operationKind,
  }),
  z.strictObject({
    type: z.literal("guest_hello"),
    wireVersion: z.literal(SUPERBOX_WIRE_VERSION),
    operationID,
    providerID,
    operationKind,
  }),
  z.strictObject({ type: z.literal("attempt"), operationID, attempt: frozenAttemptSchema }),
  z.strictObject({
    type: z.literal("control_request"),
    operationID,
    request: providerControlRequestSchema,
  }),
  z.strictObject({
    type: z.literal("material_chunk"),
    operationID,
    relativePath,
    offset: z.number().int().nonnegative(),
    dataBase64: base64Chunk,
    final: z.boolean(),
  }),
  z.strictObject({ type: z.literal("start"), operationID }),
  z.strictObject({ type: z.literal("cancel"), operationID }),
  z.strictObject({ type: z.literal("ready"), operationID }),
  z.strictObject({ type: z.literal("event"), operationID, event: normalizedEventSchema }),
  z.strictObject({
    type: z.literal("candidate_entry"),
    operationID,
    relativePath,
    entryKind: z.enum(["directory", "file"]),
    byteLength: z.number().int().nonnegative().max(64 * 1024 * 1024).nullable(),
  }).superRefine((value, context) => {
    if ((value.entryKind === "directory") !== (value.byteLength === null)) {
      context.addIssue({
        code: "custom",
        path: ["byteLength"],
        message: "candidate directory length must be null and file length must be exact",
      });
    }
  }),
  z.strictObject({
    type: z.literal("candidate_chunk"),
    operationID,
    relativePath,
    offset: z.number().int().nonnegative(),
    dataBase64: base64Chunk,
    final: z.boolean(),
  }),
  z.strictObject({ type: z.literal("terminal"), operationID, terminal: attemptTerminalSchema }),
  z.strictObject({
    type: z.literal("control_result"),
    operationID,
    terminal: providerControlTerminalSchema,
  }),
  z.strictObject({ type: z.literal("stopping"), operationID }),
  z.strictObject({
    type: z.literal("fatal"),
    operationID,
    code: z.enum(["invalid_request", "protocol_violation", "runtime_failed", "cleanup_failed"]),
  }),
]);

export interface SuperBoxCredentialFrameV1 {
  readonly type: "credential";
  readonly operationID: string;
  /** Mutable one-shot bytes. Every owner must clear them in a finally block. */
  readonly data: Uint8Array;
}

export type SuperBoxFrameV1 = z.infer<typeof superBoxFrameSchema> | SuperBoxCredentialFrameV1;

export function parseSuperBoxFrame(value: unknown): SuperBoxFrameV1 {
  if (isCredentialFrameCandidate(value)) {
    const keys = Object.keys(value);
    if (keys.length !== 3 || !keys.includes("type")
      || !keys.includes("operationID") || !keys.includes("data")) {
      throw new SuperBoxWireError("invalid_frame", "Credential frame has extension fields");
    }
    const parsedOperationID = operationID.safeParse(value.operationID);
    if (!parsedOperationID.success
      || !(value.data instanceof Uint8Array)
      || value.data.byteLength === 0
      || value.data.byteLength > SUPERBOX_MAX_CREDENTIAL_DECODED_BYTES) {
      throw new SuperBoxWireError("invalid_frame", "Credential frame is invalid");
    }
    return Object.freeze({
      type: "credential" as const,
      operationID: parsedOperationID.data,
      data: value.data,
    });
  }
  return superBoxFrameSchema.parse(value);
}

export function encodeSuperBoxFrame(frame: SuperBoxFrameV1): Buffer {
  const parsed = parseSuperBoxFrame(frame);
  if (parsed.type === "credential") return encodeCredentialFrame(parsed);
  const payload = Buffer.from(JSON.stringify(parsed), "utf8");
  try {
    if (payload.byteLength === 0 || payload.byteLength > SUPERBOX_MAX_FRAME_BYTES) {
      throw new SuperBoxWireError("frame_size", "SuperBox frame exceeds its byte bound");
    }
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.byteLength);
    return Buffer.concat([header, payload]);
  } finally {
    payload.fill(0);
  }
}

export class SuperBoxFrameDecoder {
  #buffer = Buffer.alloc(0);

  public push(chunk: Uint8Array): readonly SuperBoxFrameV1[] {
    if (chunk.byteLength === 0) return [];
    const input = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const frames: SuperBoxFrameV1[] = [];
    let inputOffset = 0;
    try {
      while (inputOffset < input.byteLength) {
        const targetBytes = this.#targetBufferedBytes();
        const copyBytes = Math.min(
          targetBytes - this.#buffer.byteLength,
          input.byteLength - inputOffset,
        );
        const previous = this.#buffer;
        this.#buffer = Buffer.concat([
          this.#buffer,
          input.subarray(inputOffset, inputOffset + copyBytes),
        ]);
        previous.fill(0);
        inputOffset += copyBytes;
        if (this.#buffer.byteLength < targetBytes) continue;
        if (targetBytes === 4) {
          // Validate the complete header immediately, even when this push ends
          // exactly at byte four and no payload byte has arrived yet.
          this.#targetBufferedBytes();
          continue;
        }
        const complete = this.#buffer;
        try {
          frames.push(this.#parseBufferedFrame());
        } finally {
          complete.fill(0);
          this.#buffer = Buffer.alloc(0);
        }
      }
      return Object.freeze(frames);
    } catch (cause) {
      for (const frame of frames) {
        if (frame.type === "credential") frame.data.fill(0);
      }
      this.#buffer.fill(0);
      this.#buffer = Buffer.alloc(0);
      throw cause;
    }
  }

  public finish(): void {
    if (this.#buffer.byteLength !== 0) {
      this.#buffer.fill(0);
      this.#buffer = Buffer.alloc(0);
      throw new SuperBoxWireError("truncated_frame", "SuperBox stream ended inside a frame");
    }
  }

  #targetBufferedBytes(): number {
    if (this.#buffer.byteLength < 4) return 4;
    const length = this.#buffer.readUInt32BE(0);
    if (length === 0 || length > SUPERBOX_MAX_FRAME_BYTES) {
      throw new SuperBoxWireError("frame_size", "SuperBox frame header is invalid");
    }
    return length + 4;
  }

  #parseBufferedFrame(): SuperBoxFrameV1 {
    const payload = this.#buffer.subarray(4);
    if (payload[0] === CREDENTIAL_BINARY_TAG) return parseCredentialPayload(payload);
    let value: unknown;
    try {
      value = JSON.parse(payload.toString("utf8")) as unknown;
    } catch (cause) {
      throw new SuperBoxWireError("invalid_json", "SuperBox frame is not valid JSON", { cause });
    }
    try {
      return parseSuperBoxFrame(value);
    } catch (cause) {
      throw new SuperBoxWireError("invalid_frame", "SuperBox frame does not match v3", { cause });
    }
  }
}

function encodeCredentialFrame(frame: SuperBoxCredentialFrameV1): Buffer {
  const payloadBytes = CREDENTIAL_BINARY_PREFIX_BYTES + frame.data.byteLength;
  if (payloadBytes > SUPERBOX_MAX_FRAME_BYTES) {
    throw new SuperBoxWireError("frame_size", "Credential frame exceeds its byte bound");
  }
  const encoded = Buffer.alloc(4 + payloadBytes);
  encoded.writeUInt32BE(payloadBytes, 0);
  encoded[4] = CREDENTIAL_BINARY_TAG;
  const operationBytes = Buffer.from(frame.operationID, "ascii");
  try {
    if (operationBytes.byteLength !== CREDENTIAL_OPERATION_ID_BYTES) {
      encoded.fill(0);
      throw new SuperBoxWireError("invalid_frame", "Credential operation identity is invalid");
    }
    operationBytes.copy(encoded, 5);
  } finally {
    operationBytes.fill(0);
  }
  Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength)
    .copy(encoded, 4 + CREDENTIAL_BINARY_PREFIX_BYTES);
  return encoded;
}

function parseCredentialPayload(payload: Buffer): SuperBoxCredentialFrameV1 {
  if (payload.byteLength <= CREDENTIAL_BINARY_PREFIX_BYTES
    || payload.byteLength > CREDENTIAL_BINARY_PREFIX_BYTES
      + SUPERBOX_MAX_CREDENTIAL_DECODED_BYTES) {
    throw new SuperBoxWireError("invalid_frame", "Credential binary payload is invalid");
  }
  const identityBytes = payload.subarray(1, CREDENTIAL_BINARY_PREFIX_BYTES);
  if (identityBytes.some((byte) => byte > 0x7f)) {
    throw new SuperBoxWireError("invalid_frame", "Credential operation identity is invalid");
  }
  const parsedOperationID = operationID.safeParse(identityBytes.toString("ascii"));
  if (!parsedOperationID.success) {
    throw new SuperBoxWireError("invalid_frame", "Credential operation identity is invalid");
  }
  const data = Buffer.from(payload.subarray(CREDENTIAL_BINARY_PREFIX_BYTES));
  try {
    const frame = parseSuperBoxFrame({
      type: "credential",
      operationID: parsedOperationID.data,
      data,
    });
    if (frame.type !== "credential") throw new SuperBoxWireError("invalid_frame", "Credential frame is invalid");
    return frame;
  } catch (cause) {
    data.fill(0);
    throw cause;
  }
}

function isCredentialFrameCandidate(
  value: unknown,
): value is Record<string, unknown> & { readonly type: "credential" } {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Reflect.get(value, "type") === "credential";
}

export type SuperBoxWireErrorCode = "frame_size" | "invalid_json" | "invalid_frame" | "truncated_frame";

export class SuperBoxWireError extends Error {
  public constructor(
    public readonly code: SuperBoxWireErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SuperBoxWireError";
  }
}
