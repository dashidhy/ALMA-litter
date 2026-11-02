export const TAH_ROLE_IDS = Object.freeze([
  "raw_guardian",
  "extra_guardian",
  "actor",
] as const);

export type TahRoleID = (typeof TAH_ROLE_IDS)[number];

export const TAH_ABILITY_IDS = Object.freeze([
  "prompt.inline_text",
  "workspace.entries.list",
  "workspace.text.read",
  "workspace.text.search",
  "workspace.text.write",
  "workspace.text.edit",
  "web",
] as const);

export type TahAbilityID = (typeof TAH_ABILITY_IDS)[number];

export const TAH_GUARDIAN_ABILITIES = Object.freeze([
  "prompt.inline_text",
  "workspace.entries.list",
  "workspace.text.read",
  "workspace.text.search",
] as const satisfies readonly TahAbilityID[]);

export const TAH_ACTOR_ABILITIES = Object.freeze([
  ...TAH_GUARDIAN_ABILITIES,
  "workspace.text.write",
  "workspace.text.edit",
] as const satisfies readonly TahAbilityID[]);

const ABILITY_ORDER = new Map<TahAbilityID, number>(
  TAH_ABILITY_IDS.map((ability, index) => [ability, index]),
);

export function canonicalAbilities(
  abilities: readonly TahAbilityID[],
): readonly TahAbilityID[] {
  const unique = new Set<TahAbilityID>();
  for (const ability of abilities) {
    if (!ABILITY_ORDER.has(ability)) {
      throw new TypeError(`Unknown TAH ability: ${String(ability)}`);
    }
    if (unique.has(ability)) {
      throw new TypeError(`Duplicate TAH ability: ${ability}`);
    }
    unique.add(ability);
  }
  return Object.freeze(
    [...unique].sort((left, right) => ABILITY_ORDER.get(left)! - ABILITY_ORDER.get(right)!),
  );
}

export function sameAbilities(
  left: readonly TahAbilityID[],
  right: readonly TahAbilityID[],
): boolean {
  return left.length === right.length && left.every((ability, index) => ability === right[index]);
}
