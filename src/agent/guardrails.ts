import type { AgentState, Settings } from "../types";
import { costBreakerTripped } from "./cost";

const MAX_TURNS = 50;

export function shouldBreak(state: AgentState, settings: Settings): { stop: true; reason: string } | null {
  if (costBreakerTripped(state.costYuan, settings)) return { stop: true, reason: `费用熔断：已花费约 ¥${state.costYuan.toFixed(3)}` };
  if (state.phaseTurns >= MAX_TURNS) return { stop: true, reason: `达到 phase 轮数上限（${MAX_TURNS}）` };
  if (state.sameActionCount >= 3) return { stop: true, reason: `卡死检测：连续重复动作 ${state.sameActionCount} 次` };
  if (state.greeted.length >= state.greetCap && state.phase === "greet") return { stop: true, reason: `达到打招呼上限（${state.greetCap}）` };
  return null;
}

export function recordAction(state: AgentState, hash: string, signature: string): AgentState {
  // 首次记录（无前序动作）视为一次新动作（count=1）；与上次完全一致则递增；否则重置为 0。
  const noPrior = state.lastActionHash === "" && state.lastProgressSignature === "";
  const isRepeat = hash === state.lastActionHash && signature === state.lastProgressSignature;
  const same = isRepeat || noPrior ? state.sameActionCount + 1 : 0;
  return { ...state, lastActionHash: hash, sameActionCount: same, lastProgressSignature: signature };
}
