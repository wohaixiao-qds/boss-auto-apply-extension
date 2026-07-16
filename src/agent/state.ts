import type { AgentState } from "../types";

export function newAgentState(runId: string, sourceTabId: number | null, now: string): AgentState {
  return {
    runId,
    stateVersion: 1,
    updatedAt: now,
    phase: "screen",
    step: "idle",
    phaseTurns: 0,
    retryCount: 0,
    startedAt: now,
    error: "",
    goal: "greet_matching",
    appliedFilters: [],
    lastDecision: "",
    candidateCount: 0,
    filteredCount: 0,
    jobsCollected: false,
    filterCompleted: false,
    ranked: false,
    pagesVisited: 0,
    visitedPageSignatures: [],
    currentGreetIndex: 0,
    currentGreetUrl: "",
    greetListUrl: "",
    approvedForGreet: [],
    greeted: [],
    greetCap: 10,
    greetStatus: {},
    lastRankedJobs: [],
    tokensUsed: 0,
    costYuan: 0,
    lastActionHash: "",
    sameActionCount: 0,
    lastProgressSignature: "",
    sourceTabId
  };
}

export function bumpState(state: AgentState, now: string): AgentState {
  return { ...state, stateVersion: state.stateVersion + 1, updatedAt: now };
}
