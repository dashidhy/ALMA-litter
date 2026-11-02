import { createHash, type Hash } from "node:crypto";

import {
  TAH_MAX_TOTAL_MATERIAL_BYTES,
  type FrozenAttemptV1,
} from "../contract/index.js";
import { parseSuperBoxFrame } from "./wire.js";

export const SUPERBOX_MAX_TOTAL_MATERIAL_BYTES = TAH_MAX_TOTAL_MATERIAL_BYTES;

interface MaterialState {
  readonly expectedBytes: number;
  readonly expectedSHA256: string;
  readonly hash: Hash;
  readonly chunks: Buffer[];
  receivedBytes: number;
  completed: boolean;
}

export class SuperBoxMaterialReceiverV1 {
  readonly #operationID: string;
  readonly #materials = new Map<string, MaterialState>();
  #state: "active" | "completed" | "violated" = "active";

  public constructor(operationID: string, attempt: FrozenAttemptV1) {
    if (operationID.length === 0) throw new TypeError("operation ID must not be empty");
    const declarations = [
      ...attempt.workspace.materials,
      ...attempt.workspace.candidateSeeds.filter((seed) => seed.kind === "file"),
    ];
    const declaredBytes = declarations.reduce(
      (total, material) => total + material.byteLength,
      0,
    );
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > SUPERBOX_MAX_TOTAL_MATERIAL_BYTES) {
      throw new SuperBoxMaterialError("material_limit", "declared material bytes exceed the operation bound");
    }
    this.#operationID = operationID;
    for (const material of declarations) {
      this.#materials.set(material.relativePath, {
        expectedBytes: material.byteLength,
        expectedSHA256: material.sha256,
        hash: createHash("sha256"),
        chunks: [],
        receivedBytes: 0,
        completed: false,
      });
    }
  }

  public get state(): "active" | "completed" | "violated" {
    return this.#state;
  }

  public accept(value: unknown): void {
    this.#requireActive();
    let frame: ReturnType<typeof parseSuperBoxFrame>;
    try {
      frame = parseSuperBoxFrame(value);
    } catch {
      this.#violation("material frame does not match the closed wire schema");
    }
    if (frame.type !== "material_chunk") this.#violation("frame is not an input material chunk");
    if (frame.operationID !== this.#operationID) this.#violation("material belongs to another operation");
    const material = this.#materials.get(frame.relativePath);
    if (material === undefined) this.#violation("material path was not declared by the frozen attempt");
    if (material.completed) this.#violation("material received data after its final chunk");
    if (frame.offset !== material.receivedBytes) this.#violation("material chunk offset is not contiguous");

    const bytes = Buffer.from(frame.dataBase64, "base64");
    const nextBytes = material.receivedBytes + bytes.byteLength;
    if (nextBytes > material.expectedBytes) this.#violation("material exceeds its declared byte length");
    material.hash.update(bytes);
    material.chunks.push(bytes);
    material.receivedBytes = nextBytes;

    if (frame.final) {
      if (material.receivedBytes !== material.expectedBytes) {
        this.#violation("material final chunk does not reach its declared byte length");
      }
      if (material.hash.digest("hex") !== material.expectedSHA256) {
        this.#violation("material bytes do not match the frozen digest");
      }
      material.completed = true;
    }
  }

  public finish(): void {
    this.#requireActive();
    if ([...this.#materials.values()].some((material) => !material.completed)) {
      this.#violation("operation started before every frozen material completed");
    }
    this.#state = "completed";
  }

  public read(relativePath: string): Buffer {
    if (this.#state !== "completed") {
      throw new SuperBoxMaterialError("invalid_state", "material is unavailable before completion");
    }
    const material = this.#materials.get(relativePath);
    if (material === undefined) {
      throw new SuperBoxMaterialError("unknown_material", "material path was not declared");
    }
    return Buffer.concat(material.chunks);
  }

  #requireActive(): void {
    if (this.#state !== "active") this.#violation("material receiver is no longer active");
  }

  #violation(message: string): never {
    this.#state = "violated";
    for (const material of this.#materials.values()) {
      for (const chunk of material.chunks) chunk.fill(0);
      material.chunks.length = 0;
    }
    throw new SuperBoxMaterialError("protocol_violation", message);
  }
}

export type SuperBoxMaterialErrorCode =
  | "material_limit"
  | "protocol_violation"
  | "invalid_state"
  | "unknown_material";

export class SuperBoxMaterialError extends Error {
  public constructor(
    public readonly code: SuperBoxMaterialErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SuperBoxMaterialError";
  }
}
