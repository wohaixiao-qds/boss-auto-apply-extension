import { AgentRunner } from "./agent/workflow";
import { snapshotPage, resolveRef, classifyChip } from "./agent/snapshot";
import { executeBrowserAction } from "./agent/browser-action";
import { clickWithoutScriptNavigation } from "./agent/safe-click";
import { validateDecision } from "./agent/validate";
import { buildAgentIntent } from "./agent/intent";
import { buildBossJobsUrl } from "./agent/boss-url";
import type { AgentActionResult, AgentDecision, AgentTools, Job, RuntimeAction, Settings } from "./types";

// 扩展重载后可能通过 chrome.scripting 再次注入本文件；页面内只允许一个 runner 真正执行动作。
const contentScriptGlobal = globalThis as typeof globalThis & { __bossAutoApplyContentScript?: boolean };
const isPrimaryContentScript = !contentScriptGlobal.__bossAutoApplyContentScript;
if (isPrimaryContentScript) contentScriptGlobal.__bossAutoApplyContentScript = true;

let contextDead = false;
let listenTimer: ReturnType<typeof setInterval> | null = null;
type CollectedOption = { text: string; code: string; sourceKey: string; tag: string; cls: string; outer: string; parentOuter: string };
let listenBatches: Array<CollectedOption[]> = [];
let listenBaseSet: Set<string> = new Set();

function compactOuterHtml(element: Element | null, maxLength = 900): string {
  return element?.outerHTML.replace(/\s+/g, " ").trim().slice(0, maxLength) || "";
}

function optionCode(element: HTMLElement, holder: Element | null = null): string {
  const direct = element.dataset.val
    || element.dataset.value
    || element.getAttribute("value")
    || element.getAttribute("data-code")
    || holder?.getAttribute("data-val")
    || holder?.getAttribute("data-value")
    || holder?.getAttribute("value")
    || holder?.getAttribute("data-code")
    || "";
  if (direct) return direct;
  const ka = element.getAttribute("ka") || holder?.getAttribute("ka") || "";
  return ka.match(/-(\d+)$/)?.[1] || ka;
}

function optionSourceKey(element: HTMLElement, holder: Element | null = null): string {
  return element.getAttribute("ka")
    || holder?.getAttribute("ka")
    || element.getAttribute("data-val")
    || element.getAttribute("data-value")
    || element.getAttribute("data-code")
    || holder?.getAttribute("data-val")
    || holder?.getAttribute("data-value")
    || holder?.getAttribute("data-code")
    || "";
}

// 抓所有"可见叶子元素"的签名（不依赖固定选项选择器）。
// 监听开始时建基线；用户 hover 打开下拉后，新出现的叶子 = 选项，不管它们什么 class/role。
function grabVisibleLeaves(): Array<CollectedOption & { sig: string }> {
  return [...document.querySelectorAll<HTMLElement>("a, button, li, span, div, p, label, [role='option'], [role='menuitem'], [role='menuitemcheckbox'], [data-val], [data-value]")]
    .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; })
    .filter(el => el.childElementCount === 0 || el.tagName === "LI" || el.tagName === "OPTION" || el.tagName === "A" || el.tagName === "BUTTON" || el.hasAttribute("data-val") || el.hasAttribute("data-value"))
    .map(el => {
      const text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
      // 码在选项自身、容器属性或 BOSS 的 ka="...-数字" 属性上
      const holder = el.closest("li, [role='option'], [data-val], [data-value], [data-code], [ka]") || el;
      const code = optionCode(el, holder);
      const sourceKey = optionSourceKey(el, holder);
      return {
        sig: `${text}|${sourceKey}|${code}|${el.tagName}|${(el.className?.toString?.() || "").slice(0, 24)}`,
        text,
        code: String(code || ""),
        sourceKey,
        tag: el.tagName.toLowerCase(),
        cls: (el.className?.toString?.() || "").slice(0, 120),
        outer: compactOuterHtml(el),
        parentOuter: compactOuterHtml(el.parentElement, 1200)
      };
    })
    .filter(x => x.text);
}

async function runtimeMessage<T = any>(message: unknown): Promise<T | null> {
  if (contextDead) return null;
  try {
    return await chrome.runtime.sendMessage(message) as T;
  } catch (error) {
    if (/Extension context invalidated|context invalidated|Receiving end does not exist/i.test(error instanceof Error ? error.message : String(error))) {
      contextDead = true;
      return null;
    }
    throw error;
  }
}

