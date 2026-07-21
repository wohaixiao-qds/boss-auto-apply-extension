import { describe, expect, it } from "vitest";
import { isOutsourcingJob } from "../../src/shared/job-filter";

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
