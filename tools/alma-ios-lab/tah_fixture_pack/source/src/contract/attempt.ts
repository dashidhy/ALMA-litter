import { z } from "zod";
import { contextWindowTokensSchema } from "./context-window.js";

import {
  TAH_ABILITY_IDS,
  TAH_ACTOR_ABILITIES,
  TAH_GUARDIAN_ABILITIES,
  TAH_ROLE_IDS,
  canonicalAbilities,
  sameAbilities,
  type TahAbilityID,
} from "./abilities.js";
import {
  isCanonicalUTF8V1,
  isStrictlyCanonicalUTF8SortedV1,
} from "./canonical-order.js";

export const TAH_PROVIDER_CONTRACT_VERSION = 1 as const;
export const TAH_MAX_PROMPT_UTF8_BYTES = 1024 * 1024;
export const TAH_MAX_TOTAL_MATERIAL_BYTES = 64 * 1024 * 1024;
export const TAH_MAX_RESPONSE_UTF8_BYTES = 1024 * 1024;

const semanticID = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
const opaqueHandle = z.string().min(1).max(256).refine(
  (value) => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value),
  "opaque handle contains invalid characters",
);
const providerID = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/u);
const lowerUUID = z.string().uuid().refine((value) => value === value.toLowerCase());
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const relativePath = z.string().min(1).max(1_024).superRefine((value, context) => {
  if (!isCanonicalUTF8V1(value)
    || value.startsWith("/")
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    context.addIssue({ code: "custom", message: "path must be a portable relative path" });
    return;
  }
  const components = value.split("/");
  if (components.some((component) => component.length === 0 || component === "." || component === "..")) {
    context.addIssue({ code: "custom", message: "path contains an invalid component" });
  }
});

const inferenceSelectionSchema = z.strictObject({
  modelID: opaqueHandle,
  reasoningEffortID: opaqueHandle.nullable(),
  // Omitted means Provider default; explicit values must be supported by the Adapter.
  contextWindowTokens: contextWindowTokensSchema.optional(),
});

const promptPartSchema = z.strictObject({
  authority: z.enum([
    "tah_instruction",
    "action_instruction",
    "tah_trusted_context",
    "untrusted_content",
  ]),
  text: z.string().max(TAH_MAX_PROMPT_UTF8_BYTES),
});

const workspaceMaterialSchema = z.strictObject({
  relativePath,
  mediaType: z.enum(["text/plain", "application/json"]),
  byteLength: z.number().int().nonnegative().max(16 * 1024 * 1024),
  sha256,
});

const workspaceCandidateSeedSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("directory"),
    relativePath,
  }),
  z.strictObject({
    kind: z.literal("file"),
    relativePath,
    mediaType: z.enum(["text/plain", "application/json"]),
    byteLength: z.number().int().nonnegative().max(16 * 1024 * 1024),
    sha256,
  }),
]);

const uniquePaths = <T extends { readonly relativePath: string }>(values: readonly T[]): boolean =>
  new Set(values.map((value) => value.relativePath)).size === values.length;

const workspaceScopeSchema = z.strictObject({
  materials: z.array(workspaceMaterialSchema).max(256).refine(uniquePaths, "material paths must be unique"),
  candidateSeeds: z.array(workspaceCandidateSeedSchema).max(512)
    .refine(uniquePaths, "candidate seed paths must be unique"),
  writableRoots: z.array(relativePath).max(16).refine(
    (values) => new Set(values).size === values.length,
    "writable roots must be unique",
  ),
});

const responseExpectationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    maximumUTF8Bytes: z.number().int().positive().max(TAH_MAX_RESPONSE_UTF8_BYTES),
  }),
  z.strictObject({
    kind: z.literal("strict_json"),
    schemaID: semanticID,
    maximumUTF8Bytes: z.number().int().positive().max(TAH_MAX_RESPONSE_UTF8_BYTES),
  }),
  z.strictObject({
    kind: z.literal("workspace_outcome"),
    contractID: semanticID,
    maximumFinalMessageUTF8Bytes: z.number().int().positive().max(TAH_MAX_RESPONSE_UTF8_BYTES),
  }),
]);

