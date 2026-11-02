import {
  launchSuperBoxNodeChildTransportV1,
  type LaunchSuperBoxNodeChildTransportV1,
} from "./node-child-transport.js";
import {
  runSuperBoxProcessOperationV1,
  type RunSuperBoxProcessOperationV1,
  type SuperBoxTransportReadyResultV1,
} from "./process-client.js";

export type SuperBoxNodeLaunchPolicyV1 = LaunchSuperBoxNodeChildTransportV1;
export type SuperBoxNodeOperationRequestV1 = Omit<RunSuperBoxProcessOperationV1, "transport">;
export interface RunSuperBoxNodeOperationV1 {
  readonly launch: SuperBoxNodeLaunchPolicyV1;
  readonly operation: SuperBoxNodeOperationRequestV1;
}

/** Production-oriented composition of the generic Node/Swift VM transport. */
export async function runSuperBoxNodeOperationV1(
  request: RunSuperBoxNodeOperationV1,
): Promise<SuperBoxTransportReadyResultV1> {
  const transport = await launchSuperBoxNodeChildTransportV1(request.launch);
  return runSuperBoxProcessOperationV1({
    ...request.operation,
    transport,
  });
}
