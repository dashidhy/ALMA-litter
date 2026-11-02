/** A new process has no authority to infer cleanup from a missing live task.
 * Only an atomic publication or an exact, complete staged write can be recovered
 * without a fresh user decision. No branch starts a model automatically. */
export function restoredActionPhase(operationPhase: string | undefined, publishedCurrent: boolean,
  pending: "none" | "complete" | "partial"): string {
  if (pending === "partial") return "integrity_locked";
  if (pending === "complete") return "persistence_pending";
  if (publishedCurrent) return "completed";
  if (operationPhase === "running") return "integrity_locked";
  return operationPhase ?? "idle";
}
