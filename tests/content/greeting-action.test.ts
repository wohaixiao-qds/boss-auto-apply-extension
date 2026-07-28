import { describe, expect, it } from "vitest";
import { findGreetingAction, isAlreadySentControl, isCommunicationSuccessText } from "../../src/content/greeting-action";
import type { JobItem } from "../../src/shared/types";

const job: JobItem = {
  jobId: "job-1",
  companyName: "示例公司",
  positionName: "前端工程师",
  salary: "20-30K",
  city: "北京",
  url: "https://www.zhipin.com/job_detail/job-1.html",
  status: "pending",
};

describe("greeting action detection", () => {
  it("selects an explicit greeting button instead of generic detail buttons", () => {
    document.body.innerHTML = `
      <section class="job-detail-box">
        <button class="btn">收藏</button>
        <button class="op-btn-chat">立即沟通</button>
      </section>
    `;

    expect(findGreetingAction(document.body, job, job.url)?.textContent).toBe("立即沟通");
  });

  it("returns an already-contacted control so the caller can skip it", () => {
    document.body.innerHTML = `<section class="job-detail-box"><button class="op-btn-chat">继续沟通</button></section>`;

    const action = findGreetingAction(document.body, job, job.url);
    expect(action).not.toBeNull();
    expect(isAlreadySentControl(action!)).toBe(true);
  });

  it("does not select unrelated buttons when no greeting control exists", () => {
    document.body.innerHTML = `<section class="job-detail-box"><button class="btn">举报职位</button></section>`;

    expect(findGreetingAction(document.body, job, job.url)).toBeNull();
  });

  it("recognizes both toast feedback and updated contacted states", () => {
    expect(isCommunicationSuccessText("已向 BOSS 发送消息")).toBe(true);
    expect(isCommunicationSuccessText("打招呼成功")).toBe(true);
    expect(isCommunicationSuccessText("继续沟通")).toBe(true);
    expect(isCommunicationSuccessText("收藏成功")).toBe(false);
  });
});
