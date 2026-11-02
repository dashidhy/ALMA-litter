import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { FileAuthStorage, emptyAuthRecord } from "../auth-prototype/storage.js";

export const INTERNATIONAL_AUTH_DIRECTORY = "auth-international-v1";

/** Build 11's qoder credential belongs to CN. Never inspect it against Global.
 * A separate vault also prevents a rollback to build 11 from using a Global PAT.
 * Only the unchanged Codex provider may be copied once; the legacy vault stays intact.
 */
export async function acquireInternationalAuthStorage(stateDirectory: string): Promise<FileAuthStorage> {
  const directory = join(stateDirectory, INTERNATIONAL_AUTH_DIRECTORY);
  const storage = new FileAuthStorage(directory);
  await storage.acquire();
  try {
    if (await exists(join(directory, "auth-state.json"))) return storage;
    const legacyDirectory = join(stateDirectory, "auth");
    if (!await exists(join(legacyDirectory, "auth-state.json"))) {
      await storage.save(emptyAuthRecord());
      return storage;
    }
    const legacy = new FileAuthStorage(legacyDirectory);
    await legacy.acquire();
    try {
      const record = await legacy.load();
      await storage.save(record.providerID === "codex"
        ? record
        : emptyAuthRecord(record.providerID));
    } finally {
      await legacy.close();
    }
    return storage;
  } catch (error) {
    await storage.close();
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