const textOf = (node: Element | null | undefined): string => ((node instanceof HTMLElement ? node.innerText : node?.textContent) || "").trim();
const normalize = (value: unknown): string => String(value || "").toLowerCase().replace(/\s+/g, "");
const linesOf = (value: unknown): string[] => String(value || "").split(/\r?\n|[,，/|]/).map(line => line.trim()).filter(Boolean);
const isVisible = <T extends Element>(node: T | null): node is T => {
  const rect = node?.getBoundingClientRect();
  return Boolean(node && rect && rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== "hidden");
};

function isJobDetailUrl(value: string): boolean {
  try {
    const parsed = new URL(value, globalThis.location.href);
    return /(^|\/)job_detail\//i.test(parsed.pathname) || /(^|\/)job\//i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function jobIdFromUrl(value: string): string {
  try {
    const parsed = new URL(value, globalThis.location.href);
    return parsed.pathname.split("/").filter(Boolean).pop()?.replace(/\.html$/i, "") || "";
  } catch {
    return "";
  }
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function findVisibleClickable(labels: string[]): HTMLElement | null {
  const candidates = [...document.querySelectorAll<HTMLElement>("a, button, [role='button'], [class*='nav'], [class*='tab'], [class*='menu']")]
    .filter(isVisible)
    .map(element => ({ element, text: textOf(element) }))
    .filter(({ text }) => text && text.length <= 30);
  return candidates.find(({ text }) => labels.includes(text))?.element
    || candidates.find(({ text }) => labels.some(label => text.includes(label)))?.element
    || null;
}

function visibleInput(labels: string[]): HTMLInputElement | null {
  return [...document.querySelectorAll<HTMLInputElement>("input")].find(input => {
    if (!isVisible(input)) return false;
    const hint = `${input.placeholder || ""} ${input.getAttribute("aria-label") || ""}`;
    return labels.some(label => hint.includes(label)) || input.type === "search";
  }) || null;
}

function isProfilePage(): boolean {
  const path = location.pathname.toLowerCase();
  const body = textOf(document.body);
  const markers = ["个人信息", "我的简历", "工作经历", "项目经历", "求职意向", "期望职位"].filter(marker => body.includes(marker));
  return /resume|profile|personal|geek\/user|geek\/resume|account|user/.test(path) || markers.length >= 2;
}

function isJobListPage(): boolean {
  // BOSS 的简历页通常也包含 /geek，不能把 geek 本身当成职位页。
  if (isProfilePage()) return false;
  const hasJobCards = Boolean(document.querySelector(".job-card-wrap, .job-card-box, .job-card-wrapper, .job-primary, [ka='job-card'], [data-jobid], [class*='job-card']"));
  const pathLooksLikeJobs = /\/jobs?(?:\.html|\/|$)|\/search(?:\/|$)|\/recommend(?:\/|$)/i.test(location.pathname);
  return hasJobCards || pathLooksLikeJobs;
}

function hasJobCards(): boolean {
  return Boolean(document.querySelector("a[href*='/job_detail/'], a[href*='/job/'], .job-card-wrapper, .job-primary, [ka='job-card'], [data-jobid], [class*='job-card']"));
}

async function getSettings(): Promise<Settings> {
  return await runtimeMessage<Settings>({ type: "GET_SETTINGS" }) || {
    jobKeywords: "", excludeCompanies: "", targetLocations: "", targetSalary: "", workMode: "", jobTypes: "", workExperience: "", education: "", companyIndustries: "", companySizes: "", maxPages: "5", minMatchScore: "0", candidateProfileClean: "",
    jobIntent: { targetTitles: [], skills: [], locations: [], salary: "", workModes: [], summary: "" }, profileSyncedAt: "", aiEnabled: false, agentAutoStart: false,
    aiBaseUrl: "", aiModel: "", aiApiKey: "",
    costThresholdYuan: "5", inputPriceYuanPerMillion: "0", outputPriceYuanPerMillion: "0", greetCap: "10", greetMessage: ""
  };
}

function cardFor(node: Element): Element {
  return node.closest(".job-card-wrap, .job-card-box, .job-card-wrapper, .job-primary, [ka='job-card'], [class*='job-card']") || node;
}

function firstText(root: Element, selectors: string[]): string {
  for (const selector of selectors) {
    const value = textOf(root.querySelector(selector));
    if (value) return value;
  }
  return "";
}

async function findProfileEntry(): Promise<HTMLElement | null> {
  // profile 路径已下线，保留入口查找仅供诊断/未来复用，当前 Agent 不再调用。
  const stable = [...document.querySelectorAll<HTMLAnchorElement>("a[href*='/web/geek/resume'], a[href*='/web/geek/profile']")].find(isVisible);
  const direct = stable
    || findVisibleClickable(["我的简历", "个人中心", "个人信息", "简历", "账号设置", "我的主页", "求职意向"])
    || [...document.querySelectorAll<HTMLElement>("a[href*='resume'], a[href*='profile'], a[href*='personal'], a[href*='user']")].find(isVisible)
    || null;
  return direct;
}

async function extractVisibleJobs(): Promise<Job[]> {
  const settings = await getSettings();
  const selectors = ["a[href*='/job_detail/']", "a[href*='/job/']", ".job-card-wrap", ".job-card-box", ".job-card-wrapper", ".job-primary", "[ka='job-card']", "[data-jobid]", "[class*='job-card']"];
  const seen = new Set<Element>();
  const keywords = linesOf(settings.jobKeywords || settings.jobIntent.targetTitles.join("\n")).map(normalize);
  const locations = linesOf(settings.targetLocations || settings.jobIntent.locations.join("\n")).map(normalize);
  const excluded = linesOf(settings.excludeCompanies).map(normalize);
  const jobs: Job[] = [];
  for (const node of [...document.querySelectorAll(selectors.join(","))]) {
    const card = cardFor(node);
    if (seen.has(card)) continue;
    seen.add(card);
    const link = card.matches("a[href]") && isJobDetailUrl((card as HTMLAnchorElement).href)
      ? card as HTMLAnchorElement
      : card.querySelector<HTMLAnchorElement>("a[href*='/job_detail/'], a[href^='/job/'], a[href*='zhipin.com/job/']");
    if (!link?.href) continue;
    // 公司主页 /gongsi/...、公司职位页等不是岗位详情，不能进入候选池。
    if (!isJobDetailUrl(link.href)) continue;
    const title = firstText(card, [".job-name", ".job-title", "h3", "h2"]) || textOf(link).split("\n")[0];
    const company = firstText(card, [".company-name", ".company", "[class*='company']"]) || "未识别公司";
    const salary = firstText(card, [".salary", ".job-salary", "[class*='salary']"]);
    const location = firstText(card, [".job-area", ".job-location", "[class*='location']"]);
    const description = textOf(card);
    const searchable = normalize(`${title} ${company} ${salary} ${location} ${description}`);
    const matchedKeywords = keywords.filter(keyword => searchable.includes(keyword));
    const locationOk = !locations.length || locations.some(item => normalize(location).includes(item));
    const excludedCompany = excluded.some(item => normalize(company).includes(item));
    const keywordScore = keywords.length ? matchedKeywords.length / keywords.length * 70 : 45;
    const titleScore = matchedKeywords.some(item => normalize(title).includes(item)) ? 15 : 0;
    const locationScore = locationOk ? 15 : 0;
    const score = Math.min(100, Math.round(keywordScore + titleScore + locationScore));
    const url = link.href.split("#")[0];
    const job: Job = { title, company, salary, location, description: description.slice(0, 2200), url, jobId: jobIdFromUrl(url), score, matchedKeywords, listUrl: globalThis.location.href.split("#")[0] };
    if (title) jobs.push(job);
  }
  return jobs.filter((job, index, list) => list.findIndex(item => item.url === job.url) === index).sort((a, b) => b.score - a.score);
}

function pageSignature(): string {
  const firstLink = document.querySelector<HTMLAnchorElement>("a[href*='/job_detail/'], a[href*='/job/']");
  return `${location.href}|${firstLink?.href || ""}|${textOf(firstLink).slice(0, 80)}`;
}

function findNextPage(): HTMLElement | null {
  const isDisabled = (element: HTMLElement): boolean => element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true" || /disabled|disable|forbid/i.test(element.className);
  return [...document.querySelectorAll<HTMLElement>("a, button, [role='button'], [class*='next'], [class*='pager']")]
    .filter(isVisible)
    .filter(element => !isDisabled(element))
    .find(element => {
      const text = textOf(element).toLowerCase();
      const label = `${text} ${element.getAttribute("aria-label") || ""} ${element.className}`.toLowerCase();
      return text.includes("下一页") || text === ">" || label.includes("next");
    }) || null;
}

async function filterJobs(jobs: Job[]): Promise<Job[]> {
  const settings = await getSettings();
  const excluded = linesOf(settings.excludeCompanies).map(normalize);
  // BOSS URL/页面已经完成关键词、城市、薪资、求职类型、经验和学历筛选。
  // 岗位卡片的 location/经验/学历等字段经常不完整，不能再用文本启发式二次过滤，
  // 否则明明有岗位也会被错误过滤成 0 个。BOSS 不支持的“排除公司”仍由本地处理。
  return jobs.filter(job => {
    const excludedCompany = excluded.some(item => normalize(job.company).includes(item));
    return !excludedCompany;
  }).sort((a, b) => b.score - a.score);
}

async function rankJobs(jobs: Job[]): Promise<Job[]> {
  const ranking = await runtimeMessage<{ ok: boolean; ranking?: Array<{ url: string; score: number; reason: string }>; reason?: string; error?: string }>({ type: "RANK_JOBS", jobs });
  if (!ranking?.ok || !ranking.ranking?.length) return jobs.map(job => ({ ...job, reason: ranking?.reason || "规则匹配" }));
  const map = new Map(ranking.ranking.map(item => [item.url, item]));
  return jobs.map(job => ({ ...job, score: map.get(job.url)?.score ?? job.score, reason: map.get(job.url)?.reason || "规则匹配" }))
    .sort((a, b) => b.score - a.score);
}

async function applyUrlFilters(): Promise<AgentActionResult> {
  const settings = await getSettings();
  const stored = await chrome.storage.local.get({ filterOptions: {} }) as { filterOptions?: import("./agent/boss-url").CollectedUrlOptions };
  const built = buildBossJobsUrl(location.href, settings, stored.filterOptions || {});
  const details = [
    built.applied.length ? `已写入 ${built.applied.join("、")}` : "没有可参数化的岗位条件",
    built.missing.length ? `未映射 ${built.missing.join("；")}` : "",
    built.unsupported.length ? built.unsupported.join("；") : ""
  ].filter(Boolean).join("；");
  if (built.url === location.href) return { ok: true, message: `URL 筛选条件已存在：${details}` };
  const response = await runtimeMessage<{ ok?: boolean; error?: string }>({ type: "NAVIGATE_SOURCE_TAB", url: built.url });
  if (!response?.ok) return { ok: false, message: response?.error || "无法跳转到 URL 筛选结果" };
  return { ok: true, message: `正在通过 URL 应用筛选：${details}`, pageMayChange: true, partial: Boolean(built.missing.length || built.unsupported.length) };
}

async function openJobFromList(job: Job): Promise<AgentActionResult> {
  const target = (() => { try { return new URL(job.url, globalThis.location.href); } catch { return null; } })();
  const targetPath = target?.pathname.replace(/\/+$/, "") || "";
  const targetId = targetPath.split("/").filter(Boolean).pop() || "";
  const targetJobId = (job.jobId || targetId).replace(/\.html$/i, "");
  const titleKey = normalize(job.title);
  const companyKey = normalize(job.company === "未识别公司" ? "" : job.company);
  const salaryKey = normalize(job.salary);
  const locationKey = normalize(job.location);
  const selector = "a[href*='/job_detail/'], a[href^='/job/'], a[href*='zhipin.com/job/']";
  const sameUrl = (href: string): boolean => {
    try {
      const candidate = new URL(href, globalThis.location.href);
      if (!/(^|\.)zhipin\.com$/i.test(candidate.hostname) || !target) return false;
      return candidate.pathname.replace(/\/+$/, "") === targetPath;
    } catch {
      return false;
    }
  };
  const jobCardSelector = ".job-card-wrap, .job-card-box, .job-card-wrapper, .job-primary, [ka='job-card'], [data-jobid], [class*='job-card']";
  const findImmediateGreetButton = (): HTMLElement | null => {
    const candidates = [...document.querySelectorAll<HTMLElement>("button, a, [role='button'], [class*='btn']")]
      .filter(element => isVisible(element) && /立即沟通/.test(textOf(element)));
    const score = (element: HTMLElement): number => {
      const ka = element.getAttribute("ka") || "";
      let value = 0;
      if (targetJobId && ka.endsWith(targetJobId)) value += 100;
      if (element.matches(".op-btn-chat, [ka^='cpc_job_list_chat_']")) value += 20;
      if (element.closest(".job-detail-op, .job-detail-header, .job-detail-box, .job-detail-container, [class*='job-detail']")) value += 10;
      if (element.tagName === "BUTTON" || element.getAttribute("role") === "button") value += 3;
      return value;
    };
    return candidates.sort((a, b) => score(b) - score(a))[0] || null;
  };
  const hasImmediateGreetButton = (): boolean => Boolean(findImmediateGreetButton());
  const cardIsSelected = (card: HTMLElement | null): boolean => {
    if (!card) return false;
    const markers = [
      card,
      card.parentElement,
      card.closest("li, [role='option'], [role='listitem']")
    ].filter((element): element is HTMLElement => Boolean(element));
    return markers.some(element => element.getAttribute("aria-selected") === "true"
      || element.getAttribute("aria-current") === "true"
      || /selected|active|current/.test(String(element.className || "").toLowerCase()));
  };
  const detailSignature = (): string => [...document.querySelectorAll<HTMLElement>(
    ".job-detail, .job-detail-box, .job-detail-container, [class*='job-detail'], [class*='job-detail-content'], [class*='job-detail-main']"
  )].filter(isVisible).map(textOf).join("|").slice(0, 2000);
  const detailShowsTitle = (card: HTMLElement | null): boolean => {
    if (!card || titleKey.length < 4) return false;
    const button = findImmediateGreetButton();
    let node: HTMLElement | null = button;
    for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
      const detailText = normalize(textOf(node));
      if (detailText.includes(titleKey) && (!salaryKey || detailText.includes(salaryKey))) return true;
    }
    return false;
  };
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const cards = [...document.querySelectorAll<HTMLElement>(jobCardSelector)].filter(isVisible);
    const scoredCards = cards.map(card => {
      const text = normalize(textOf(card));
      let score = 0;
      if (titleKey.length >= 4 && text.includes(titleKey)) score += 8;
      if (companyKey.length >= 2 && text.includes(companyKey)) score += 5;
      if (salaryKey.length >= 2 && text.includes(salaryKey)) score += 3;
      if (locationKey.length >= 2 && text.includes(locationKey)) score += 1;
      return { card, score };
    }).sort((a, b) => b.score - a.score);
    const matchedCard = scoredCards.find(item => item.score >= (titleKey.length >= 4 ? 8 : 3))?.card || null;
    const link = matchedCard?.querySelector<HTMLAnchorElement>(selector)
      || matchedCard?.querySelector<HTMLAnchorElement>("a[href]")
      || [...document.querySelectorAll<HTMLAnchorElement>(selector)].find(element => {
        if (!sameUrl(element.href)) return false;
        const card = element.closest(jobCardSelector);
        return isVisible(element) || isVisible(card);
      }) || null;
    if (link) {
      const rawCard = matchedCard || link.closest<HTMLElement>(jobCardSelector);
      const wasSelected = cardIsSelected(rawCard);
      const beforeDetail = detailSignature();
      // BOSS 的列表页是“左侧卡片 + 右侧详情”的单页结构。
      // 不能点击详情 <a>，否则会触发详情导航；应点击卡片表面，让 BOSS 切换右侧详情。
      const surface = rawCard && rawCard.tagName !== "A"
        ? rawCard
        : rawCard?.parentElement || link;
      surface.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
      const eventInit: MouseEventInit = { bubbles: true, cancelable: true, view: window };
      surface.dispatchEvent(new MouseEvent("mousedown", eventInit));
      surface.dispatchEvent(new MouseEvent("mouseup", eventInit));
      surface.dispatchEvent(new MouseEvent("click", eventInit));
      await wait(350);
      // 某些 BOSS 版本把选择逻辑绑定在详情链接的 click handler 上，但默认行为会导航。
      // 允许站点 handler 执行，同时阻止默认详情导航，仍留在列表页切换右侧详情。
      if (!wasSelected) {
        const preventDetailNavigation = (event: Event): void => {
          const targetElement = event.target instanceof Element ? event.target.closest("a") : null;
          if (targetElement && sameUrl((targetElement as HTMLAnchorElement).href)) event.preventDefault();
        };
        document.addEventListener("click", preventDetailNavigation, true);
        try {
          clickWithoutScriptNavigation(link);
        } finally {
          document.removeEventListener("click", preventDetailNavigation, true);
        }
        await wait(450);
      }
      const selected = wasSelected || cardIsSelected(rawCard) || detailSignature() !== beforeDetail;
      const targetDetailReady = detailShowsTitle(rawCard);
      if (hasImmediateGreetButton() && (selected || targetDetailReady)) {
        return { ok: true, message: `已在当前列表页按岗位信息选择并确认右侧详情（${job.title}）`, pageMayChange: false };
      }
      return { ok: false, message: `已找到岗位卡片，但未确认右侧详情与“${job.title}”对应` };
    }
    await wait(250);
  }
  const visibleCards = [...document.querySelectorAll<HTMLElement>(jobCardSelector)].filter(isVisible).length;
  return { ok: false, message: `列表已加载但没有匹配到目标岗位卡片（目标 ${targetId || targetPath}，当前可见卡片 ${visibleCards} 个）` };
}

