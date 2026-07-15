import { describe, it, expect } from "vitest";
import { mergeBossQueryWithUser } from "../../src/agent/query-plan";
import type { BossQueryContext, Settings } from "../../src/types";
const S: Settings = {
  jobKeywords: "前端", excludeCompanies: "", targetLocations: "北京", targetSalary: "20-30K",
  workMode: "", jobTypes: "全职", workExperience: "3-5年", education: "本科",
  companyIndustries: "", companySizes: "", maxPages: "5", minMatchScore: "50",
  candidateProfileClean: "", jobIntent: { targetTitles: [], skills: [], locations: [], salary: "", workModes: [], summary: "" },
  profileSyncedAt: "", aiEnabled: true, agentAutoStart: true, aiBaseUrl: "", aiModel: "", aiApiKey: "",
  costThresholdYuan: "0.5", inputPriceYuanPerMillion: "0.6", outputPriceYuanPerMillion: "2.4", greetCap: "10", greetMessage: ""
};
const C: BossQueryContext = { keyword: "", location: [], salary: [], jobTypes: [], workModes: [], experience: [], education: [], industries: [], companySizes: [], source: "recommend" };

describe("mergeBossQueryWithUser", () => {
  it("user overrides; changed marks user dims", () => {
    const e = mergeBossQueryWithUser(C, S);
    expect(e.keyword).toBe("前端");
    expect(e.location).toEqual(["北京"]);
    expect(e.changed).toContain("薪资");
    expect(e.preserved).not.toContain("薪资");
  });
  it("falls back to current when user empty for a dim", () => {
    const e = mergeBossQueryWithUser({ ...C, industries: ["互联网"] }, { ...S, companyIndustries: "" });
    expect(e.industries).toEqual(["互联网"]);
    expect(e.preserved).toContain("公司行业");
  });
});
