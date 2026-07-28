import type { JobItem } from "../shared/types";
import { extractId, getJobId, normalize } from "./scanner";

const GREETING_LABEL_PATTERN = /立即沟通|打招呼|立即联系|聊一聊|聊聊职位|和.{0,8}聊聊|沟通职位/;
const SENT_LABEL_PATTERN = /已沟通|已发送|已打招呼|继续沟通|继续聊聊/;
const SUCCESS_FEEDBACK_PATTERN = /已向\s*BOSS\s*发送消息|已发送消息|发送成功|消息已发出|沟通成功|打招呼成功|已打招呼|已沟通|继续沟通/;
const CONTROL_SELECTOR = "button, a, [role='button'], .op-btn-chat, [class*='op-btn-chat'], [ka^='cpc_job_list_chat_']";

export function findGreetingAction(root: Element, job: JobItem, currentUrl = location.href): HTMLElement | null {
  const elements = [...root.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)].filter(isUsableGreetingControl);
  const dedicatedPage = extractId(currentUrl) === job.jobId;
  const ranked = elements.map((element) => ({ element, score: scoreGreetingAction(element, job, root, dedicatedPage) }));
  return ranked.sort((left, right) => right.score - left.score).find((item) => item.score >= 100)?.element ?? null;
}

export function isAlreadySentControl(element: HTMLElement): boolean {
  return SENT_LABEL_PATTERN.test(controlLabel(element));
}

export function isCommunicationSuccessText(value: string): boolean {
  return SUCCESS_FEEDBACK_PATTERN.test(normalize(value));
}

function scoreGreetingAction(element: HTMLElement, job: JobItem, root: Element, dedicatedPage: boolean): number {
  const label = controlLabel(element);
  const ka = element.getAttribute("ka") || "";
  const dedicatedControl = element.matches(".op-btn-chat, [class*='op-btn-chat']") || ka.startsWith("cpc_job_list_chat_");
  const associated = hasJobAssociation(element, job.jobId);
  const sent = SENT_LABEL_PATTERN.test(label);
  const greeting = GREETING_LABEL_PATTERN.test(label);

  if (!sent && !greeting && !dedicatedControl) return Number.NEGATIVE_INFINITY;
  if (root === document.body && !associated && !dedicatedPage) return Number.NEGATIVE_INFINITY;

  let score = 0;
  if (sent) score += 220;
  if (greeting) score += 180;
  if (dedicatedControl) score += 120;
  if (associated) score += 140;
  if (element.closest(".job-detail-op, .job-detail-header, .job-detail-box, .job-detail-container, [class*='job-detail']")) score += 40;
  if (element.tagName === "BUTTON" || element.getAttribute("role") === "button") score += 20;
  return score;
}

function isUsableGreetingControl(element: HTMLElement): boolean {
  if (element.hidden || element.getAttribute("aria-disabled") === "true" || (element instanceof HTMLButtonElement && element.disabled)) return false;
  const nestedControl = element.querySelector(CONTROL_SELECTOR);
  if (nestedControl && element.tagName !== "BUTTON" && element.tagName !== "A" && element.getAttribute("role") !== "button") return false;
  return element.tagName === "BUTTON"
    || element.tagName === "A"
    || element.getAttribute("role") === "button"
    || element.matches(".op-btn-chat, [class*='op-btn-chat'], [ka^='cpc_job_list_chat_']");
}

function controlLabel(element: HTMLElement): string {
  return normalize([
    element.innerText || element.textContent || "",
    element.getAttribute("aria-label") || "",
    element.getAttribute("title") || "",
  ].join(" "));
}

function hasJobAssociation(element: HTMLElement, jobId: string): boolean {
  if (!jobId) return false;
  let current: Element | null = element;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const directValues = [
      current.getAttribute("data-jobid"),
      current.getAttribute("data-job-id"),
      current.getAttribute("data-lid"),
      current.getAttribute("data-id"),
      current.getAttribute("ka"),
    ].filter(Boolean).join(" ");
    if (directValues.includes(jobId)) return true;

    const link = current.matches("a[href]")
      ? current as HTMLAnchorElement
      : current.querySelector<HTMLAnchorElement>('a[href*="/job_detail/"], a[href*="/job/"]');
    if (link && extractId(link.href) === jobId) return true;
    current = current.parentElement;
  }
  return false;
}
