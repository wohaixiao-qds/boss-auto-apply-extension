import { describe, expect, it } from "vitest";
import { detectBlockingReason } from "../../src/content/blocking-page";

describe("BOSS blocking page detection", () => {
  it("does not treat remaining greeting quota as exhausted", () => {
    expect(detectBlockingReason("今日打招呼次数还剩 30 次")).toBeUndefined();
  });

  it("stops when BOSS explicitly reports the communication limit", () => {
    expect(detectBlockingReason("您已达到沟通上限")).toContain("今日沟通已达上限");
    expect(detectBlockingReason("您今天已与150位BOSS沟通，休息一下，明天再来吧～")).toContain("今日沟通已达上限");
    expect(detectBlockingReason("今日打招呼次数还剩 0 次")).toContain("今日沟通已达上限");
  });

  it("keeps the existing verification and frequency checks", () => {
    expect(detectBlockingReason("请完成滑动验证")).toContain("安全验证");
    expect(detectBlockingReason("操作频繁，请稍后再试")).toContain("频率限制");
  });
});
