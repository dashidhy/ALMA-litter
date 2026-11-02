/** Product model availability; separate from the Provider's full live catalog. */
export interface AppModelPolicy {
  readonly allowedModels?: readonly string[] | undefined;
  readonly disabledModels: readonly string[];
}

export function isAppModelAllowed(policy: AppModelPolicy, modelID: string): boolean {
  return (policy.allowedModels === undefined || policy.allowedModels.includes(modelID))
    && !policy.disabledModels.includes(modelID);
}