async function confirmAndDismissGreet(): Promise<AgentActionResult> {
  const successPattern = /已向\s*BOSS\s*发送消息|已发送消息|发送成功|消息已发出/;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const successNode = [...document.querySelectorAll<HTMLElement>("div, section, p, span, strong, h1, h2, h3")]
      .find(element => isVisible(element) && textOf(element).length <= 500 && successPattern.test(textOf(element)));
    if (successNode) {
      const dialog = successNode.closest<HTMLElement>("[role='dialog'], [class*='dialog'], [class*='modal'], [class*='layer'], [class*='popup']")
        || successNode.parentElement?.parentElement
        || successNode.parentElement;
      const button = (dialog ? [...dialog.querySelectorAll<HTMLElement>("button, [role='button'], a, [class*='btn']")] : [])
        .find(element => isVisible(element) && /留在此页|关闭|close|×/i.test(textOf(element) || element.getAttribute("aria-label") || ""));
      if (button) {
        clickWithoutScriptNavigation(button);
        await wait(350);
        return { ok: true, message: "已确认 BOSS 发送招呼成功并关闭弹窗" };
      }
      return { ok: false, message: "已检测到发送成功提示，但未找到弹窗关闭按钮" };
    }
    await wait(250);
  }
  return { ok: false, message: "未检测到 BOSS 的发送成功确认弹窗" };
}

