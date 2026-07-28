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
    expect(target.get("visible")?.companyName).toBe("接口公司");
  });

  it("prefers structured API fields for an exact visible job ID match", () => {
    const visible = {
      ...job("visible", "页面公司"),
      positionName: "页面错误岗位",
      salary: "10-15K",
      city: "上海",
      status: "sent" as const,
    };
    const apiJob = {
      ...job("visible", "接口公司"),
      positionName: "接口正确岗位",
      salary: "20-30K",
      city: "北京",
    };
    const enriched = enrichVisibleJob(visible, apiJob);

    expect(enriched.companyName).toBe("接口公司");
    expect(enriched.positionName).toBe("接口正确岗位");
    expect(enriched.salary).toBe("20-30K");
    expect(enriched.city).toBe("北京");
    expect(enriched.status).toBe("sent");
  });

  it("fills a provisional visible job position from the matching API job", () => {
    const visible = { ...job("visible", "页面公司"), positionName: "页面公司" };
    const apiJob = { ...job("visible", "接口公司"), positionName: "后端工程师" };

    expect(enrichVisibleJob(visible, apiJob)).toMatchObject({
      jobId: "visible",
      companyName: "接口公司",
      positionName: "后端工程师",
    });
  });

  it("enriches an already collected DOM job when its API response arrives later", () => {
    const target = new Map<string, JobItem>();
    const apiJobs = new Map<string, JobItem>();
    mergeVisibleJobs(target, [{ ...job("visible", "页面公司"), positionName: "" }], apiJobs);

    apiJobs.set("visible", { ...job("visible", "接口公司"), positionName: "后端工程师" });
    apiJobs.set("api-only", job("api-only", "接口独有公司"));
    mergeVisibleJobs(target, [], apiJobs);

    expect([...target.keys()]).toEqual(["visible"]);
    expect(target.get("visible")).toMatchObject({
      companyName: "接口公司",
      positionName: "后端工程师",
    });
  });

  it("ignores API data when the job ID does not match", () => {
    const visible = { ...job("visible", "页面公司"), positionName: "" };

    expect(enrichVisibleJob(visible, job("other", "接口公司"))).toEqual(visible);
  });

  it("uses the matching API detail URL when the DOM URL is not a job target", () => {
    const visible = { ...job("visible", "页面公司"), url: "https://www.zhipin.com/gongsi/example.html" };

    expect(enrichVisibleJob(visible, job("visible", "接口公司")).url)
      .toBe("https://www.zhipin.com/job_detail/visible.html");
  });
});
