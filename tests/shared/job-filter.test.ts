import { describe, expect, it } from "vitest";
import { filterJobs, isHeadhunterJob, isOutsourcingJob } from "../../src/shared/job-filter";

const job = (sourceText: string) => ({
  jobId: "1",
  companyName: "示例公司",
  positionName: "前端工程师",
  salary: "20K",
  city: "北京",
  url: "https://www.zhipin.com/job_detail/1.html",
  sourceText,
  status: "pending" as const,
});

const jobWithId = (jobId: string, sourceText: string) => ({
  ...job(sourceText),
  jobId,
  url: `https://www.zhipin.com/job_detail/${jobId}.html`,
});

describe("outsourcing filter", () => {
  it("detects outsourcing markers", () => {
    expect(isOutsourcingJob(job("岗位性质：第三方外包，长期驻场"))).toBe(true);
  });

  it("keeps jobs that explicitly reject outsourcing", () => {
    expect(isOutsourcingJob(job("公司说明：不接受外包，直接和公司签约"))).toBe(false);
  });
});

describe("headhunter filter", () => {
  it("detects headhunter and recruiting service markers", () => {
    expect(isHeadhunterJob(job("职位由猎头顾问发布，负责人才寻访"))).toBe(true);
    expect(isHeadhunterJob({ ...job(""), companyName: "远航人力资源服务有限公司" })).toBe(true);
  });

  it("keeps jobs that explicitly reject headhunters", () => {
    expect(isHeadhunterJob(job("公司直招，不接受猎头推荐"))).toBe(false);
  });

  it("returns only pending jobs that pass enabled filters", () => {
    const result = filterJobs([
      job("自研产品"),
      jobWithId("2", "第三方外包"),
      jobWithId("3", "猎头顾问发布"),
      { ...jobWithId("4", "自研产品"), status: "sent" as const },
    ], { excludeOutsourcing: true, excludeHeadhunter: true });

    expect(result.jobs.map((item) => item.jobId)).toEqual(["1"]);
    expect(result.excluded).toEqual({ unrecognizedPosition: 0, invalidTarget: 0, outsourcing: 1, headhunter: 1, contacted: 1 });
  });

  it("excludes jobs without a recognized position name", () => {
    const result = filterJobs([
      { ...job("自研产品"), positionName: "未识别职位" },
      { ...jobWithId("2", "自研产品"), positionName: "" },
    ], { excludeOutsourcing: true, excludeHeadhunter: true });

    expect(result.jobs).toHaveLength(0);
    expect(result.excluded.unrecognizedPosition).toBe(2);
  });

  it("excludes positions that repeat company, city, or salary text", () => {
    const result = filterJobs([
      { ...job("自研产品"), positionName: "示例公司" },
      { ...jobWithId("2", "自研产品"), positionName: "北京" },
      { ...jobWithId("3", "自研产品"), positionName: "20-30K·13薪" },
      { ...jobWithId("4", "自研产品"), positionName: "后端工程师" },
    ], { excludeOutsourcing: true, excludeHeadhunter: true });

    expect(result.jobs.map((item) => item.jobId)).toEqual(["4"]);
    expect(result.excluded.unrecognizedPosition).toBe(3);
  });

  it("excludes jobs whose detail URL does not match the job ID", () => {
    const result = filterJobs([
      { ...job("自研产品"), url: "https://www.zhipin.com/gongsi/example.html" },
      { ...job("自研产品"), jobId: "2", url: "https://www.zhipin.com/job_detail/other.html" },
      { ...job("自研产品"), jobId: "3", url: "https://www.zhipin.com/job_detail/3.html" },
    ], { excludeOutsourcing: true, excludeHeadhunter: true });

    expect(result.jobs.map((item) => item.jobId)).toEqual(["3"]);
    expect(result.excluded.invalidTarget).toBe(2);
  });
});
