import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { snapshotPage, resolveRef, resetSnapshotRefs } from "../../src/agent/snapshot";
// 以 ?raw 形式导入合成 fixture（vite 原生支持），保持 fixture 为独立 HTML 片段。
import filterBarHtml from "../fixtures/boss-filter-bar.html?raw";
import jobListHtml from "../fixtures/boss-job-list.html?raw";
import chatHtml from "../fixtures/boss-chat.html?raw";

// jsdom 不执行布局，getBoundingClientRect 恒为 0×0，会触发 snapshotPage 的可见性
// 几何门槛（width/height>0）；这里桩成非零 rect，使 fixture 元素被视为可见。
// 仅测试桩，不影响生产代码。模式参考 tests/agent/snapshot-dom.test.ts。
const rect = { width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;

beforeEach(() => {
  document.body.innerHTML = "";
  resetSnapshotRefs();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("snapshotPage × BOSS-style filter-bar fixture", () => {
  it("把薪资/经验/学历/城市 chip 归类到 currentQuery 对应维度", () => {
    document.body.innerHTML = filterBarHtml;
    const snap = snapshotPage();

    expect(snap.currentQuery.salary).toContain("15-25K");
    expect(snap.currentQuery.experience).toContain("3-5年");
    expect(snap.currentQuery.education).toContain("本科");
    expect(snap.currentQuery.location).toContain("北京");
    expect(snap.currentQuery.jobTypes).toContain("全职");

    // 来自 .search-box 内 input.value
    expect(snap.currentQuery.keyword).toBe("Java");
    expect(snap.currentQuery.source).toBe("search");
  });

  it("filter chip 元素带 region=filter 且 current 字段透出当前值", () => {
    document.body.innerHTML = filterBarHtml;
    const snap = snapshotPage();
    const chips = snap.elements.filter(e => e.region === "filter");
    expect(chips.length).toBeGreaterThanOrEqual(3);
    const salary = chips.find(c => /薪资/.test(c.text));
    expect(salary).toBeTruthy();
    expect(salary!.current).toBe("15-25K");
  });

  it("resolveRef 可回溯到 chip DOM 节点", () => {
    document.body.innerHTML = filterBarHtml;
    const snap = snapshotPage();
    const salary = snap.elements.find(e => e.region === "filter" && /薪资/.test(e.text))!;
    const node = resolveRef(salary.id);
    expect(node).toBeInstanceOf(HTMLElement);
    expect(node?.textContent).toContain("15-25K");
  });
});

describe("snapshotPage × BOSS-style job-list fixture", () => {
  it("岗位卡归类为 region=job，数量符合 fixture", () => {
    document.body.innerHTML = jobListHtml;
    const snap = snapshotPage();
    const jobs = snap.elements.filter(e => e.region === "job");
    // fixture 含 3 个 .job-card-wrapper，至少捕获到其链接/标题元素
    expect(jobs.length).toBeGreaterThanOrEqual(3);
    const titles = jobs.map(j => j.text);
    expect(titles.some(t => /Java 高级工程师/.test(t))).toBe(true);
  });

  it("分页 region=pager 强制保留（含「下一页」）", () => {
    document.body.innerHTML = jobListHtml;
    const snap = snapshotPage();
    const pagers = snap.elements.filter(e => e.region === "pager");
    expect(pagers.length).toBeGreaterThan(0);
    expect(pagers.some(p => /下一页/.test(p.text))).toBe(true);
  });

  it("summary 含岗位计数", () => {
    document.body.innerHTML = jobListHtml;
    const snap = snapshotPage();
    expect(/岗位×/.test(snap.summary)).toBe(true);
  });

  it("pageKind 识别为 jobs", () => {
    document.body.innerHTML = jobListHtml;
    const snap = snapshotPage();
    expect(snap.kind).toBe("jobs");
  });
});

describe("snapshotPage × BOSS-style chat fixture", () => {
  it("chat 区 textarea 与发送按钮被识别（region=chat）", () => {
    document.body.innerHTML = chatHtml;
    const snap = snapshotPage();
    const chats = snap.elements.filter(e => e.region === "chat");
    expect(chats.length).toBeGreaterThanOrEqual(1);

    const input = snap.elements.find(e => e.region === "chat" && e.role === "input");
    expect(input, "chat textarea 应被识别为 input").toBeTruthy();
    expect(input!.text).toContain("您好"); // textarea 已填内容作为 text
  });

  it("发送按钮被识别（role=btn，region=chat）", () => {
    document.body.innerHTML = chatHtml;
    const snap = snapshotPage();
    const send = snap.elements.find(e => e.region === "chat" && e.role === "btn" && /发送/.test(e.text));
    expect(send, "应捕获到「发送」按钮").toBeTruthy();
  });
});
