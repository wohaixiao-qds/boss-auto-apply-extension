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
      { ...job("第三方外包"), jobId: "2" },
      { ...job("猎头顾问发布"), jobId: "3" },
      { ...job("自研产品"), jobId: "4", status: "sent" as const },
    ], { excludeOutsourcing: true, excludeHeadhunter: true });

    expect(result.jobs.map((item) => item.jobId)).toEqual(["1"]);
    expect(result.excluded).toEqual({ outsourcing: 1, headhunter: 1, contacted: 1 });
  });
});
