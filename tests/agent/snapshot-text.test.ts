import { describe, it, expect } from "vitest";
import { classifyChip, serializeSnapshotForLLM, newSnapshotId } from "../../src/agent/snapshot";
import type { PageSnapshot } from "../../src/types";

describe("classifyChip", () => {
  it("maps salary-ish text to salary", () => {
    expect(classifyChip("薪资")).toBe("salary");
    expect(classifyChip("薪水要求")).toBe("salary");
  });
  it("maps experience / education / location", () => {
    expect(classifyChip("工作经验")).toBe("experience");
    expect(classifyChip("学历要求")).toBe("education");
    expect(classifyChip("城市")).toBe("location");
  });
  it("returns null for unknown", () => {
    expect(classifyChip("福利")).toBeNull();
  });
});

describe("serializeSnapshotForLLM", () => {
  it("formats each element compactly with region, current, checked", () => {
    const snap: PageSnapshot = {
      snapshotId: "s1", kind: "jobs", url: "/x", path: "/x",
      currentQuery: { keyword: "", location: [], salary: [], jobTypes: [], workModes: [], experience: [], education: [], industries: [], companySizes: [], source: "unknown" },
      summary: "岗位×1",
      elements: [
        { id: "0", role: "btn", text: "搜索", region: "search" },
        { id: "1", role: "btn", text: "薪资", current: "不限", region: "filter" },
        { id: "2", role: "option", text: "20-30K", checked: true, region: "filter" },
        { id: "3", role: "btn", text: "发送", region: "chat" }
      ]
    };
    const out = serializeSnapshotForLLM(snap);
    expect(out).toContain('[e0] btn "搜索" @search');
    expect(out).toContain('[e1] btn "薪资" cur="不限" @filter');
    expect(out).toContain('[e2] option "20-30K" ✓ @filter');
    expect(out).toContain('[e3] btn "发送" @chat');
  });
});

describe("newSnapshotId", () => {
  it("produces unique ids", () => {
    expect(newSnapshotId()).not.toBe(newSnapshotId());
  });
});
