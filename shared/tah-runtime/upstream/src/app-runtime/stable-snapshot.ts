import { AppBridgeError } from "./bridge.js";

/** Do not combine a pre-publication journal read with a post-completion live
 * state and misclassify the Action as interrupted. Reads never restart work. */
export async function stableSnapshot<T>(read: () => Promise<T>, revision: () => number): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = revision();
    const value = await read();
    if (before === revision()) return value;
  }
  throw new AppBridgeError("busy");
}
