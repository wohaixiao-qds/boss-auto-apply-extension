import { resolveRef } from "./snapshot";
import type { AgentActionResult, AgentDecision, AgentPhase } from "../types";

export interface BrowserActionContext {
  phase: AgentPhase;
  greetMessage: string;
  forceGreetMessage: boolean;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function isCrossDomainAnchor(el: HTMLElement): boolean {
  if (!(el instanceof HTMLAnchorElement)) return false;
  try {
    const u = new URL(el.href, location.href);
    return !/(^|\.)zhipin\.com$/i.test(u.hostname);
  } catch { return false; }
}

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

export async function executeBrowserAction(d: AgentDecision, ctx: BrowserActionContext): Promise<AgentActionResult> {
  if (d.action === "click" && d.ref !== undefined) {
    const el = resolveRef(d.ref);
    if (!el) return { ok: false, message: `控件已失效：${d.ref}` };
    if (isCrossDomainAnchor(el)) return { ok: false, message: "跨域导航已拦截" };
    el.click();
    await sleep(250);
    return { ok: true, message: `已点击：${d.target || d.ref}`, pageMayChange: el instanceof HTMLAnchorElement };
  }
  if (d.action === "fill" && d.ref !== undefined) {
    const el = resolveRef(d.ref);
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
  return { ok: false, message: `非浏览器动作或缺少 ref：${d.action}` };
}
