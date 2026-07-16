import { resolveRef } from "./snapshot";
import { clickWithoutScriptNavigation } from "./safe-click";
import type { AgentActionResult, AgentDecision, AgentPhase } from "../types";

export interface BrowserActionContext {
  phase: AgentPhase;
  greetMessage: string;
  forceGreetMessage: boolean;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function isInPageGreetControl(el: HTMLElement, phase: AgentPhase): boolean {
  return phase === "greet" && /立即沟通|打招呼|留在此页|继续沟通|关闭|发送/i.test(el.innerText || el.textContent || "");
}

function findImmediateGreetControl(): HTMLElement | null {
  const candidates = [...document.querySelectorAll<HTMLElement>("button, [role='button'], a, [class*='btn']")]
    .filter(element => /立即沟通|打招呼/.test(element.innerText || element.textContent || ""))
    .filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
    });
  // 优先真正的按钮，避免点击 LLM 选到的包装 span/a 后只触发列表卡片逻辑。
  return candidates.sort((a, b) => {
    const score = (element: HTMLElement): number => {
      if (element.tagName === "BUTTON" || element.getAttribute("role") === "button") return 3;
      if (element.className.toString().toLowerCase().includes("btn")) return 2;
      return 1;
    };
    return score(b) - score(a);
  })[0] || null;
}

// P1-006：ref 元素可能是 <a> 内的 <span>，必须查最近祖先 anchor 的 href，
// 否则点击 span 时跨域校验通过、事件冒泡仍触发外链导航。
function crossDomainAnchorOf(el: HTMLElement): HTMLAnchorElement | null {
  const anchor = el.closest("a");
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  try {
    const u = new URL(anchor.href, location.href);
    if (!/(^|\.)zhipin\.com$/i.test(u.hostname)) return anchor;
    return null;
  } catch { return null; }
}

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

const JOB_LINK_SEL = "a[href*='/job_detail/'], a[href*='/job/']";

export async function executeBrowserAction(d: AgentDecision, ctx: BrowserActionContext): Promise<AgentActionResult> {
  if (d.action === "click" && d.ref !== undefined) {
    const el = resolveRef(d.ref, d.snapshotId);
    if (!el) return { ok: false, message: `控件已失效：${d.ref}` };
    const requestedImmediateGreet = ctx.phase === "greet" && /立即沟通|打招呼/.test(el.innerText || el.textContent || "");
    // LLM 只负责判断“现在应该打招呼”，具体点击目标使用当前页面真实可见的
    // 立即沟通按钮，避免多个包装节点/重复 ref 造成点击列表卡片或点击空壳节点。
    const target = requestedImmediateGreet ? (findImmediateGreetControl() || el) : el;
    const crossDomainAnchor = crossDomainAnchorOf(target);
    const inPageGreetControl = isInPageGreetControl(target, ctx.phase);
    if (crossDomainAnchor && !inPageGreetControl) return { ok: false, message: "跨域导航已拦截" };
    if (crossDomainAnchor && inPageGreetControl) {
      // BOSS 的 SPA 控件可能包在外链样式的 <a> 内；保留站点 click handler，阻止默认导航。
      const preventNavigation = (event: Event): void => {
        const target = event.target instanceof Element ? event.target.closest("a") : null;
        if (target === crossDomainAnchor) event.preventDefault();
      };
      document.addEventListener("click", preventNavigation, true);
      try { clickWithoutScriptNavigation(target); } finally { document.removeEventListener("click", preventNavigation, true); }
    } else {
      clickWithoutScriptNavigation(target);
    }
    await sleep(250);
    if (requestedImmediateGreet) {
      return { ok: true, message: "已点击当前岗位右侧立即沟通", pageMayChange: false, greetStatus: "sent" };
    }
    // 到这里跨域已被拦截，剩余 anchor 均为 zhipin 域内；点 anchor（含嵌套 span）都可能导航
    return { ok: true, message: `已点击：${d.target || d.ref}`, pageMayChange: target.closest("a") !== null };
  }
  if (d.action === "fill" && d.ref !== undefined) {
    const el = resolveRef(d.ref, d.snapshotId);
    if (!el || !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return { ok: false, message: `没有找到输入框：${d.ref}` };
    const value = ctx.forceGreetMessage ? ctx.greetMessage : (d.value ?? "");
    setInputValue(el, value);
    await sleep(150);
    return { ok: true, message: `已填写：${value.slice(0, 20)}` };
  }
  if (d.action === "scroll") {
    const amount = Math.max(100, Math.min(1200, d.amount ?? 600));
    window.scrollBy({ top: d.direction === "up" ? -amount : amount, behavior: "smooth" });
    await sleep(400);
    return { ok: true, message: "已滚动" };
  }
  // P1-002：next_page——点分页控件后等页面变化（url 或首个岗位链接变化）。
  if (d.action === "next_page" && d.ref !== undefined) {
    const el = resolveRef(d.ref, d.snapshotId);
    if (!el) return { ok: false, message: `控件已失效：${d.ref}` };
    const beforeUrl = location.href;
    const beforeFirst = document.querySelector<HTMLAnchorElement>(JOB_LINK_SEL)?.href || "";
    el.click();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const afterFirst = document.querySelector<HTMLAnchorElement>(JOB_LINK_SEL)?.href || "";
      if (location.href !== beforeUrl || afterFirst !== beforeFirst) break;
      await sleep(250);
    }
    return { ok: true, message: "已翻页", pageMayChange: true };
  }
  return { ok: false, message: `非浏览器动作或缺少 ref：${d.action}` };
}
