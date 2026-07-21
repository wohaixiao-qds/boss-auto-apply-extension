import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/sandbox";
import { extractId, findJobCards, getJobId, isBossJobMarkedSent, normalize, scanJobs } from "../src/content/scanner";
import { parseApiJobs } from "../src/content/api-parser";
import type { JobItem, RuntimeMessage, SendResult } from "../src/shared/types";

let latestApiJobs: JobItem[] = [];

export default defineContentScript({
  matches: ["https://www.zhipin.com/*", "https://zhipin.com/*"],
  runAt: "document_start",
  main() {
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.data?.source !== "boss-auto-apply-api-bridge") return;
      const jobs = parseApiJobs(event.data.payload);
      if (jobs.length > 0) latestApiJobs = jobs;
    });

    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const typedMessage = message as RuntimeMessage;
      if (typedMessage.type === "SCAN_JOBS") {
        sendResponse(latestApiJobs.length > 0 ? { jobs: latestApiJobs, source: "api" } : { ...scanJobs(), source: "dom" });
        return true;
      }
      if (typedMessage.type === "SEND_JOB") {
        void sendGreeting(typedMessage.job, typedMessage.context ?? "list").then(sendResponse);
        return true;
      }
      return true;
    });
  },
});

async function sendGreeting(job: JobItem, context: "list" | "detail-tab"): Promise<SendResult> {
  if (context === "detail-tab") return sendGreetingInDetailTab(job);
  return sendGreetingFromList(job);
}

async function sendGreetingInDetailTab(job: JobItem): Promise<SendResult> {
  const currentJobId = extractId(location.href);
  if (currentJobId && currentJobId !== job.jobId) {
    return { status: "paused", reason: `详情页职位 ID ${currentJobId} 与目标 ${job.jobId} 不一致。` };
  }
  const blocked = detectBlockingPage();
  if (blocked) return { status: "paused", reason: blocked };

  const action = await waitForGreetingAction(job);
  if (!action) return { status: "paused", reason: `详情页未找到与职位 ${job.jobId} 关联的“立即沟通”按钮。` };
  if (isAlreadySent(action)) return { status: "skipped", reason: "BOSS 已标记该职位为已沟通。" };

  const feedbackTracker = createFeedbackTracker();
  safeClick(action);
  await delay(450);

  const confirmation = findConfirmationAction();
  if (confirmation && confirmation !== action) {
    safeClick(confirmation);
  }

  const result = await waitForSendOutcome(action, feedbackTracker);
  if (result.status === "sent") closeSuccessDialog();
  return result;
}

async function waitForGreetingAction(job: JobItem): Promise<HTMLElement | null> {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const action = findGreetingAction(document.body, job);
    if (action) return action;
    await delay(250);
  }
  return null;
}

async function sendGreetingFromList(job: JobItem): Promise<SendResult> {
  const blocked = detectBlockingPage();
  if (blocked) return { status: "paused", reason: blocked };
  const listPath = location.pathname;
  if (!isJobListPage()) return { status: "paused", reason: "当前页面不是 BOSS 职位列表，已暂停发送。" };

  const card = findJobCards().find((candidate) => matchesJob(candidate, job));
  if (!card) return { status: "failed", reason: `当前列表找不到“${job.positionName}”对应的职位卡片。` };

  // BOSS 列表通常是“左侧职位卡 + 右侧详情”，先选中卡片再找右侧的立即沟通按钮。
  await activateJobCard(card, job);

  const action = findGreetingAction(card, job) || findGreetingAction(document.body, job);
  if (!action) return { status: "paused", reason: `未找到与职位 ${job.jobId} 关联的“立即沟通”按钮，任务已暂停以避免误点其他职位。` };
  if (isAlreadySent(action)) return { status: "skipped", reason: "该职位可能已经打过招呼。" };

  const feedbackTracker = createFeedbackTracker();
  safeClick(action);
  await delay(450);
  if (location.pathname !== listPath || !isJobListPage()) {
    feedbackTracker.observer.disconnect();
    return { status: "paused", reason: "点击后离开了 BOSS 职位列表，任务已暂停。" };
  }

  // 某些版本会在预填充默认话术后再显示一次确认按钮。
  const confirmation = findConfirmationAction();
  if (confirmation && confirmation !== action) {
    safeClick(confirmation);
    await delay(350);
    if (location.pathname !== listPath || !isJobListPage()) {
      feedbackTracker.observer.disconnect();
      return { status: "paused", reason: "确认发送后离开了 BOSS 职位列表，任务已暂停。" };
    }
  }

  const result = await waitForSendOutcome(action, feedbackTracker);
  if (result.status === "sent") {
    closeSuccessDialog();
    await waitForBossListStatus(card);
  }
  return result;
}

