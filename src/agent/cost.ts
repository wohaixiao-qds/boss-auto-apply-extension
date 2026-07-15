import type { Settings } from "../types";

export interface CostAccum { tokensUsed: number; costYuan: number; }
export interface CostResult extends CostAccum { cumulativeYuan: number; estimated: boolean; tokensIn: number; tokensOut: number; }

export function accumulateCost(prev: CostAccum, usageIn: number, usageOut: number, settings: Settings, est?: { estInputChars: number; estOutputChars: number }): CostResult {
  const inPrice = Number(settings.inputPriceYuanPerMillion) || 0;
  const outPrice = Number(settings.outputPriceYuanPerMillion) || 0;
  let tokensIn = usageIn;
  let tokensOut = usageOut;
  let estimated = false;
  if (!usageIn && !usageOut && est) {
    tokensIn = Math.ceil(est.estInputChars / 1.8); // 中文偏密
    tokensOut = Math.ceil(est.estOutputChars / 1.8);
    estimated = true;
  }
  const addCost = tokensIn / 1_000_000 * inPrice + tokensOut / 1_000_000 * outPrice;
  const costYuan = prev.costYuan + addCost;
  return { tokensUsed: prev.tokensUsed + tokensIn + tokensOut, costYuan, cumulativeYuan: costYuan, estimated, tokensIn, tokensOut };
}

export function costBreakerTripped(costYuan: number, settings: Settings): boolean {
  const threshold = Number(settings.costThresholdYuan) || Infinity;
  return costYuan >= threshold;
}
