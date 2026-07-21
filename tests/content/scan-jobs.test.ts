import { describe, expect, it } from "vitest";
import { scanJobs } from "../../src/content/scanner";

describe("BOSS job scanning", () => {
  it("extracts company, position, city, and URL from job cards", () => {
    document.body.innerHTML = `
      <ul class="job-list">
        <li class="job-card-wrapper" data-jobid="job-123">
          <a href="https://www.zhipin.com/job_detail/job-123.html">
            <span class="job-name">前端工程师</span>
          </a>
          <span class="company">星河科技</span>
          <span class="salary">20-35K</span>
          <span class="job-area">上海</span>
        </li>
      </ul>
    `;

    expect(scanJobs().jobs).toEqual([
      {
        jobId: "job-123",
        companyName: "星河科技",
        positionName: "前端工程师",
        salary: "20-35K",
        city: "上海",
        url: "https://www.zhipin.com/job_detail/job-123.html",
        sourceText: "前端工程师 星河科技 20-35K 上海",
        status: "pending",
      },
    ]);
  });

  it("ignores non-job information entries", () => {
    document.body.innerHTML = `
      <ul class="job-list">
        <li class="job-card-wrapper" data-jobid="info-123">
          <a href="https://www.zhipin.com/job_detail/info-123.html">查看更多信息</a>
        </li>
        <li class="job-card-wrapper" data-jobid="job-456">
          <a href="https://www.zhipin.com/job_detail/job-456.html"><span class="job-title">Java 工程师</span></a>
          <span class="company">云杉科技</span>
        </li>
      </ul>
    `;

    expect(scanJobs().jobs.map((job) => job.jobId)).toEqual(["job-456"]);
  });

  it("recognizes a BOSS card that is already marked as contacted", () => {
    document.body.innerHTML = `
      <li class="job-card-wrapper" data-jobid="job-789">
        <a href="https://www.zhipin.com/job_detail/job-789.html"><span class="job-title">产品经理</span></a>
        <span class="company">青禾软件</span>
        <span class="salary">25-40K</span>
        <button class="op-btn-chat">继续沟通</button>
      </li>
    `;

    expect(scanJobs().jobs[0]).toMatchObject({ jobId: "job-789", status: "sent" });
  });

  it("uses the detail URL ID over a different list-card ID", () => {
    document.body.innerHTML = `
      <li class="job-card-wrapper" data-jobid="041903">
        <a href="https://www.zhipin.com/job_detail/ddc3bb52d698842f0nZ82tm4EFpW.html">
          <span class="job-title">前端开发</span>
        </a>
        <span class="company">示例公司</span>
      </li>
    `;

    expect(scanJobs().jobs[0].jobId).toBe("ddc3bb52d698842f0nZ82tm4EFpW");
  });

  it("extracts company names from company profile links", () => {
    document.body.innerHTML = `
      <li class="job-card-wrapper" data-jobid="job-company-link">
        <a href="https://www.zhipin.com/job_detail/job-company-link.html"><span class="job-title">后端工程师</span></a>
        <a href="https://www.zhipin.com/gongsi/company-1.html">北辰科技有限公司</a>
        <span class="salary">18-30K</span>
      </li>
    `;

    expect(scanJobs().jobs[0]).toMatchObject({ companyName: "北辰科技有限公司", salary: "18-30K" });
  });

  it("does not use a location node as the company name and can parse salary text", () => {
    document.body.innerHTML = `
      <li class="job-card-wrapper" data-jobid="job-location-company">
        <a href="https://www.zhipin.com/job_detail/job-location-company.html"><span class="job-title">前端工程师</span></a>
        <span class="company">北京·海淀区·苏州桥</span>
        <span class="job-location">北京·海淀区·苏州桥</span>
        <span class="job-summary">15-25K·13薪</span>
      </li>
    `;

    expect(scanJobs().jobs[0]).toMatchObject({ companyName: "未识别公司", salary: "15-25K·13薪" });
  });

  it("parses salary from a BOSS job-limit node", () => {
    document.body.innerHTML = `
      <li class="job-card-wrapper" data-jobid="job-limit-salary">
        <a href="https://www.zhipin.com/job_detail/job-limit-salary.html"><span class="job-title">测试工程师</span></a>
        <span class="company-name">北辰科技</span>
        <span class="job-limit">13–24K·13薪</span>
      </li>
    `;

    expect(scanJobs().jobs[0].salary).toBe("13-24K·13薪");
  });
});
