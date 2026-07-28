import { describe, expect, it } from "vitest";
import { prepareTaskJobs } from "../../src/shared/job-queue";
import type { JobItem } from "../../src/shared/types";

const job = (jobId: string): JobItem => ({
  jobId,
  companyName: "示例公司",
  positionName: "前端工程师",
  salary: "20-30K",
  city: "北京",
  url: `https://www.zhipin.com/job_detail/${jobId}.html`,
  status: "failed",
  reason: "旧任务失败记录",
});

describe("task job preparation", () => {
  it("removes stale malformed jobs and resets valid jobs before sending", () => {
    const prepared = prepareTaskJobs([
      job("valid"),
      { ...job("same-company"), positionName: "示例公司" },
      { ...job("bad-url"), url: "https://www.zhipin.com/gongsi/example.html" },
    ], 10);

    expect(prepared.removedCount).toBe(2);
    expect(prepared.jobs).toEqual([expect.objectContaining({ jobId: "valid", status: "pending", reason: undefined })]);
  });

  it("deduplicates and applies the batch limit after validation", () => {
    const prepared = prepareTaskJobs([job("one"), job("one"), job("two")], 1);

    expect(prepared.jobs.map((item) => item.jobId)).toEqual(["one"]);
    expect(prepared.limitedCount).toBe(1);
  });
});
