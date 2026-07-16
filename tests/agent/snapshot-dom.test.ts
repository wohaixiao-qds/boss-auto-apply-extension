import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { snapshotPage, resolveRef, resetSnapshotRefs } from "../../src/agent/snapshot";

beforeEach(() => {
  document.body.innerHTML = "";
  resetSnapshotRefs();
  // jsdom 不执行布局，getBoundingClientRect 恒为 0×0，会触发真实浏览器下的可见性几何门槛，
  // 这里仅在测试桩中返回非零 rect，让 fixture 元素被视为可见；不影响生产代码。
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    { width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("snapshotPage", () => {
  it("extracts filter chip with current value and derives currentQuery.salary", () => {
    document.body.innerHTML = `
      <div class="search-condition">
        <a class="filter-item" href="#">薪资不限</a>
      </div>`;
    // 构造一个文本=薪资、带当前值的 chip
    const bar = document.querySelector(".search-condition")!;
    bar.innerHTML = `<a class="filter-item">薪资<span class="cur">不限</span></a>`;
    const snap = snapshotPage();
    const chip = snap.elements.find(e => e.region === "filter");
    expect(chip).toBeTruthy();
    expect(snap.currentQuery.salary).toEqual([]); // "不限" 视为未设置
  });

  it("assigns stable per-snapshot ids and resolveRef round-trips", () => {
    document.body.innerHTML = `<div class="job-filter"><a class="filter-item">经验 3-5年</a></div>`;
    const snap = snapshotPage();
    const ref = snap.elements[0];
    const node = resolveRef(ref.id);
    expect(node).toBeInstanceOf(HTMLElement);
    expect(node?.textContent).toContain("经验");
  });

  it("keeps refs isolated when another observer creates a newer snapshot", () => {
    document.body.innerHTML = `<div class="job-filter"><button id="first">第一批</button></div>`;
    const first = snapshotPage();
    const firstRef = first.elements.find(e => e.text === "第一批")!;

    document.body.insertAdjacentHTML("beforeend", `<div class="job-filter"><button id="second">第二批</button></div>`);
    const second = snapshotPage();

    expect(resolveRef(firstRef.id, first.snapshotId)?.id).toBe("first");
    expect(resolveRef(second.elements.find(e => e.text === "第二批")!.id, second.snapshotId)?.id).toBe("second");
  });

  it("resolveRef returns null for detached node", () => {
    document.body.innerHTML = `<div class="job-filter"><a id="x">薪资</a></div>`;
    const snap = snapshotPage();
    const ref = snap.elements[0];
    (document.getElementById("x") as HTMLElement).remove();
    expect(resolveRef(ref.id)).toBeNull();
  });

  it("forces pager region retention even with many job cards", () => {
    const cards = Array.from({ length: 40 }, (_, i) => `<li class="job-card-wrapper"><a href="/job_detail/${i}">job${i}</a></li>`).join("");
    document.body.innerHTML = `<ul class="job-list">${cards}</ul><div class="pager"><a class="next">下一页</a></div>`;
    const snap = snapshotPage();
    expect(snap.elements.some(e => e.region === "pager")).toBe(true);
  });

  it("keeps the greeting control after the job snapshot budget is exhausted", () => {
    const cards = Array.from({ length: 40 }, (_, i) => `<li class="job-card-wrapper"><a href="/job_detail/${i}">job${i}</a></li>`).join("");
    document.body.innerHTML = `
      <div class="job-list-container job-card-box">
        <ul class="job-list">${cards}</ul>
        <div class="job-detail"><button>立即沟通</button></div>
      </div>`;

    const snap = snapshotPage();
    const greet = snap.elements.find(e => e.text === "立即沟通");
    expect(greet).toBeTruthy();
    expect(greet?.region).toBe("job");
    expect(resolveRef(greet!.id)?.textContent).toContain("立即沟通");
  });

  it("classifies BOSS detail controls as job controls before filter ancestors", () => {
    document.body.innerHTML = `
      <div class="filter-condition">
        <div class="recommend-result-job">
          <div class="job-detail-container">
            <div class="job-detail-box">
              <div class="job-detail-op"><a class="op-btn op-btn-chat" ka="cpc_job_list_chat_job123">立即沟通</a></div>
            </div>
          </div>
        </div>
      </div>`;
    const snap = snapshotPage();
    const greet = snap.elements.find(e => e.text === "立即沟通");
    expect(greet?.region).toBe("job");
    expect(resolveRef(greet!.id)?.getAttribute("ka")).toBe("cpc_job_list_chat_job123");
  });

  it("keeps empty textarea with placeholder in chat region", () => {
    document.body.innerHTML = `<div class="chat-container"><textarea class="message-input" placeholder="请输入招呼语"></textarea></div>`;
    const snap = snapshotPage();
    const ta = snap.elements.find(e => e.role === "input");
    expect(ta).toBeTruthy();
    expect(ta!.text).toBe("");
    expect(ta!.region).toBe("chat");
    expect(ta!.hint).toBe("请输入招呼语");
  });

  it("keeps empty search input with placeholder in search region", () => {
    document.body.innerHTML = `<div class="search-box"><input class="search-input" placeholder="搜索职位/公司" /></div>`;
    const snap = snapshotPage();
    const inp = snap.elements.find(e => e.role === "input");
    expect(inp).toBeTruthy();
    expect(inp!.text).toBe("");
    expect(inp!.region).toBe("search");
    expect(inp!.hint).toBe("搜索职位/公司");
  });

  it("does not dedupe multiple empty inputs with different placeholders", () => {
    document.body.innerHTML = `
      <div class="search-box"><input placeholder="搜索职位" /></div>
      <div class="chat-container"><textarea placeholder="请输入招呼语"></textarea></div>`;
    const snap = snapshotPage();
    const inputs = snap.elements.filter(e => e.role === "input");
    expect(inputs.length).toBe(2);
    const hints = inputs.map(e => e.hint).sort();
    expect(hints).toEqual(["搜索职位", "请输入招呼语"]);
  });
});
