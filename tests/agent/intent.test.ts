import { describe, it, expect } from "vitest";
import { buildAgentIntent } from "../../src/agent/intent";
import type { BossQueryContext, Settings } from "../../src/types";

const baseSettings = (over: Partial<Settings> = {}): Settings => ({
  jobKeywords: "", excludeCompanies: "", targetLocations: "", targetSalary: "",
  workMode: "", jobTypes: "", workExperience: "", education: "",
  companyIndustries: "", companySizes: "", maxPages: "5", minMatchScore: "50",
  candidateProfileClean: "",
  jobIntent: { targetTitles: [], skills: [], locations: [], salary: "", workModes: [], summary: "" },
  profileSyncedAt: "", aiEnabled: true, agentAutoStart: true,
  aiBaseUrl: "https://api.openai.com/v1", aiModel: "gpt-4o-mini", aiApiKey: "",
  costThresholdYuan: "0.5", inputPriceYuanPerMillion: "0.6",
  outputPriceYuanPerMillion: "2.4", greetCap: "10", greetMessage: "您好",
  ...over
});

const emptyQuery: BossQueryContext = {
  keyword: "", location: [], salary: [], jobTypes: [], workModes: [],
  experience: [], education: [], industries: [], companySizes: [], source: "unknown"
};

describe("buildAgentIntent (profile removed)", () => {
  it("source is user when only explicit settings filled", () => {
    const i = buildAgentIntent(baseSettings({ targetSalary: "20-30K" }), emptyQuery);
    expect(i.source).toBe("user");
    expect(i.query.salary).toEqual(["20-30K"]);
    expect(i.defined).toBe(true);
  });

  it("source is page when nothing user-provided but page query present", () => {
    const i = buildAgentIntent(baseSettings(), { ...emptyQuery, keyword: "前端", source: "search" });
    expect(i.source).toBe("page");
    expect(i.query.keyword).toBe("前端");
  });

  it("does NOT pull from jobIntent (profile) for salary", () => {
    const s = baseSettings();
    s.jobIntent.salary = "30-50K";
    const i = buildAgentIntent(s, emptyQuery);
    expect(i.query.salary).toEqual([]);
  });

  it("undefined when no user and no page input", () => {
    const i = buildAgentIntent(baseSettings(), emptyQuery);
    expect(i.defined).toBe(false);
  });

  it("ignores the legacy minimum match score setting", () => {
    const i = buildAgentIntent(baseSettings({ minMatchScore: "95", jobKeywords: "前端" }), emptyQuery);
    expect(i.minMatchScore).toBe(0);
    expect(i.summary).not.toContain("最低匹配");
  });
});
