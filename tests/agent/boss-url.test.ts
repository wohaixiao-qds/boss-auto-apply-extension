import { describe, expect, it } from "vitest";
import { buildBossJobsUrl, parseBossJobsUrl } from "../../src/agent/boss-url";
import type { Settings } from "../../src/types";

const baseSettings = (overrides: Partial<Settings> = {}): Settings => ({
  jobKeywords: "", excludeCompanies: "", targetLocations: "", targetSalary: "",
  workMode: "", jobTypes: "", workExperience: "", education: "",
  companyIndustries: "", companySizes: "", maxPages: "5", minMatchScore: "50",
  candidateProfileClean: "", jobIntent: { targetTitles: [], skills: [], locations: [], salary: "", workModes: [], summary: "" }, profileSyncedAt: "",
  aiEnabled: false, agentAutoStart: false, aiBaseUrl: "", aiModel: "", aiApiKey: "",
  costThresholdYuan: "5", inputPriceYuanPerMillion: "0", outputPriceYuanPerMillion: "0", greetCap: "10", greetMessage: "",
  ...overrides
});

describe("buildBossJobsUrl", () => {
  it("maps BOSS filter values to URL parameters", () => {
    const result = buildBossJobsUrl(
      "https://www.zhipin.com/web/geek/jobs?query=old",
      baseSettings({
        jobKeywords: "前端",
        targetLocations: "上海",
        jobTypes: "兼职",
        workExperience: "在校生、5-10年",
        education: "初中及以下、博士",
        companySizes: "0-20人、10000人以上",
        companyIndustries: "人工智能"
      }),
      { industries: [{ text: "人工智能", code: "8" }] }
    );
    const url = new URL(result.url);
    expect(url.pathname).toBe("/web/geek/jobs");
    expect(url.searchParams.get("query")).toBe("前端");
    expect(url.searchParams.get("city")).toBe("101020100");
    expect(url.searchParams.get("jobType")).toBe("1903");
    expect(url.searchParams.get("experience")).toBe("108,106");
    expect(url.searchParams.get("degree")).toBe("209,205");
    expect(url.searchParams.get("scale")).toBe("301,306");
    expect(url.searchParams.get("industry")).toBe("8");
    expect(result.missing).toEqual([]);
  });

  it("keeps existing parameters when the user did not set that dimension", () => {
    const result = buildBossJobsUrl(
      "https://www.zhipin.com/web/geek/jobs?city=101020100&jobType=1903",
      baseSettings(),
      {}
    );
    const url = new URL(result.url);
    expect(url.searchParams.get("city")).toBe("101020100");
    expect(url.searchParams.get("jobType")).toBe("1903");
  });

  it("reads the URL parameters back into the current query", () => {
    const query = parseBossJobsUrl("https://www.zhipin.com/web/geek/jobs?city=101020100&jobType=1903&experience=108,107&degree=209,205&scale=301,306");
    expect(query.location).toEqual(["上海"]);
    expect(query.jobTypes).toEqual(["兼职"]);
    expect(query.experience).toEqual(["在校生", "10年以上"]);
    expect(query.education).toEqual(["初中及以下", "博士"]);
    expect(query.companySizes).toEqual(["0-20人", "10000人以上"]);
  });
});
