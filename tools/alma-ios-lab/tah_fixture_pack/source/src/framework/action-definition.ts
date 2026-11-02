import { createHash } from "node:crypto";

import type { StructuredOutcomeContractV1 } from "./outcome-contract.js";
import { STRUCTURED_NOTES_OUTCOME_CONTRACT_V1 } from "./outcome-contract.js";
import { ASR_INDEX_PRESENTATIONS } from "./asr-index-presentation.js";

export const TAH_ACTION_DEFINITION_VERSION = 1 as const;
export const STRUCTURED_NOTES_ACTION_DEFINITION_ID = "structured_notes/v1" as const;
export const STRUCTURED_NOTES_ACTION_TEMPLATE_SHA256 =
  "a4cb4a76f1e20f23bf7b2f9362f7e77ca8000da79dc324915908999d4a56f283" as const;
export const STRUCTURED_NOTES_ACTION_DEFINITION_DIGEST = sha256([
  "ALMA_TAH_ACTION_DEFINITION_V1\0",
  STRUCTURED_NOTES_ACTION_TEMPLATE_SHA256,
  "\0",
  JSON.stringify(ASR_INDEX_PRESENTATIONS),
  "\0",
  JSON.stringify(STRUCTURED_NOTES_OUTCOME_CONTRACT_V1),
].join(""));
export const TAH_SUPPORTED_NOTE_LANGUAGES = Object.freeze(["zh-CN", "en"] as const);
export type TahNoteLanguageV1 = (typeof TAH_SUPPORTED_NOTE_LANGUAGES)[number];

export interface TahActionDefinitionV1 {
  readonly schemaVersion: 1;
  readonly actionID: "structured_notes";
  readonly definitionID: typeof STRUCTURED_NOTES_ACTION_DEFINITION_ID;
  readonly definitionDigest: string;
  readonly outcomeContract: StructuredOutcomeContractV1;
  renderActionInstructions(language: TahNoteLanguageV1, interactionLanguage?: TahNoteLanguageV1): string;
}

const registeredDefinitions = new WeakSet<object>();

/**
 * Loads the one Structured Notes definition sealed into this build. The byte
 * parameter is an asset-verification input, not an extension point: any other
 * template is rejected before a definition receives the in-process brand.
 */
export function createStructuredNotesActionDefinitionV1(
  actionInstructionTemplate: string,
): TahActionDefinitionV1 {
  if (typeof actionInstructionTemplate !== "string"
    || actionInstructionTemplate.split("{NOTE_PRIMARY_LANGUAGE}").length !== 2
    || actionInstructionTemplate.split("{INTERACTION_LANGUAGE}").length !== 2
    || actionInstructionTemplate.split("{ASR_INDEX_PRESENTATION}").length !== 2
    || /\{[A-Z0-9_]+\}/u.test(
      actionInstructionTemplate.replace("{NOTE_PRIMARY_LANGUAGE}", "").replace("{INTERACTION_LANGUAGE}", "")
        .replace("{ASR_INDEX_PRESENTATION}", ""),
    )
    || sha256(actionInstructionTemplate) !== STRUCTURED_NOTES_ACTION_TEMPLATE_SHA256) {
    throw new ActionDefinitionError("Structured Notes instruction template is invalid");
  }
  const definition: TahActionDefinitionV1 = Object.freeze({
    schemaVersion: TAH_ACTION_DEFINITION_VERSION,
    actionID: "structured_notes",
    definitionID: STRUCTURED_NOTES_ACTION_DEFINITION_ID,
    definitionDigest: STRUCTURED_NOTES_ACTION_DEFINITION_DIGEST,
    outcomeContract: STRUCTURED_NOTES_OUTCOME_CONTRACT_V1,
    renderActionInstructions(language: TahNoteLanguageV1, interactionLanguage: TahNoteLanguageV1 = "en"): string {
      const label = language === "zh-CN"
        ? "Simplified Chinese (简体中文)"
        : language === "en"
          ? "English"
          : undefined;
      if (label === undefined) throw new ActionDefinitionError("Notes language is unsupported");
      const interactionLabel = interactionLanguage === "zh-CN" ? "Simplified Chinese (简体中文)"
        : interactionLanguage === "en" ? "English" : undefined;
      if (interactionLabel === undefined) throw new ActionDefinitionError("Interaction language is unsupported");
      const result = actionInstructionTemplate.replace("{NOTE_PRIMARY_LANGUAGE}", label)
        .replace("{INTERACTION_LANGUAGE}", interactionLabel)
        .replace("{ASR_INDEX_PRESENTATION}", () => ASR_INDEX_PRESENTATIONS[interactionLanguage]);
      if (/\{[A-Z0-9_]+\}/u.test(result)) {
        throw new ActionDefinitionError("Action Instructions contain an unresolved placeholder");
      }
      return result;
    },
  });
  registeredDefinitions.add(definition);
  return definition;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function assertRegisteredActionDefinitionV1(
  value: TahActionDefinitionV1,
): TahActionDefinitionV1 {
  if (typeof value !== "object" || value === null || !registeredDefinitions.has(value)) {
    throw new ActionDefinitionError("Action Definition is not registered by this TAH build");
  }
  return value;
}

export class ActionDefinitionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ActionDefinitionError";
  }
}