const tools: AgentTools = {
  getSettings,
  snapshot: snapshotPage,
  resolveRef,
  planAction: async payload => {
    const response = await runtimeMessage<{ ok: boolean; decision?: AgentDecision; usage?: { tokensIn: number; tokensOut: number; cumulativeYuan: number; estimated: boolean }; reason?: string }>({
      type: "PLAN_AGENT_ACTION",
      payload
    });
    if (!response?.ok || !response.decision) throw new Error(response?.reason || "LLM 没有返回有效 Agent 动作");
    return { decision: response.decision, usage: response.usage ?? { tokensIn: 0, tokensOut: 0, cumulativeYuan: 0, estimated: false } };
  },
  validateDecision,
  executeBrowserAction,
  runRuntimeAction: async (action: RuntimeAction): Promise<AgentActionResult> => {
    // Phase B 的 Runtime 编排（open_approved_job/finish）由 AgentRunner 内部基于 state 直接驱动，
    // 不经此 tool（tool 无 runner state 访问权）。保留接口签名以兼容 AgentTools 契约。
    return { ok: false, message: `${action} 由 runner 内部处理，不应经此 tool` };
  },
  isJobListPage,
  hasJobCards,
  findJobsEntry: async () => {
    const stable = [...document.querySelectorAll<HTMLAnchorElement>("a[href*='/web/geek/jobs'], a[href*='/web/geek/job-recommend']")].find(isVisible);
    const direct = stable || findVisibleClickable(["找工作", "职位", "招聘", "找职位"]);
    return direct || [...document.querySelectorAll<HTMLAnchorElement>("a[href*='/job'], a[href*='/search']")].find(isVisible) || null;
  },
  navigate: async element => {
    const anchor = element as HTMLAnchorElement;
    const href = anchor.href;
    const destination = href ? new URL(href, location.href) : null;
    const isBossDestination = Boolean(destination && /(^|\.)zhipin\.com$/i.test(destination.hostname));
    if (href && href !== location.href && isBossDestination) {
      void runtimeMessage({ type: "NAVIGATE_SOURCE_TAB", url: href });
      return;
    }
    clickWithoutScriptNavigation(element);
  },
  navigateToUrl: async (url: string) => {
    // Phase B Runtime 打开已批准岗位：交给 background 在源标签页导航（同源 zhipin）。
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error("无效的岗位 URL"); }
    if (!/(^|\.)zhipin\.com$/i.test(parsed.hostname)) throw new Error("非 zhipin 域，已拒绝导航");
    await runtimeMessage({ type: "NAVIGATE_SOURCE_TAB", url: parsed.href });
  },
  applyUrlFilters,
  openJobFromList,
  confirmAndDismissGreet,
  extractJobs: extractVisibleJobs,
  filterJobs,
  rankJobs,
  saveJobs: async jobs => { await runtimeMessage({ type: "SAVE_SCAN_RESULTS", jobs }); },
  setStatus: async status => { await runtimeMessage({ type: "SET_BOOTSTRAP_STATUS", status }); },
  requestApproval: async request => {
    const response = await runtimeMessage<{ ok: boolean; approval?: import("./types").ApprovalRequest }>({ type: "REQUEST_APPROVAL", request });
    if (!response?.ok || !response.approval) throw new Error("无法创建人工确认请求");
    return response.approval;
  },
  setAgentRecovery: async mirror => { await runtimeMessage({ type: "SET_AGENT_RECOVERY", mirror }); },
  getAgentRecovery: async () => {
    const response = await runtimeMessage<{ ok: boolean; mirror?: import("./types").AgentRecoveryMirror | null }>({ type: "GET_AGENT_RECOVERY" });
    return response?.mirror ?? null;
  }
};

