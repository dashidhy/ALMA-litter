import { randomUUID } from "node:crypto";
import { AppBridgeError, type AppRuntimeBridge } from "./bridge.js";
import { openServiceSuperBoxTransport } from "./superbox-transport.js";
import { AuthService } from "../auth-prototype/service.js";
import { AuthOperationError, providerIDSchema } from "../auth-prototype/protocol.js";
import { BoundedTahHostOperationSchedulerV1 } from "../host/operation-scheduler.js";
import { runSuperBoxProcessOperationV1, SuperBoxProcessClientError } from "../superbox/process-client.js";
import { TahAttemptExecutionErrorV1, type TahFrameworkAttemptPortV1 } from "../framework/workflow.js";
import { isAppModelAllowed, type AppModelPolicy } from "./model-policy.js";

export interface AppProviderProfile extends AppModelPolicy {
  readonly id: "codex" | "qoder";
  readonly displayName: string;
  readonly authRouteID: string;
  readonly taskRouteID: string;
  readonly guardianModel: string;
  readonly guardianEffort: string;
  readonly profileIdentity: string;
}

export function serviceAttemptPort(bridge: AppRuntimeBridge, auth: AuthService, scheduler: BoundedTahHostOperationSchedulerV1,
  profiles: readonly AppProviderProfile[],
): TahFrameworkAttemptPortV1 {
  return { run: (built, onEvent, signal) => {
    const profile = profiles.find(candidate => candidate.id === built.attempt.providerID);
    if (!profile || !isAppModelAllowed(profile, built.attempt.inference.modelID)) throw new TahAttemptExecutionErrorV1("unavailable");
    const providerID = providerIDSchema.parse(profile.id);
    return scheduler.schedule({ declaredInputBytes: [...built.inputBytes.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0),
      ...(signal === undefined ? {} : { signal }), run: async scheduledSignal => {
        const epoch = auth.identityVersion;
        try {
          const result = await auth.withCredential(providerID, async (bytes, authorizationSignal) => {
            const operationID = randomUUID();
            try {
              const transport = await openServiceSuperBoxTransport(bridge, profile.taskRouteID, operationID);
              return await runSuperBoxProcessOperationV1({ operationID, attempt: built.attempt, materialBytes: built.inputBytes,
                credentialEnvelope: bytes, transport, signal: authorizationSignal, ...(onEvent === undefined ? {} : { onEvent }) });
            } catch (error) {
              if (error instanceof AppBridgeError && error.code === "integrity_locked") throw new AuthOperationError("cleanup");
              if (error instanceof SuperBoxProcessClientError && (["cleanup_failed", "destruction_unconfirmed"].includes(error.code)
                || error.guestFatalCode === "cleanup_failed")) throw new AuthOperationError("cleanup");
              throw error;
            }
          }, scheduledSignal);
          if (result.terminal.kind === "failed" && result.terminal.failure.family === "authentication") {
            void auth.reportAuthenticationInvalid(providerID, epoch).catch(() => {});
          }
          return { terminal: result.terminal, candidateManifest: result.quarantinedCandidateManifest, candidateFiles: result.quarantinedCandidates };
        } catch (error) {
          if (error instanceof AuthOperationError && error.code === "cleanup") throw new TahAttemptExecutionErrorV1("cleanup_unconfirmed");
          if (scheduledSignal.aborted) throw new TahAttemptExecutionErrorV1("cancelled");
          throw new TahAttemptExecutionErrorV1("unavailable");
        }
      } });
  } };
}