function findGreetingAction(root: Element, job: JobItem): HTMLElement | null {
  const elements = [...root.querySelectorAll<HTMLElement>("button, a, [role=button], [class*='btn'], [class*='op-btn-chat'], [ka^='cpc_job_list_chat_']")]
    .filter(isUsableGreetingControl);
  const ranked = elements.map((element) => {
    const label = normalize(element.textContent ?? "");
    const ka = element.getAttribute("ka") || "";
    let score = 0;
    if (/立即沟通/.test(label)) score += 100;
    if (/打招呼/.test(label)) score += 90;
    if (/沟通/.test(label)) score += 20;
    if (element.matches(".op-btn-chat, [class*='op-btn-chat']")) score += 60;
    if (ka.startsWith("cpc_job_list_chat_")) score += 70;
    if (element.tagName === "BUTTON") score += 40;
    if (element.tagName === "A") score += 25;
    if (element.getAttribute("role") === "button") score += 35;
    if (job.jobId && (ka.includes(job.jobId) || getJobId(element.closest<HTMLElement>(".job-card-wrap, .job-card-box, .job-card-wrapper, .job-primary, li, article, .job-card") || element, "") === job.jobId)) score += 100;
    if (element.closest(".job-detail-op, .job-detail-header, .job-detail-box, .job-detail-container, [class*='job-detail']")) score += 25;
    const isDedicatedJobPage = extractId(location.href) === job.jobId;
    if (root === document.body && !hasJobAssociation(element, job.jobId) && !isDedicatedJobPage) score -= 1000;
    if (isAlreadySent(element)) score -= 200;
    return { element, score };
  });
  return ranked.sort((a, b) => b.score - a.score).find((item) => item.score >= 50)?.element ?? null;
}

function isUsableGreetingControl(element: HTMLElement): boolean {
  const hasDescendantControl = Boolean(element.querySelector("button, a, [role=button], .op-btn-chat, [class*='op-btn-chat'], [ka^='cpc_job_list_chat_']"));
  if (hasDescendantControl && element.tagName !== "BUTTON" && element.tagName !== "A" && element.getAttribute("role") !== "button") return false;

  const isInteractive = element.tagName === "BUTTON"
    || element.tagName === "A"
    || element.getAttribute("role") === "button"
    || element.matches(".op-btn-chat, [class*='op-btn-chat'], [ka^='cpc_job_list_chat_']");
  if (isInteractive) return true;

  // 避免选择包裹真实按钮的 span/div；点击外层通常不会触发 BOSS 的沟通逻辑。
  return !hasDescendantControl;
}

function findConfirmationAction(): HTMLElement | null {
  const dialogs = [...document.querySelectorAll<HTMLElement>("[role='dialog'], [class*='dialog'], [class*='modal'], [class*='layer'], [class*='popup']")];
  const buttons = dialogs.flatMap((dialog) => [...dialog.querySelectorAll<HTMLElement>("button, a, [role=button], [class*='btn']")]);
  return buttons.find((button) => /^(确认发送|立即发送|发送消息|发送)$/.test(normalize(button.textContent ?? ""))) ?? null;
}

function closeSuccessDialog(): void {
  const dialogs = [...document.querySelectorAll<HTMLElement>("[role='dialog'], [class*='dialog'], [class*='modal'], [class*='layer'], [class*='popup']")];
  const successDialog = dialogs.find((dialog) => successPattern.test(normalize(dialog.innerText || dialog.textContent || "")));
  if (!successDialog) return;

  const closeButton = [...successDialog.querySelectorAll<HTMLElement>("button, a, [role='button'], [class*='btn'], [class*='close']")]
    .find((button) => /留在此页|关闭|知道了|完成|^确定$|^×$|^x$/i.test(normalize(button.innerText || button.textContent || button.getAttribute("aria-label") || "")));
  if (closeButton) {
    safeClick(closeButton);
    return;
  }

  successDialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}

async function waitForBossListStatus(card: HTMLElement): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (isBossJobMarkedSent(card)) return;
    await delay(250);
  }
}

async function activateJobCard(card: HTMLElement, job: JobItem): Promise<void> {
  card.scrollIntoView?.({ block: "center", behavior: "instant" as ScrollBehavior });
  safeClick(card);
  await delay(350);

  // BOSS 某些版本把选中逻辑绑定在职位详情链接上。点击链接的事件处理，
  // 但阻止它真正导航到职位详情或对话页。
  if (!isCardSelected(card)) {
    const link = card.querySelector<HTMLAnchorElement>('a[href*="/job_detail/"], a[href*="/job/"]');
    if (link && (extractId(link.href) === job.jobId || link.href.includes(job.jobId))) {
      safeClick(link);
      await delay(450);
    }
  }
}

