import { createHash } from "node:crypto";
import { z } from "zod";
import { AppBridgeError } from "./bridge.js";
import type { JournalPort } from "./journal.js";

export function submissionDigest(value: unknown): string {
  const text = JSON.stringify(value, (_key, child: unknown) => child !== null && typeof child === "object" && !Array.isArray(child)
    ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b, "en"))) : child);
  return createHash("sha256").update(text).digest("hex");
}
export async function submissionAlreadyRecorded(journal: JournalPort, actionID: string, operationID: string, digest: string): Promise<boolean> {
  const schema = z.object({ cycleID: z.uuid(), submissionDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional() });
  for (const record of await journal.read(`operation/${z.uuid().parse(actionID)}`)) {
    const value = schema.parse(record.value);
    if (value.cycleID !== operationID) continue;
    if (value.submissionDigest !== digest) throw new AppBridgeError("integrity_locked");
    return true;
  }
  return false;
}
