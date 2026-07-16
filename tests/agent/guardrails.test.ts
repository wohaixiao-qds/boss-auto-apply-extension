import { describe, it, expect } from "vitest";
import { shouldBreak, recordAction } from "../../src/agent/guardrails";
import { newAgentState } from "../../src/agent/state";
import type { Settings } from "../../src/types";
const S: Settings = {
  jobKeywords: "", excludeCompanies: "", targetLocations: "", targetSalary: "", workMode: "", jobTypes: "",
  workExperience: "", education: "", companyIndustries: "", companySizes: "", maxPages: "5", minMatchScore: "50",
  candidateProfileClean: "", jobIntent: { targetTitles: [], skills: [], locations: [], salary: "", workModes: [], summary: "" },
  profileSyncedAt: "", aiEnabled: true, agentAutoStart: true, aiBaseUrl: "", aiModel: "", aiApiKey: "",
  costThresholdYuan: "0.5", inputPriceYuanPerMillion: "0.6", outputPriceYuanPerMillion: "2.4", greetCap: "10", greetMessage: ""
};

describe("shouldBreak", () => {
  it("trips cost breaker", () => {
    const s = newAgentState("r", null, "t"); s.costYuan = 0.6;
    expect(shouldBreak(s, S)?.reason).toMatch(/费用/);
  });
  it("trips max turns", () => {
    const s = newAgentState("r", null, "t"); s.phaseTurns = 50;
    expect(shouldBreak(s, S)?.reason).toMatch(/轮数/);
  });
  it("trips stuck after 3", () => {
    const s = newAgentState("r", null, "t"); s.sameActionCount = 3;
    expect(shouldBreak(s, S)?.reason).toMatch(/卡死/);
  });
});

describe("recordAction", () => {
  it("increments sameActionCount on identical hash+signature", () => {
    let s = newAgentState("r", null, "t");
    s = recordAction(s, "click|0", "sig");
    s = recordAction(s, "click|0", "sig");
    expect(s.sameActionCount).toBe(2);
    s = recordAction(s, "click|1", "sig");
    expect(s.sameActionCount).toBe(0);
  });

  it("does not carry a repeated-action count across different greet jobs", () => {
    let s = newAgentState("r", null, "t");
    s = recordAction(s, "click|e49", "jobs|greetIndex=5|greetUrl=job-a");
    s = recordAction(s, "click|e49", "jobs|greetIndex=6|greetUrl=job-b");
    expect(s.sameActionCount).toBe(0);
  });
});
