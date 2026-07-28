import { describe, expect, it } from "vitest";
import { isJobListApiUrl, parseApiJobs } from "../../src/content/api-parser";

describe("BOSS API job parser", () => {
  it("only accepts job-list API responses for page collection", () => {
    expect(isJobListApiUrl("https://www.zhipin.com/wapi/zpgeek/search/joblist.json?city=101010100")).toBe(true);
    expect(isJobListApiUrl("https://www.zhipin.com/wapi/zpgeek/job/detail.json")).toBe(false);
  });

  it("extracts company, salary, city, and canonical detail URL id", () => {
    const jobs = parseApiJobs({
      zpData: {
        jobList: [{
          encryptJobId: "ddc3bb52d698842f0nZ82tm4EFpW",
          jobName: "前端开发",
          brandName: "信通赛克科技有限公司",
          salaryDesc: "13-24K·13薪",
          cityName: "北京",
        }],
      },
    });

    expect(jobs[0]).toMatchObject({
      jobId: "ddc3bb52d698842f0nZ82tm4EFpW",
      companyName: "信通赛克科技有限公司",
      salary: "13-24K·13薪",
      city: "北京",
    });
  });

  it("ignores more-information records", () => {
    expect(parseApiJobs({ id: "123", title: "查看更多信息", companyName: "公司", salary: "20K" })).toEqual([]);
  });
});
