import {
  assertMatchingProviderControlTerminalV1,
  parseProviderControlRequestV1,
  parseProviderControlTerminalV1,
  type ProviderControlRequestV1,
  type ProviderControlTerminalV1,
} from "./contract.js";
import {
  parseSuperBoxFrame,
  SUPERBOX_WIRE_VERSION,
  type SuperBoxFrameV1,
} from "../superbox/wire.js";

export type ProviderControlSuperBoxPhaseV1 =
  | "awaiting_host_hello"
  | "awaiting_guest_hello"
  | "awaiting_request"
  | "awaiting_start"
  | "awaiting_ready"
  | "running"
  | "awaiting_stopping"
  | "stopping"
  | "violated";

const HOST_FRAMES = new Set<SuperBoxFrameV1["type"]>([
  "host_hello",
  "credential",
  "control_request",
  "start",
  "cancel",
]);
const GUEST_FRAMES = new Set<SuperBoxFrameV1["type"]>([
  "guest_hello",
  "ready",
  "control_result",
  "stopping",
  "fatal",
]);

/** Pure validator for the read-only supporting-operation wire lifecycle. */
export class ProviderControlSuperBoxTranscriptV1 {
  readonly #operationID: string;
  readonly #providerID: string;
  #phase: ProviderControlSuperBoxPhaseV1 = "awaiting_host_hello";
  #request: ProviderControlRequestV1 | undefined;
  #terminal: ProviderControlTerminalV1 | undefined;
  #credentialObserved = false;
  #cancelRequested = false;
  #stoppingObserved = false;
  #destroyed = false;
  #fatalCode: Extract<SuperBoxFrameV1, { type: "fatal" }>["code"] | undefined;

  public constructor(operationID: string, providerID: string) {
    const identity = parseSuperBoxFrame({
      type: "host_hello",
      wireVersion: SUPERBOX_WIRE_VERSION,
      operationID,
      providerID,
      operationKind: "control",
    });
    if (identity.type !== "host_hello") throw new TypeError("Invalid control operation identity");
    this.#operationID = identity.operationID;
    this.#providerID = identity.providerID;
  }

  public get phase(): ProviderControlSuperBoxPhaseV1 {
    return this.#phase;
  }

  public get cancelRequested(): boolean {
    return this.#cancelRequested;
  }

  public get fatalCode(): Extract<SuperBoxFrameV1, { type: "fatal" }>["code"] | undefined {
    return this.#fatalCode;
  }

  public get terminal(): ProviderControlTerminalV1 | undefined {
    return this.#terminal;
  }

  public get completionReady(): boolean {
    return this.#phase !== "violated"
      && this.#terminal !== undefined
      && this.#stoppingObserved
      && this.#destroyed;
  }

  public accept(direction: "host_to_guest" | "guest_to_host", value: unknown): void {
    if (this.#destroyed || this.#phase === "violated") this.#violate();
    const frame = parseSuperBoxFrame(value);
    if (frame.operationID !== this.#operationID) this.#violate();
    const permitted = direction === "host_to_guest" ? HOST_FRAMES : GUEST_FRAMES;
    if (!permitted.has(frame.type)) this.#violate();

    switch (frame.type) {
      case "host_hello":
        this.#require("awaiting_host_hello");
        if (frame.providerID !== this.#providerID || frame.operationKind !== "control") this.#violate();
        this.#phase = "awaiting_guest_hello";
        return;
      case "guest_hello":
        this.#require("awaiting_guest_hello");
        if (frame.providerID !== this.#providerID || frame.operationKind !== "control") this.#violate();
        this.#phase = "awaiting_request";
        return;
      case "credential":
        this.#require("awaiting_request");
        if (this.#credentialObserved) this.#violate();
        this.#credentialObserved = true;
        return;
      case "control_request": {
        this.#require("awaiting_request");
        const request = parseProviderControlRequestV1(frame.request);
        if (request.operationID !== this.#operationID || request.providerID !== this.#providerID) this.#violate();
        this.#request = request;
        this.#phase = "awaiting_start";
        return;
      }
      case "start":
        this.#require("awaiting_start");
        this.#phase = "awaiting_ready";
        return;
      case "cancel":
        if (this.#phase !== "awaiting_ready" && this.#phase !== "running") this.#violate();
        if (this.#cancelRequested) this.#violate();
        this.#cancelRequested = true;
        return;
      case "ready":
        this.#require("awaiting_ready");
        this.#phase = "running";
        return;
      case "control_result": {
        this.#require("running");
        const terminal = parseProviderControlTerminalV1(frame.terminal);
        assertMatchingProviderControlTerminalV1(this.#requiredRequest(), terminal);
        if (this.#cancelRequested && terminal.status === "ok") this.#violate();
        this.#terminal = terminal;
        this.#phase = "awaiting_stopping";
        return;
      }
      case "fatal":
        if (this.#phase !== "awaiting_request"
          && this.#phase !== "awaiting_start"
          && this.#phase !== "awaiting_ready"
          && this.#phase !== "running") this.#violate();
        this.#fatalCode = frame.code;
        this.#phase = "awaiting_stopping";
        return;
      case "stopping":
        this.#require("awaiting_stopping");
        this.#stoppingObserved = true;
        this.#phase = "stopping";
        return;
      case "attempt":
      case "material_chunk":
      case "event":
      case "candidate_entry":
      case "candidate_chunk":
      case "terminal":
        this.#violate();
    }
  }

  public confirmDestroyed(): void {
    this.#destroyed = true;
  }

  #requiredRequest(): ProviderControlRequestV1 {
    if (this.#request === undefined) this.#violate();
    return this.#request;
  }

  #require(phase: ProviderControlSuperBoxPhaseV1): void {
    if (this.#phase !== phase) this.#violate();
  }

  #violate(): never {
    this.#phase = "violated";
    throw new ProviderControlSuperBoxProtocolErrorV1();
  }
}

export class ProviderControlSuperBoxProtocolErrorV1 extends Error {
  public constructor() {
    super("Provider control SuperBox transcript violated its closed protocol");
    this.name = "ProviderControlSuperBoxProtocolErrorV1";
  }
}
