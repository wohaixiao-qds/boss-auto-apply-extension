import { describe, expect, it } from "vitest";
import { extractJobIdFromUrl, hasSendableJobTarget, normalizeBossJobUrl } from "../../src/shared/job-target";

describe("sendable BOSS job targets", () => {
  it("accepts only BOSS job URLs whose ID matches the queued job", () => {
    expect(hasSendableJobTarget({ jobId: "abc123", url: "https://www.zhipin.com/job_detail/abc123.html" })).toBe(true);
    expect(hasSendableJobTarget({ jobId: "abc123", url: "https://www.zhipin.com/job_detail/other.html" })).toBe(false);
    expect(hasSendableJobTarget({ jobId: "abc123", url: "https://www.zhipin.com/gongsi/example.html" })).toBe(false);
  });

  it("normalizes relative job URLs and rejects other hosts", () => {
    expect(normalizeBossJobUrl("/job_detail/abc123.html")).toBe("https://www.zhipin.com/job_detail/abc123.html");
    expect(normalizeBossJobUrl("https://example.com/job_detail/abc123.html")).toBe("");
    expect(extractJobIdFromUrl("https://www.zhipin.com/job/abc123")).toBe("abc123");
  });
});