function isCardSelected(card: HTMLElement): boolean {
  const markers = [card, card.parentElement, card.closest("li, [role='listitem'], [role='option']")]
    .filter((element): element is HTMLElement => Boolean(element));
  return markers.some((element) => (
    element.getAttribute("aria-selected") === "true"
    || element.getAttribute("aria-current") === "true"
    || /selected|active|current/.test(String(element.className || "").toLowerCase())
  ));
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

/**
 * Keep BOSS's own click handlers, but prevent automatic navigation from list cards,
 * chat links, and modal controls. The old implementation only blocked javascript:
 * URLs, so a normal chat href could still take the task out of the job list.
 */
function safeClick(element: HTMLElement): void {
  const preventNavigation = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (target) event.preventDefault();
  };
  document.addEventListener("click", preventNavigation, true);
  try {
    // HTMLElement.click() 会触发 BOSS 组件实际使用的原生激活逻辑；
    // 手工 dispatchEvent 在部分 Vue/React 控件上只触发了事件监听，却没有执行控件动作。
    element.click();
  } finally {
    document.removeEventListener("click", preventNavigation, true);
  }
}

function isJobListPage(): boolean {
  return /\/web\/geek\/jobs(?:\/|$)/i.test(location.pathname)
    || Boolean(document.querySelector(".job-card-wrap, .job-card-box, .job-card-wrapper, .job-primary, [ka='job-card'], [data-jobid]"));
}

function matchesJob(card: HTMLElement, job: JobItem): boolean {
  const link = card.querySelector<HTMLAnchorElement>('a[href*="/job_detail/"], a[href*="/job/"]') ?? card.closest<HTMLAnchorElement>("a[href]");
  const samePath = (left: string, right: string): boolean => {
    try {
      return new URL(left, location.href).pathname.replace(/\/+$/, "") === new URL(right, location.href).pathname.replace(/\/+$/, "");
    } catch {
      return false;
    }
  };
  const cardText = normalize(card.innerText || card.textContent || "");
  return Boolean(
    (job.url && link?.href && samePath(link.href, job.url))
    || (job.jobId && getJobId(card, link?.href || "") === job.jobId),
  );
}

function detectBlockingPage(): string | undefined {
  const text = normalize(document.body.innerText);
  if (/验证码|安全验证|滑动验证|行为异常/.test(text)) return "检测到验证码或安全验证，任务已暂停。";
  if (/登录|请先登录/.test(text) && !/职位|公司/.test(text)) return "BOSS 登录状态已失效，任务已暂停。";
  if (/操作频繁|访问过于频繁|稍后再试/.test(text)) return "检测到平台频率限制，任务已暂停。";
  return undefined;
}

interface FeedbackTracker {
  before: Map<HTMLElement, string>;
  observer: MutationObserver;
  successMutationDetected: () => boolean;
}

function createFeedbackTracker(): FeedbackTracker {
  const before = new Map(getSuccessFeedbackNodes().map((node) => [node, feedbackText(node)]));
  let successMutationDetected = false;
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const touchedNodes = [mutation.target, ...Array.from(mutation.addedNodes)];
      if (touchedNodes.some((node) => successPattern.test(normalize(nodeText(node))))) {
        successMutationDetected = true;
        break;
      }
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  return { before, observer, successMutationDetected: () => successMutationDetected };
}

async function waitForSendOutcome(action: HTMLElement, tracker: FeedbackTracker): Promise<SendResult> {
  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const blocked = detectBlockingPage();
      if (blocked) return { status: "paused", reason: blocked };
      if (isAlreadySent(action)) return { status: "sent" };
      if (hasNewSuccessFeedback(tracker) || (tracker.successMutationDetected() && getSuccessFeedbackNodes().length > 0)) {
        return { status: "sent" };
      }
      await delay(250);
    }
    return { status: "failed", reason: "本次点击后未检测到新的发送成功反馈，请检查页面状态。" };
  } finally {
    tracker.observer.disconnect();
  }
}

const successPattern = /已向\s*BOSS\s*发送消息|已发送消息|发送成功|消息已发出|沟通成功/;

function getSuccessFeedbackNodes(): HTMLElement[] {
  const selectors = "[role='alert'], .toast, [class*='toast'], [class*='notify'], [class*='message'], [class*='dialog'], [class*='modal'], [class*='success']";
  return [...document.querySelectorAll<HTMLElement>(selectors)].filter((node) => successPattern.test(feedbackText(node)));
}

function feedbackText(node: HTMLElement): string {
  return normalize(node.innerText || node.textContent || "");
}

function nodeText(node: Node): string {
  return node instanceof HTMLElement ? feedbackText(node) : normalize(node.textContent || "");
}

function hasNewSuccessFeedback(tracker: FeedbackTracker): boolean {
  return getSuccessFeedbackNodes().some((node) => tracker.before.get(node) !== feedbackText(node));
}

function isAlreadySent(element: HTMLElement): boolean {
  return /已沟通|已发送|已打招呼|继续沟通/.test(normalize(element.textContent ?? ""));
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
