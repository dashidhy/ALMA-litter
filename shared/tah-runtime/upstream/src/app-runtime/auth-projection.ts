import type { AuthSnapshot } from "../auth-prototype/service.js";
import { isAppModelAllowed, type AppModelPolicy } from "./model-policy.js";

export function appAuthSnapshot(value: AuthSnapshot, profiles: readonly (AppModelPolicy & { id: string; displayName: string })[]) {
  const providers = profiles.map(({ id, displayName }) => ({ id, displayName }));
  const profile = profiles.find(provider => provider.id === value.providerID);
  if (value.providerID !== null && !profile) {
    // Preserve the private vault until explicit replacement; absence from the
    // signed bundle is not evidence that the user's credential was revoked.
    return { ...value, providers, providerID: value.state === "unauthed" ? null : value.providerID,
      state: value.state === "unauthed" ? "unauthed" as const : "unsupported" as const, catalog: null, actorCatalog: null,
      accountUsage: null, accountUsageUnavailable: true,
      noticeCode: "provider_not_in_build" };
  }
  const models = value.catalog?.models.filter(model => profile && isAppModelAllowed(profile, model.handle));
  const actorCatalog = value.catalog && models?.length ? { models,
    defaultModelHandle: models.some(model => model.handle === value.catalog!.defaultModelHandle)
      ? value.catalog.defaultModelHandle : models[0]!.handle } : null;
  // Settings and the composer must show the same supported models. The Auth
  // service retains its original catalog for internal capability validation.
  return { ...value, providers, actorCatalog,
    catalog: profile?.allowedModels === undefined ? value.catalog : actorCatalog };
}