export const frozenAttemptSchema = z.strictObject({
  contractVersion: z.literal(TAH_PROVIDER_CONTRACT_VERSION),
  attemptID: lowerUUID,
  providerID,
  role: z.enum(TAH_ROLE_IDS),
  inference: inferenceSelectionSchema,
  prompt: z.array(promptPartSchema).min(1).max(64),
  workspace: workspaceScopeSchema,
  responseExpectation: responseExpectationSchema,
  requiredAbilities: z.array(z.enum(TAH_ABILITY_IDS)).min(1).max(TAH_ABILITY_IDS.length),
}).superRefine((value, context) => {
  const promptBytes = value.prompt.reduce(
    (total, part) => total + Buffer.byteLength(part.text, "utf8"),
    0,
  );
  if (!Number.isSafeInteger(promptBytes) || promptBytes > TAH_MAX_PROMPT_UTF8_BYTES) {
    context.addIssue({
      code: "custom",
      path: ["prompt"],
      message: "prompt exceeds its aggregate UTF-8 byte bound",
    });
  }
  if (!isStrictlyCanonicalUTF8SortedV1(
    value.workspace.materials.map((material) => material.relativePath),
  )) {
    context.addIssue({
      code: "custom",
      path: ["workspace", "materials"],
      message: "materials must use canonical path order",
    });
  }
  if (!isStrictlyCanonicalUTF8SortedV1(value.workspace.writableRoots)) {
    context.addIssue({
      code: "custom",
      path: ["workspace", "writableRoots"],
      message: "writable roots must use canonical path order",
    });
  }
  const materialBytes = [
    ...value.workspace.materials,
    ...value.workspace.candidateSeeds.filter((seed) => seed.kind === "file"),
  ].reduce(
    (total, material) => total + material.byteLength,
    0,
  );
  if (!Number.isSafeInteger(materialBytes) || materialBytes > TAH_MAX_TOTAL_MATERIAL_BYTES) {
    context.addIssue({
      code: "custom",
      path: ["workspace", "materials"],
      message: "materials exceed their aggregate byte bound",
    });
  }
  for (let leftIndex = 0; leftIndex < value.workspace.writableRoots.length; leftIndex += 1) {
    const left = value.workspace.writableRoots[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < value.workspace.writableRoots.length; rightIndex += 1) {
      const right = value.workspace.writableRoots[rightIndex]!;
      if (isWithinLogicalRoot(left, right) || isWithinLogicalRoot(right, left)) {
        context.addIssue({
          code: "custom",
          path: ["workspace", "writableRoots"],
          message: "writable roots must not overlap",
        });
      }
    }
  }
  if (value.workspace.materials.some((material) =>
    value.workspace.writableRoots.some((root) => isWithinLogicalRoot(material.relativePath, root)))) {
    context.addIssue({
      code: "custom",
      path: ["workspace"],
      message: "frozen materials must not overlap writable roots",
    });
  }
  if (value.workspace.candidateSeeds.some((seed) =>
    !value.workspace.writableRoots.some((root) => seed.relativePath.startsWith(`${root}/`)))) {
    context.addIssue({
      code: "custom",
      path: ["workspace", "candidateSeeds"],
      message: "candidate seeds must be inside a writable root",
    });
  }
  const allInputPaths = [
    ...value.workspace.materials.map((material) => material.relativePath),
    ...value.workspace.candidateSeeds.map((seed) => seed.relativePath),
  ];
  if (new Set(allInputPaths).size !== allInputPaths.length) {
    context.addIssue({
      code: "custom",
      path: ["workspace"],
      message: "materials and candidate seeds must not share a path",
    });
  }
  for (const material of value.workspace.materials) {
    if (allInputPaths.some((path) =>
      path !== material.relativePath
      && (path.startsWith(`${material.relativePath}/`)
        || material.relativePath.startsWith(`${path}/`)))) {
      context.addIssue({
        code: "custom",
        path: ["workspace"],
        message: "immutable material paths must not collide with descendants",
      });
    }
  }
  for (let left = 0; left < value.workspace.candidateSeeds.length; left += 1) {
    const leftSeed = value.workspace.candidateSeeds[left]!;
    if (left > 0
      && !isStrictlyCanonicalUTF8SortedV1([
        value.workspace.candidateSeeds[left - 1]!.relativePath,
        leftSeed.relativePath,
      ])) {
      context.addIssue({
        code: "custom",
        path: ["workspace", "candidateSeeds"],
        message: "candidate seeds must use canonical path order",
      });
    }
    for (let right = left + 1; right < value.workspace.candidateSeeds.length; right += 1) {
      const rightSeed = value.workspace.candidateSeeds[right]!;
      if (rightSeed.relativePath.startsWith(`${leftSeed.relativePath}/`)
        && leftSeed.kind !== "directory") {
        context.addIssue({
          code: "custom",
          path: ["workspace", "candidateSeeds"],
          message: "candidate seed file collides with a descendant",
        });
      }
    }
  }
  const seedByPath = new Map(
    value.workspace.candidateSeeds.map((seed) => [seed.relativePath, seed]),
  );
  for (const seed of value.workspace.candidateSeeds) {
    const root = value.workspace.writableRoots
      .filter((candidate) => isWithinLogicalRoot(seed.relativePath, candidate))
      .sort((left, right) => right.length - left.length)[0];
    if (root === undefined) continue;
    const suffix = seed.relativePath.slice(root.length + 1).split("/");
    for (let index = 1; index < suffix.length; index += 1) {
      const ancestor = `${root}/${suffix.slice(0, index).join("/")}`;
      if (seedByPath.get(ancestor)?.kind !== "directory") {
        context.addIssue({
          code: "custom",
          path: ["workspace", "candidateSeeds"],
          message: "candidate seed manifest omitted a directory ancestor",
        });
      }
    }
  }
  const expectedAbilities = value.role === "actor"
    ? canonicalAbilities([
        ...TAH_ACTOR_ABILITIES,
        ...(value.requiredAbilities.includes("web") ? ["web" as const] : []),
      ])
    : TAH_GUARDIAN_ABILITIES;
  if (!sameAbilities(value.requiredAbilities, expectedAbilities)) {
    context.addIssue({
      code: "custom",
      path: ["requiredAbilities"],
      message: "abilities do not match the registered TAH role",
    });
  }
  if (value.role === "actor") {
    if (value.responseExpectation.kind !== "workspace_outcome"
      || value.workspace.writableRoots.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["responseExpectation"],
        message: "Actor requires a workspace outcome and writable candidate scope",
      });
    }
  } else if (value.responseExpectation.kind !== "strict_json"
    || value.workspace.writableRoots.length !== 0
    || value.workspace.candidateSeeds.length !== 0) {
    context.addIssue({
      code: "custom",
      path: ["responseExpectation"],
      message: "Guardian requires strict JSON and a read-only workspace",
    });
  }
  let canonical: readonly TahAbilityID[];
  try {
    canonical = canonicalAbilities(value.requiredAbilities);
  } catch (error) {
    context.addIssue({
      code: "custom",
      path: ["requiredAbilities"],
      message: error instanceof Error ? error.message : "invalid abilities",
    });
    return;
  }
  if (canonical.some((ability, index) => ability !== value.requiredAbilities[index])) {
    context.addIssue({
      code: "custom",
      path: ["requiredAbilities"],
      message: "required abilities must use canonical order",
    });
  }
});

function isWithinLogicalRoot(relativePath: string, root: string): boolean {
  return relativePath === root || relativePath.startsWith(`${root}/`);
}

export type FrozenAttemptV1 = z.infer<typeof frozenAttemptSchema>;
export type PromptPartV1 = FrozenAttemptV1["prompt"][number];
export type ResponseExpectationV1 = FrozenAttemptV1["responseExpectation"];
export type WorkspaceScopeV1 = FrozenAttemptV1["workspace"];

export function parseFrozenAttempt(value: unknown): FrozenAttemptV1 {
  return deepFreeze(frozenAttemptSchema.parse(value));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
