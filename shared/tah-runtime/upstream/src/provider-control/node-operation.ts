import {
  launchSuperBoxNodeChildTransportV1,
} from "../superbox/node-child-transport.js";
import type { SuperBoxNodeLaunchPolicyV1 } from "../superbox/node-operation.js";
import {
  runSuperBoxProviderControlProcessV1,
  type RunSuperBoxProviderControlProcessV1,
} from "./process-client.js";
import type { ProviderControlTerminalV1 } from "./contract.js";

export type SuperBoxNodeProviderControlRequestV1 = Omit<
  RunSuperBoxProviderControlProcessV1,
  "transport"
>;

export interface RunSuperBoxNodeProviderControlV1 {
  readonly launch: SuperBoxNodeLaunchPolicyV1;
  readonly operation: SuperBoxNodeProviderControlRequestV1;
}

/** Uses the same sealed-appliance VM transport as inference attempts. */
export async function runSuperBoxNodeProviderControlV1(
  request: RunSuperBoxNodeProviderControlV1,
): Promise<ProviderControlTerminalV1> {
  const transport = await launchSuperBoxNodeChildTransportV1(request.launch);
  return runSuperBoxProviderControlProcessV1({
    ...request.operation,
    transport,
  });
}
