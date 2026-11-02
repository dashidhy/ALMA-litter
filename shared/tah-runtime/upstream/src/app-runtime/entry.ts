import { z } from "zod";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { serveAppRuntime } from "./stdio.js";
import { AppBridgeError } from "./bridge.js";
import { createServiceAuthDriver } from "./auth-driver.js";
import { openServiceSuperBoxTransport } from "./superbox-transport.js";
import { AuthService } from "../auth-prototype/service.js";
import { acquireInternationalAuthStorage } from "./international-auth-storage.js";
import { providerIDSchema } from "../auth-prototype/protocol.js";
import { BoundedTahHostOperationSchedulerV1 } from "../host/operation-scheduler.js";
import { AppActions } from "./actions.js";
import { appAuthSnapshot } from "./auth-projection.js";
import { isAppModelAllowed } from "./model-policy.js";

const providerSchema = z.strictObject({ id: providerIDSchema, displayName: z.string().min(1).max(256),
  authRouteID: z.string().min(1).max(64), taskRouteID: z.string().min(1).max(64),
  guardianModel: z.string().min(1).max(256), guardianEffort: z.string().min(1).max(256),
  allowedModels: z.array(z.string().min(1).max(256)).max(64).optional(),
  disabledModels: z.array(z.string().min(1).max(256)).max(64), profileIdentity: z.string().regex(/^[a-f0-9]{64}$/u) });
const configSchema = z.strictObject({ stateDirectory: z.string().refine(isAbsolute), providers: z.array(providerSchema).min(1).max(2) });
const empty = z.strictObject({});
let auth: AuthService | undefined;
let initialization: Promise<void> | undefined;
let providers: z.infer<typeof providerSchema>[] = [];
const scheduler = new BoundedTahHostOperationSchedulerV1();
let actions: AppActions | undefined;
let loadingActions: Promise<AppActions> | undefined;
const sourceID = randomUUID();
let sourceRevision = 0;

