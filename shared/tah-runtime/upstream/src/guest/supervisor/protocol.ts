import { z } from "zod";

import {
  attemptTerminalSchema,
  frozenAttemptSchema,
  normalizedEventSchema,
} from "../../contract/index.js";
import type { GuestNormalizedEventInputV1 } from "../runtime/adapter.js";
import {
  providerControlRequestSchema,
  providerControlTerminalSchema,
} from "../../provider-control/contract.js";

export const DEDICATED_PROVIDER_PROTOCOL_VERSION = 2 as const;
export const DEDICATED_PROVIDER_MAX_FRAME_BYTES = 2 * 1024 * 1024;

const normalizedEventInputSchema = z.unknown().transform((value, context) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.hasOwn(value, "attemptID") || Object.hasOwn(value, "sequence")) {
    context.addIssue({
      code: "custom",
      message: "internal event must omit the outer event envelope",
    });
    return z.NEVER;
  }
  const parsed = normalizedEventSchema.safeParse({
    ...value,
    attemptID: "internal",
    sequence: 1,
  });
  if (!parsed.success) {
    context.addIssue({
      code: "custom",
      message: "internal event does not match the normalized event contract",
    });
    return z.NEVER;
  }
  const { attemptID: _, sequence: __, ...input } = parsed.data;
  return input as GuestNormalizedEventInputV1;
});

export const dedicatedProviderFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("bootstrap_ready"),
    protocolVersion: z.literal(DEDICATED_PROVIDER_PROTOCOL_VERSION),
  }),
  z.strictObject({
    type: z.literal("bootstrap_inputs_ready"),
    protocolVersion: z.literal(DEDICATED_PROVIDER_PROTOCOL_VERSION),
  }),
  z.strictObject({
    type: z.literal("start"),
    protocolVersion: z.literal(DEDICATED_PROVIDER_PROTOCOL_VERSION),
    attempt: frozenAttemptSchema,
  }),
  z.strictObject({
    type: z.literal("start_control"),
    protocolVersion: z.literal(DEDICATED_PROVIDER_PROTOCOL_VERSION),
    request: providerControlRequestSchema,
  }),
  z.strictObject({ type: z.literal("cancel") }),
  z.strictObject({ type: z.literal("event"), event: normalizedEventInputSchema }),
  z.strictObject({
    type: z.literal("provisional_terminal"),
    terminal: attemptTerminalSchema,
  }),
  z.strictObject({
    type: z.literal("provisional_control_result"),
    terminal: providerControlTerminalSchema,
  }),
]);

export type DedicatedProviderFrameV1 = z.infer<typeof dedicatedProviderFrameSchema>;

export function parseDedicatedProviderFrameV1(value: unknown): DedicatedProviderFrameV1 {
  return dedicatedProviderFrameSchema.parse(value);
}

export function encodeDedicatedProviderFrameV1(frame: DedicatedProviderFrameV1): Buffer {
  const payload = Buffer.from(
    JSON.stringify(parseDedicatedProviderFrameV1(frame)),
    "utf8",
  );
  if (payload.byteLength === 0 || payload.byteLength > DEDICATED_PROVIDER_MAX_FRAME_BYTES) {
    throw new DedicatedProviderProtocolError("frame_size", "Provider frame exceeds its byte bound");
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.byteLength);
  return Buffer.concat([header, payload]);
}

export class DedicatedProviderFrameDecoderV1 {
  #buffer = Buffer.alloc(0);

  public push(bytes: Uint8Array): readonly DedicatedProviderFrameV1[] {
    if (!(bytes instanceof Uint8Array)) {
      throw new DedicatedProviderProtocolError("invalid_frame", "Provider output must contain bytes");
    }
    if (bytes.byteLength === 0) return [];
    const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const frames: DedicatedProviderFrameV1[] = [];
    let inputOffset = 0;
    while (inputOffset < input.byteLength) {
      const target = this.#targetBytes();
      const count = Math.min(
        target - this.#buffer.byteLength,
        input.byteLength - inputOffset,
      );
      this.#buffer = Buffer.concat([
        this.#buffer,
        input.subarray(inputOffset, inputOffset + count),
      ]);
      inputOffset += count;
      if (this.#buffer.byteLength < target) continue;
      if (target === 4) {
        this.#targetBytes();
        continue;
      }
      frames.push(this.#parseBufferedFrame());
      this.#buffer = Buffer.alloc(0);
    }
    return Object.freeze(frames);
  }

  public finish(): void {
    if (this.#buffer.byteLength !== 0) {
      throw new DedicatedProviderProtocolError(
        "truncated_frame",
        "Provider output ended inside a frame",
      );
    }
  }

  #targetBytes(): number {
    if (this.#buffer.byteLength < 4) return 4;
    const length = this.#buffer.readUInt32BE(0);
    if (length === 0 || length > DEDICATED_PROVIDER_MAX_FRAME_BYTES) {
      throw new DedicatedProviderProtocolError("frame_size", "Provider frame header is invalid");
    }
    return length + 4;
  }

  #parseBufferedFrame(): DedicatedProviderFrameV1 {
    let value: unknown;
    try {
      value = JSON.parse(this.#buffer.subarray(4).toString("utf8")) as unknown;
    } catch (cause) {
      throw new DedicatedProviderProtocolError(
        "invalid_json",
        "Provider frame is not valid JSON",
        { cause },
      );
    }
    try {
      return parseDedicatedProviderFrameV1(value);
    } catch (cause) {
      throw new DedicatedProviderProtocolError(
        "invalid_frame",
        "Provider frame does not match the closed internal protocol",
        { cause },
      );
    }
  }
}

export type DedicatedProviderProtocolErrorCode =
  | "frame_size"
  | "invalid_json"
  | "invalid_frame"
  | "truncated_frame";

export class DedicatedProviderProtocolError extends Error {
  public constructor(
    public readonly code: DedicatedProviderProtocolErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DedicatedProviderProtocolError";
  }
}
