import type { AgentIntent, AgentState, GreetContext, PageSnapshot } from "../types";

export interface LlmUsage { tokensIn: number; tokensOut: number; cumulativeYuan: number; estimated: boolean; }

export function buildLlmPayload(params: {
  state: AgentState; intent: AgentIntent; snapshot: PageSnapshot;
  currentQuery: PageSnapshot["currentQuery"]; effectiveQuery: AgentIntent["query"];
  greetContext?: GreetContext; usage?: LlmUsage;
}): Record<string, unknown> {
  const { state, intent, snapshot, currentQuery, effectiveQuery, greetContext, usage } = params;
  return {
    goal: state.goal,
    phase: state.phase,
    intent: { summary: intent.summary, query: intent.query, defined: intent.defined },
    currentQuery,
    effectiveQuery: { ...effectiveQuery, changed: effectiveQuery.changed, preserved: effectiveQuery.preserved },
    ...(state.phase === "greet" && greetContext ? { greetContext } : {}),
    state: {
      phase: state.phase, phaseTurns: state.phaseTurns,
      jobsCollected: state.jobsCollected, filterCompleted: state.filterCompleted, ranked: state.ranked,
      candidateCount: state.candidateCount,
      pagesVisited: state.pagesVisited, visitedPageSignatures: state.visitedPageSignatures,
      currentGreetIndex: state.currentGreetIndex, currentGreetUrl: state.currentGreetUrl,
      approvedForGreet: state.approvedForGreet, greeted: state.greeted,
      greetCap: state.greetCap, greetStatus: state.greetStatus,
      runId: state.runId, stateVersion: state.stateVersion, updatedAt: state.updatedAt,
      lastError: state.error
    },
    page: { snapshotId: snapshot.snapshotId, kind: snapshot.kind, summary: snapshot.summary, screen: serializeForLlm(snapshot) },
    usage: usage ?? { tokensIn: 0, tokensOut: 0, cumulativeYuan: state.costYuan, estimated: false }
  };
}

// 延迟 import 避免循环
import { serializeSnapshotForLLM as serializeForLlm } from "./snapshot";
