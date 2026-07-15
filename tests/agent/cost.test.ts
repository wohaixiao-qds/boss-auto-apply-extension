import { describe, it, expect } from "vitest";
import { accumulateCost, costBreakerTripped } from "../../src/agent/cost";
import type { Settings } from "../../src/types";
const S: Settings = {
  jobKeywords: "", excludeCompanies: "", targetLocations: "", targetSalary: "", workMode: "",
  jobTypes: "", workExperience: "", education: "", companyIndustries: "", companySizes: "",
  maxPages: "5", minMatchScore: "50", candidateProfileClean: "",
  jobIntent: { targetTitles: [], skills: [], locations: [], salary: "", workModes: [], summary: "" },
  profileSyncedAt: "", aiEnabled: true, agentAutoStart: true, aiBaseUrl: "", aiModel: "", aiApiKey: "",
  costThresholdYuan: "0.5", inputPriceYuanPerMillion: "1", outputPriceYuanPerMillion: "4",
  greetCap: "10", greetMessage: ""
};

describe("accumulateCost", () => {
  it("uses real usage when provided", () => {
    const r = accumulateCost({ tokensUsed: 0, costYuan: 0 }, 1_000_000, 100_000, S);
    expect(r.estimated).toBe(false);
    expect(r.costYuan).toBeCloseTo(1 * 1 + 0.1 * 4, 5); // 1 + 0.4
    expect(r.tokensUsed).toBe(1_100_000);
  });
  it("estimates when usage missing (0/0 → estimate by chars)", () => {
    const r = accumulateCost({ tokensUsed: 0, costYuan: 0 }, 0, 0, S, { estInputChars: 8000, estOutputChars: 200 });
    expect(r.estimated).toBe(true);
    expect(r.tokensUsed).toBeGreaterThan(0);
  });
});

describe("costBreakerTripped", () => {
  it("trips when cost >= threshold", () => {
    expect(costBreakerTripped(0.6, S)).toBe(true);
    expect(costBreakerTripped(0.49, S)).toBe(false);
  });
});
