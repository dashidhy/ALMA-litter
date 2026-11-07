// Official Kimi Code model IDs and effort semantics, verified 2026-10-25:
// https://www.kimi.com/code/docs/en/kimi-code/models
// Intersect with the live account catalog. Never admit arbitrary model spellings:
// the upstream service may otherwise silently route an unknown ID to another model.
const adjustable = Object.freeze(["low", "high", "max"]);
// Common documented context ceiling across the admitted models/standard plans.
// Do not assume the account has the higher-tier 1M entitlement.
export const KIMI_CONTEXT_TOKENS = 262144;
export const KIMI_MODELS = Object.freeze({
  "kimi-for-coding": { name: "Kimi K2.8 Preview", efforts: adjustable },
  "k3-256k": { name: "Kimi K3 (256K)", efforts: adjustable },
  "k3": { name: "Kimi K3", efforts: adjustable },
  "k3.1-pro": { name: "Kimi K3.1 Pro", efforts: adjustable },
  "k3.1-pro-highspeed": { name: "Kimi K3.1 Pro Highspeed (higher quota use)", efforts: adjustable },
  "kimi-for-coding-highspeed": { name: "Kimi K2.7 Code Highspeed (higher quota use)", efforts: Object.freeze(["on"]) },
});
export type KimiModelID = keyof typeof KIMI_MODELS;
export function isKimiModelID(value: string): value is KimiModelID { return Object.hasOwn(KIMI_MODELS, value); }
