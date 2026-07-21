import { describe, expect, it } from "vitest";
import { createEmptyTask, getProgress, randomDelay, type TaskState } from "../../src/shared/types";

describe("task helpers", () => {
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
    expect(randomDelay({ minDelayMs: 1000, maxDelayMs: 3000, batchLimit: 10, excludeOutsourcing: true }, 0.5)).toBe(2000);
  });
});