serveAppRuntime(bridge => {
  const required = () => { if (!auth) throw new AppBridgeError("unavailable"); return auth; };
  const snapshot = () => ({ ...appAuthSnapshot(required().snapshot(), providers), sourceID, sourceRevision: ++sourceRevision });
  const actionService = async () => {
    // Concurrent XPC reads must not construct separate workflow schedulers/state.
    loadingActions ??= AppActions.load(bridge, required(), providers, scheduler).then(value => { actions = value; return value; });
    return loadingActions;
  };
  return {
    "action.create": async value => (await actionService()).create(value),
    "action.rename": async value => (await actionService()).rename(value),
    "raw.status": async value => { const input=z.strictObject({materialID:z.uuid()}).parse(value); return (await actionService()).rawSafetyStatus(input.materialID); },
    "raw.check": async value => (await actionService()).checkRawSafety(value),
    "raw.cancel": async value => { const input=z.strictObject({operationID:z.uuid()}).parse(value); return (await actionService()).cancelRawSafety(input.operationID); },
    "action.list": async value => { const input = z.strictObject({ transcriptID: z.uuid(), cursor: z.string().max(512).nullable() }).parse(value); return (await actionService()).list(input.transcriptID, input.cursor); },
    "action.snapshot": async value => { const input = z.strictObject({ actionID: z.uuid() }).parse(value); return (await actionService()).snapshot(input.actionID); },
    "action.reedit": async value => { const input = z.strictObject({actionID: z.uuid(), operationID: z.uuid()}).parse(value); return (await actionService()).reedit(input.actionID, input.operationID); },
    "action.instructionText": async value => { const input = z.strictObject({actionID: z.uuid(), operationID: z.uuid(), offset: z.number().int().nonnegative()}).parse(value); return (await actionService()).instructionText(input.actionID, input.operationID, input.offset); },
    "action.conversation": async value => { const input = z.strictObject({ actionID: z.uuid(), cursor: z.string().max(512).nullable() }).parse(value); return (await actionService()).conversation(input.actionID, input.cursor); },
    "action.conversationText": async value => {
      const input = z.strictObject({ actionID: z.uuid(), position: z.number().int().positive(), offset: z.number().int().nonnegative() }).parse(value);
      return (await actionService()).conversationText(input.actionID, input.position, input.offset);
    },
    "action.workingText": async value => {
      const input = z.strictObject({actionID: z.uuid(), position: z.number().int().positive().nullable(), sha256: z.string().regex(/^[a-f0-9]{64}$/u), offset: z.number().int().nonnegative()}).parse(value);
      return (await actionService()).workingText(input.actionID, input.position, input.sha256, input.offset);
    },
    "action.send": async value => (await actionService()).send(value),
    "action.cancel": async value => { empty.parse(value); await (await actionService()).cancel(); return { cancelled: true }; },
    "action.retry": async value => { const input = z.strictObject({ actionID: z.uuid(), operationID: z.uuid() }).parse(value); return (await actionService()).retry(input.actionID, input.operationID); },
    "action.purge": async value => { const input = z.strictObject({ transcriptID: z.uuid() }).parse(value); return (await actionService()).purge(input.transcriptID); },
    "action.delete": async value => { const input = z.strictObject({ actionID: z.uuid() }).parse(value); return (await actionService()).delete(input.actionID); },
    "action.revokeConsent": async value => { const input = z.strictObject({ providerID: providerIDSchema }).parse(value); return (await actionService()).revokeConsent(input.providerID); },
    "action.retrySave": async value => { const input = z.strictObject({ operationID: z.uuid() }).parse(value); return (await actionService()).retrySave(input.operationID); },
    "action.outcome": async value => {
      const input = z.strictObject({ actionID: z.uuid(), revisionIndex: z.number().int().nonnegative(), path: z.string(), offset: z.number().int().nonnegative() }).parse(value);
      return (await actionService()).outcome(input.actionID, input.revisionIndex, input.path, input.offset);
    },
    "action.transcriptMaterial": async value => {
      const input = z.strictObject({ actionID: z.uuid(), offset: z.number().int().nonnegative() }).parse(value);
      return (await actionService()).transcriptMaterial(input.actionID, input.offset);
    },
    "runtime.inspect": async value => { empty.parse(value); return { protocolVersion: 1, runtime: "tah-v4.2",
      jitless: process.execArgv.includes("--jitless"), nodeVersion: process.versions.node, architecture: process.arch }; },
    "runtime.initialize": async value => {
      if (initialization) throw new AppBridgeError("busy");
      const config = configSchema.parse(value);
      if (new Set(config.providers.map(provider => provider.id)).size !== config.providers.length) throw new AppBridgeError("invalid_request");
      initialization = (async () => {
        const storage = await acquireInternationalAuthStorage(config.stateDirectory);
        providers = config.providers;
        const driver = createServiceAuthDriver(async (providerID, operationID) => {
          const profile = providers.find(provider => provider.id === providerID);
          if (!profile) throw new AppBridgeError("invalid_request");
          return openServiceSuperBoxTransport(bridge, profile.authRouteID, operationID);
        });
        const service = new AuthService(storage, context => scheduler.schedule({ declaredInputBytes: 0, signal: context.signal,
          run: signal => driver({ ...context, signal }) }), (providerID, catalog) => {
          const profile = providers.find(value => value.id === providerID);
          return !!profile && catalog.models.some(model => isAppModelAllowed(profile, model.handle))
            && isAppModelAllowed(profile, profile.guardianModel)
            && catalog.models.some(model => model.handle === profile.guardianModel && model.efforts.some(effort => effort.handle === profile.guardianEffort));
        });
        await service.initialize(); auth = service;
        // A restored credential is not a complete runtime-readiness receipt.
        // Start one background check before exposing this service incarnation.
        if (service.snapshot().state === "valid") await service.inspect();
        service.observe(() => { void bridge.call("ui.auth", snapshot()).catch(() => {}); });
      })();
      await initialization;
      return snapshot();
    },
    "auth.snapshot": async value => { empty.parse(value); return snapshot(); },
    "auth.select": async value => {
      const { providerID } = z.strictObject({ providerID: providerIDSchema }).parse(value);
      if (!providers.some(provider => provider.id === providerID)) throw new AppBridgeError("invalid_request");
      await required().select(providerID); return snapshot();
    },
    "auth.authorize": async value => { empty.parse(value); await required().authorize(); return snapshot(); },
    "auth.inspect": async value => {
      empty.parse(value);
      if (actions?.busy) throw new AppBridgeError("busy");
      await required().inspect(); return snapshot();
    },
    "auth.cancel": async value => { empty.parse(value); await required().cancel(); return snapshot(); },
    "auth.replacement": async value => {
      const input = z.strictObject({ kind: z.enum(["switch_provider", "switch_account", "reauth", "sign_out"]), providerID: providerIDSchema.optional() }).parse(value);
      if (input.providerID && !providers.some(provider => provider.id === input.providerID)) throw new AppBridgeError("invalid_request");
      await required().requestReplacement(input.kind, input.providerID); return snapshot();
    },
    "auth.confirm": async value => {
      const input = z.strictObject({ id: z.uuid(), confirmed: z.boolean() }).parse(value);
      await required().confirmReplacement(input.id, input.confirmed); return snapshot();
    },
    "auth.secret": async value => {
      const input = z.strictObject({ challengeID: z.uuid(), value: z.string().min(1).max(64 * 1024) }).parse(value);
      required().submitSecret(input.challengeID, Buffer.from(input.value)); return snapshot();
    },
    "runtime.shutdown": async value => {
      empty.parse(value); await actions?.close(); await auth?.close(); await scheduler.close(); return { stopped: true };
    },
  };
});
