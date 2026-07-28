import { describe, expect, it } from "vitest";
import { enrichVisibleJob, mergeVisibleJobs } from "../../src/content/job-collection";
import type { JobItem } from "../../src/shared/types";

const job = (jobId: string, companyName: string): JobItem => ({
  jobId,
  companyName,
  positionName: "前端工程师",
  salary: "20-30K",
  city: "北京",
  url: `https://www.zhipin.com/job_detail/${jobId}.html`,
  sourceText: companyName,
  status: "pending",
});

describe("visible job collection", () => {
  it("never adds an API-only job to the current page results", () => {
    const target = new Map<string, JobItem>();
    const apiJobs = new Map([
      ["visible", job("visible", "接口公司")],
      ["unrelated", job("unrelated", "其他推荐公司")],
    ]);

    mergeVisibleJobs(target, [job("visible", "页面公司")], apiJobs);

    expect([...target.keys()]).toEqual(["visible"]);
    expect(target.get("visible")?.companyName).toBe("页面公司");
  });

  it("uses API data only when a visible card is missing a field", () => {
    const visible = { ...job("visible", "未识别公司"), salary: "" };
    const enriched = enrichVisibleJob(visible, job("visible", "接口公司"));

    expect(enriched.companyName).toBe("接口公司");
    expect(enriched.salary).toBe("20-30K");
  });
});
