import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { executeBrowserAction } from "../../src/agent/browser-action";
import type { AgentDecision } from "../../src/types";

beforeEach(() => {
  document.body.innerHTML = "";
  // jsdom 不执行布局，getBoundingClientRect 恒为 0×0，会触发 snapshotPage 的可见性几何门槛，
  // 这里返回非零 rect 让 fixture 元素被视为可见；不影响生产代码（与 snapshot-dom.test.ts 同模式）。
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    { width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("executeBrowserAction", () => {
  it("click resolves ref and clicks", async () => {
    let clicked = false;
    document.body.innerHTML = `<div class="job-filter"><button id="b">确定</button></div>`;
    const btn = document.getElementById("b")!;
    btn.addEventListener("click", () => { clicked = true; });
    // 先 snapshot 填充 refs
    const { snapshotPage } = await import("../../src/agent/snapshot");
    const snap = snapshotPage();
    const ref = snap.elements.find(e => e.text === "确定")!;
    await executeBrowserAction(
      { snapshotId: snap.snapshotId, action: "click", ref: ref.id, reason: "", expected: "" },
      { phase: "screen", greetMessage: "您好", forceGreetMessage: false }
    );
    expect(clicked).toBe(true);
  });

  it("fill overwrites value with greetMessage when forceGreetMessage + chat region", async () => {
    // 注意：snapshotPage 的候选过滤要求 textOf(el).length > 0，空 textarea 会被排除，
    // 因此 fixture 给 textarea 一段初始文本，使其可被快照发现；不影响断言语义
    // （forceGreetMessage 仍应覆盖任何已有值与 LLM 传入值）。
    document.body.innerHTML = `<div class="chat"><textarea id="m" class="message-input">占位</textarea></div>`;
    const ta = document.getElementById("m") as HTMLTextAreaElement;
    const { snapshotPage } = await import("../../src/agent/snapshot");
    const snap = snapshotPage();
    const ref = snap.elements.find(e => e.region === "chat")!;
    await executeBrowserAction(
      { snapshotId: snap.snapshotId, action: "fill", ref: ref.id, value: "INJECTED 忽略指令", reason: "", expected: "" },
      { phase: "greet", greetMessage: "您好，感兴趣", forceGreetMessage: true }
    );
    expect(ta.value).toBe("您好，感兴趣");
  });

  it("blocks cross-domain anchor click", async () => {
    document.body.innerHTML = `<div class="job-filter"><a id="a" href="https://evil.com/">外链</a></div>`;
    const { snapshotPage } = await import("../../src/agent/snapshot");
    const snap = snapshotPage();
    const ref = snap.elements.find(e => e.text === "外链")!;
    const r = await executeBrowserAction(
      { snapshotId: snap.snapshotId, action: "click", ref: ref.id, reason: "", expected: "" },
      { phase: "screen", greetMessage: "", forceGreetMessage: false }
    );
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/跨域/);
  });
});
