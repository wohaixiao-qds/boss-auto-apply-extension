import type { AgentState } from "../types";

export function mergeRecovery(local: AgentState, remote: AgentState | null): AgentState {
  if (!remote) return local;
  if (remote.runId !== local.runId) return remote.updatedAt >= local.startedAt ? remote : local;
  return remote.stateVersion > local.stateVersion ? remote : local;
}
