import type { AgentIntent, AgentState, GreetContext, PageSnapshot } from "../types";

export interface LlmUsage { tokensIn: number; tokensOut: number; cumulativeYuan: number; estimated: boolean; }

const PHASE_B_CONTROL = /立即沟通|打招呼|留在此页|继续沟通|关闭|发送|send|×/i;

function snapshotForLlm(state: AgentState, snapshot: PageSnapshot): PageSnapshot {
  if (state.phase !== "greet") return snapshot;
  // Phase B 的岗位切换由 Runtime 完成，筛选和普通岗位卡片对 LLM 没有决策价值，
  // 反而会让相同数字 ref 落到 filter/job 区域。只暴露沟通控件和聊天输入框，
  // 同时保留原 snapshotId，保证 ref 仍能由执行层按原快照解析。
  const elements = snapshot.elements.filter(element =>
    (element.role === "input" && element.region === "chat") || PHASE_B_CONTROL.test(element.text)
  );
  return {
    ...snapshot,
    elements,
    summary: `${snapshot.summary} | Phase B 可操作控件×${elements.length}`
  };
}

export function buildLlmPayload(params: {
  state: AgentState; intent: AgentIntent; snapshot: PageSnapshot;
  currentQuery: PageSnapshot["currentQuery"]; effectiveQuery: AgentIntent["query"];
  greetContext?: GreetContext; usage?: LlmUsage;
}): Record<string, unknown> {
  const { state, intent, snapshot, currentQuery, effectiveQuery, greetContext, usage } = params;
  const llmSnapshot = snapshotForLlm(state, snapshot);
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
    page: { snapshotId: llmSnapshot.snapshotId, kind: llmSnapshot.kind, summary: llmSnapshot.summary, screen: serializeForLlm(llmSnapshot) },
    usage: usage ?? { tokensIn: 0, tokensOut: 0, cumulativeYuan: state.costYuan, estimated: false }
  };
}

// 延迟 import 避免循环
import { serializeSnapshotForLLM as serializeForLlm } from "./snapshot";
