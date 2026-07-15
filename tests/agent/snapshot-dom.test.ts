import { describe, it, expect, beforeEach } from "vitest";
import { snapshotPage, resolveRef, resetSnapshotRefs } from "../../src/agent/snapshot";

beforeEach(() => {
  document.body.innerHTML = "";
  resetSnapshotRefs();
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
});