const runner = new AgentRunner(sessionStorage, tools, null);

chrome.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
  if (message.type === "GET_AGENT_CONTEXT") {
    Promise.all([getSettings(), Promise.resolve(snapshotPage())]).then(([settings, snapshot]) => {
      sendResponse({ snapshot, currentQuery: snapshot.currentQuery, intent: buildAgentIntent(settings, snapshot.currentQuery) });
    }).catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message.type === "GET_DIAG_DOM") {
    // 真实 BOSS DOM 校准探测：不开 DevTools 也能采集关键结构片段。
    try {
      const probe = (sel: string): { found: boolean; sel: string; tag?: string; cls?: string; childCount?: number; outer?: string } => {
        const el = document.querySelector(sel);
        if (!el) return { found: false, sel };
        return { found: true, sel, tag: el.tagName, cls: (el.className?.toString?.() || "").slice(0, 80), childCount: el.children.length, outer: el.outerHTML.slice(0, 400) };
      };
      const jobContainer = [".job-list-box", ".search-job-result", ".job-list", ".job-card-list", ".job-list-ul", "[class*='job-list']", "[class*='SearchResult']", "[class*='job-result']"].map(probe);
      const jobCard = [".job-card-wrapper", ".job-card-li", ".job-card", "[class*='job-card']", "li[ka]", "a[href*='/job_detail/']", ".search-job-result-list li"].map(probe);
      const chipProbe = [".job-filter .filter-item", ".filter-list .filter-item", "[class*='filter-item']", ".filter-item a", ".condition-filter-item"].map(probe);
      const nav = (() => {
        const a = [...document.querySelectorAll<HTMLElement>("a, [role='link']")].find(x => /首页/.test((x.innerText || x.textContent || "")));
        if (!a) return null;
        const chain: string[] = [];
        let p: Element | null = a;
        for (let i = 0; i < 7 && p; i += 1) { chain.push(`${p.tagName}.${(p.className?.toString?.() || "").slice(0, 50)}`); p = p.parentElement; }
        return { tag: a.tagName, cls: (a.className?.toString?.() || "").slice(0, 60), outer: a.outerHTML.slice(0, 200), ancestors: chain };
      })();
      // 抓取当前打开的下拉面板里的选项（用户先手动点开某个筛选，再跑探测）。
      // 候选：带 role=option、class 含 option/select/dropdown-menu、或带 aria-selected 的元素。
      const optionCandidates = [...document.querySelectorAll<HTMLElement>("[role='option'], [role='menuitemcheckbox'], [class*='filter-option'], [class*='dropdown-item'], [class*='select-item'], li[aria-selected], .multiple-chosen li, [class*='multiple'] li")]
        .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
        .map(el => ({ tag: el.tagName, cls: (el.className?.toString?.() || "").slice(0, 60), text: (el.innerText || el.textContent || "").trim().slice(0, 30), selected: el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-checked") === "true" || el.classList.contains("selected") || el.classList.contains("active") }))
        .filter(o => o.text);
      // 选项面板容器样本（取第一个 option 的祖先容器）
      const panelSample = (() => {
        const first = document.querySelector<HTMLElement>("[role='option'], [class*='filter-option'], [class*='dropdown-item'], li[aria-selected]");
        let p: Element | null = first;
        for (let i = 0; i < 4 && p; i += 1) p = p.parentElement;
        return p ? { tag: p.tagName, cls: (p.className?.toString?.() || "").slice(0, 80), outer: p.outerHTML.slice(0, 400) } : null;
      })();
      sendResponse({ url: location.href, jobContainer, jobCard, chipProbe, nav, optionCandidates: optionCandidates.slice(0, 60), panelSample });

    } catch (error) {
      sendResponse({ error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (message.type === "COLLECT_OPTIONS_LISTEN") {
    // 监听模式：用户在 BOSS 页面手动 hover 打开各筛选下拉，
    // content script 每 400ms 抓取当前可见的选项，按"选项文本集合"去重记为一批。
    if (message.action === "start") {
      if (listenTimer) clearInterval(listenTimer);
      // 建基线：当前所有可见叶子元素签名。用户随后 hover 打开下拉，新出现的叶子即选项。
      listenBaseSet = new Set(grabVisibleLeaves().map(x => x.sig));
      listenBatches = [];
      listenTimer = setInterval(() => {
        const fresh = grabVisibleLeaves().filter(x => !listenBaseSet.has(x.sig));
        if (fresh.length < 2) return;
        const last = listenBatches[listenBatches.length - 1];
        if (!last || last.map(x => `${x.text}|${x.code}`).slice().sort().join("|") !== fresh.map(x => `${x.text}|${x.code}`).slice().sort().join("|")) {
          const seen = new Set<string>();
          // 行业下拉会同时出现分组标题（无编码）和真实叶子选项（有 ka 编码）。
          // 只要本批存在编码项，就排除无编码的分组标题；城市批次全是文本时保留文本。
          const candidates = fresh.some(item => item.code || item.sourceKey) ? fresh.filter(item => item.code || item.sourceKey) : fresh;
          const items = candidates.filter(it => { const itemKey = `${it.text}|${it.sourceKey}|${it.code}`; if (seen.has(itemKey)) return false; seen.add(itemKey); return true; });
          listenBatches.push(items);
          // 当前批次已记录，下一批只比较新出现的选项，避免把上一批重复带入。
          listenBaseSet = new Set(grabVisibleLeaves().map(x => x.sig));
        }
      }, 400);
      sendResponse({ ok: true });
    } else {
      if (listenTimer) { clearInterval(listenTimer); listenTimer = null; }
      const seen = new Set<string>();
      const dedup: Array<CollectedOption[]> = [];
      for (const b of listenBatches) { const k = b.map(x => `${x.text}|${x.code}`).slice().sort().join("|"); if (!seen.has(k)) { seen.add(k); dedup.push(b); } }
      sendResponse({ ok: true, batches: dedup });
    }
    return true;
  }


  if (message.type === "COLLECT_DIM_CODES") {
    // 逐维度采集：用户点维度后 hover 对应下拉，读出所有选项的 {文本, 码}。
    // 码可能在选项元素自身或最近 li/option 容器的 data-val/data-value/value。
    const dim = String(message.dim || "");
    const grabOpts = () => [...document.querySelectorAll<HTMLElement>("a, button, li, span, div, p, label, [role='option'], [data-val], [data-value]")]
      .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .filter(el => el.childElementCount === 0 || el.tagName === "LI" || el.tagName === "OPTION" || el.tagName === "A" || el.tagName === "BUTTON" || el.hasAttribute("data-val") || el.hasAttribute("data-value"))
      .map(el => {
        const holder = el.closest("li, [role='option'], [data-val], [data-value], [data-code], [ka]") || el;
        const text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
        const code = optionCode(el, holder);
        return { sig: `${text}|${code}|${el.tagName}|${(el.className?.toString?.() || "").slice(0, 24)}`, el, text, code };
      })
      .filter(x => x.text);
    const baseSet = new Set(grabOpts().map(x => x.sig));
    let done = false;
    const finish = (resp: unknown) => { if (done) return; done = true; clearInterval(timer); clearTimeout(timeout); sendResponse(resp); };
    const timer = setInterval(() => {
      const fresh = grabOpts().filter(x => !baseSet.has(x.sig));
      if (fresh.length < 2) return;
      const seen = new Set<string>();
      const items = fresh.map(x => ({
        text: x.text,
        code: String(x.code || ""),
        tag: x.el.tagName,
        cls: (x.el.className?.toString?.() || "").slice(0, 40)
      })).filter(it => { const itemKey = `${it.text}|${it.code}`; if (seen.has(itemKey)) return false; seen.add(itemKey); return true; });
      finish({ ok: true, dim, items });
    }, 400);
    const timeout = setTimeout(() => finish({ ok: false, error: "8 秒内未抓到选项，请确认 hover 打开了对应下拉" }), 9000);
    return true;
  }
  if (message.type === "PING") {
    sendResponse({ ok: true, page: location.href });
    return false;
  }
  if (message.type === "AUTOMATE_BOOTSTRAP") {
    sendResponse({ ok: true, pending: true, message: "Agent 已开始执行" });
    if (isPrimaryContentScript) void runner.start(Boolean(message.restart));
    return false;
  }
  if (message.type === "RESET_AGENT") {
    if (isPrimaryContentScript) runner.reset();
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === "SCAN_JOBS") {
    extractVisibleJobs().then(filterJobs).then(rankJobs).then(async jobs => { await runtimeMessage({ type: "SAVE_SCAN_RESULTS", jobs }); sendResponse(jobs); }).catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message.type === "RESUME_AGENT") {
    // 审批通过后由 background 触发；resume() 会从 chrome.storage.local 镜像合并恢复数据后继续循环。
    sendResponse({ ok: true });
    if (isPrimaryContentScript) void runner.resume();
    return false;
  }
  if (message.type === "RESOLVE_UNKNOWN_GREET") {
    // 人工裁决未知打招呼结果：sent→verified（入 greeted），skipped→failed。
    const url = typeof message.url === "string" ? message.url : "";
    const verdict = message.verdict === "sent" ? "sent" : "skipped";
    sendResponse({ ok: true });
    if (isPrimaryContentScript && url) {
      runner.resolveUnknownGreet(url, verdict);
      void runner.resume();
    }
    return false;
  }
  return false;
});

if (isPrimaryContentScript) void runner.resume();
