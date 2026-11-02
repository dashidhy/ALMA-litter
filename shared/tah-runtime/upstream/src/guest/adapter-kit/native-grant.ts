import {
  canonicalAbilities,
  type TahAbilityID,
} from "../../contract/abilities.js";
import {
  compareCanonicalUTF8V1,
  isCanonicalUTF8V1,
} from "../../contract/canonical-order.js";

export type NativeSettingValue = string | number | boolean | null;

export interface NativeGrantFragment {
  readonly tools?: readonly string[];
  readonly permissions?: readonly string[];
  readonly settings?: Readonly<Record<string, NativeSettingValue>>;
}

export type NativeAbilityMapping = Readonly<
  Partial<Record<TahAbilityID, NativeGrantFragment>>
>;

export interface ResolvedNativeGrant {
  readonly baseline: "all_disabled";
  readonly coveredAbilities: readonly TahAbilityID[];
  readonly tools: readonly string[];
  readonly permissions: readonly string[];
  readonly settings: Readonly<Record<string, NativeSettingValue>>;
}

export type NativeGrantResolutionCode =
  | "missing_mapping"
  | "conflicting_mapping"
  | "invalid_mapping";

export class NativeGrantResolutionError extends Error {
  public constructor(
    public readonly code: NativeGrantResolutionCode,
    message: string,
  ) {
    super(message);
    this.name = "NativeGrantResolutionError";
  }
}

export function resolveNativeGrant(
  requiredAbilities: readonly TahAbilityID[],
  mapping: NativeAbilityMapping,
): ResolvedNativeGrant {
  const abilities = canonicalAbilities(requiredAbilities);
  const tools = new Set<string>();
  const permissions = new Set<string>();
  const settings = new Map<string, NativeSettingValue>();

  for (const ability of abilities) {
    const fragment = mapping[ability];
    if (fragment === undefined) {
      throw new NativeGrantResolutionError(
        "missing_mapping",
        `No native mapping covers ${ability}`,
      );
    }
    const fragmentTools = fragment.tools ?? [];
    const fragmentPermissions = fragment.permissions ?? [];
    const fragmentSettings = Object.entries(fragment.settings ?? {});
    if (
      fragmentTools.length === 0 &&
      fragmentPermissions.length === 0 &&
      fragmentSettings.length === 0
    ) {
      throw new NativeGrantResolutionError(
        "invalid_mapping",
        `Native mapping for ${ability} grants nothing`,
      );
    }
    addNames(tools, fragmentTools, `${ability} tool`);
    addNames(permissions, fragmentPermissions, `${ability} permission`);
    for (const [key, value] of fragmentSettings) {
      assertName(key, `${ability} setting`);
      const existing = settings.get(key);
      if (existing !== undefined || settings.has(key)) {
        if (!Object.is(existing, value)) {
          throw new NativeGrantResolutionError(
            "conflicting_mapping",
            `Native setting ${key} conflicts while covering ${ability}`,
          );
        }
      } else {
        settings.set(key, value);
      }
    }
  }

  return Object.freeze({
    baseline: "all_disabled",
    coveredAbilities: abilities,
    tools: Object.freeze([...tools].sort(compareCanonicalUTF8V1)),
    permissions: Object.freeze([...permissions].sort(compareCanonicalUTF8V1)),
    settings: Object.freeze(Object.fromEntries([...settings].sort(([left], [right]) =>
      compareCanonicalUTF8V1(left, right)
    ))),
  });
}

function addNames(target: Set<string>, values: readonly string[], description: string): void {
  for (const value of values) {
    assertName(value, description);
    target.add(value);
  }
}

function assertName(value: string, description: string): void {
  if (!isCanonicalUTF8V1(value)
    || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new NativeGrantResolutionError("invalid_mapping", `${description} is invalid`);
  }
}
