import {
  canonicalAbilities,
  parseFrozenAttempt,
  sameAbilities,
  TAH_ACTOR_ABILITIES,
  TAH_GUARDIAN_ABILITIES,
  type FrozenAttemptV1,
  type TahAbilityID,
  type TahRoleID,
} from "../contract/index.js";

export interface ResolvedAttemptChoices {
  readonly webEnabled: boolean;
}

export type FrozenAttemptInput = Omit<FrozenAttemptV1, "requiredAbilities">;

export function resolveRequiredAbilities(
  role: TahRoleID,
  choices: ResolvedAttemptChoices,
): readonly TahAbilityID[] {
  if (role !== "actor" && choices.webEnabled) {
    throw new RoleRequirementError("Web is not available to Guardian roles");
  }
  const base = role === "actor" ? TAH_ACTOR_ABILITIES : TAH_GUARDIAN_ABILITIES;
  return choices.webEnabled ? canonicalAbilities([...base, "web"]) : base;
}

export function assertAttemptMatchesRoleRequirements(
  attempt: FrozenAttemptV1,
): void {
  const expected = resolveRequiredAbilities(attempt.role, {
    webEnabled: attempt.requiredAbilities.includes("web"),
  });
  if (!sameAbilities(attempt.requiredAbilities, expected)) {
    throw new RoleRequirementError("Frozen abilities do not match the resolved role requirements");
  }
  if (attempt.role === "actor") {
    if (
      attempt.responseExpectation.kind !== "workspace_outcome" ||
      attempt.workspace.writableRoots.length === 0
    ) {
      throw new RoleRequirementError("Actor requires a workspace outcome and a candidate write scope");
    }
  } else if (
    attempt.responseExpectation.kind !== "strict_json" ||
    attempt.workspace.writableRoots.length !== 0
  ) {
    throw new RoleRequirementError("Guardian requires strict JSON and a read-only workspace");
  }
}

export function buildFrozenAttempt(
  input: FrozenAttemptInput,
  choices: ResolvedAttemptChoices,
): FrozenAttemptV1 {
  const attempt = parseFrozenAttempt({
    ...input,
    requiredAbilities: resolveRequiredAbilities(input.role, choices),
  });
  assertAttemptMatchesRoleRequirements(attempt);
  return attempt;
}

export class RoleRequirementError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RoleRequirementError";
  }
}
