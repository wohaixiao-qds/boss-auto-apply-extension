import { describe, expect, it } from "vitest";
import { createEmptyTask, getProgress, getSendDisposition, MAX_BATCH_LIMIT, randomDelay, type TaskState } from "../../src/shared/types";

describe("task helpers", () => {
  it("caps the configurable batch size at 150", () => {
    expect(MAX_BATCH_LIMIT).toBe(150);
  });

  it("creates an idle task", () => {
    expect(createEmptyTask()).toMatchObject({ status: "idle", jobs: {}, queue: [], currentIndex: 0 });
  });

  it("calculates bounded progress", () => {
    const task = {
      ...createEmptyTask(),
      jobs: {
        "1": {
          jobId: "1",
          companyName: "公司",
          positionName: "职位",
          salary: "20K",
          city: "城市",
          url: "https://www.zhipin.com/job_detail/1.html",
          status: "sent",
        },
      },
      queue: ["1"],
      currentIndex: 1,
    } as TaskState;
    expect(getProgress(task)).toBe(100);
  });

  it("calculates a deterministic random delay", () => {
    expect(randomDelay({ minDelayMs: 1000, maxDelayMs: 3000, batchLimit: 10, excludeOutsourcing: true, excludeHeadhunter: true, dailyLimit: 50 }, 0.5)).toBe(2000);
  });

  it("continues after a job failure but pauses on a hard blocker", () => {
    expect(getSendDisposition({ status: "failed", reason: "按钮不可用" })).toEqual({
      jobStatus: "failed",
      pauseTask: false,
      advanceQueue: true,
    });
    expect(getSendDisposition({ status: "paused", reason: "检测到验证码" })).toEqual({
      jobStatus: "pending",
      pauseTask: true,
      advanceQueue: false,
    });
  });
});
