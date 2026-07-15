import { AgentRunner } from "./agent/workflow";
import { snapshotPage, resolveRef } from "./agent/snapshot";
import { executeBrowserAction } from "./agent/browser-action";
import { validateDecision } from "./agent/validate";
import { buildAgentIntent } from "./agent/intent";
import type { AgentActionResult, AgentDecision, AgentTools, Job, RuntimeAction, Settings } from "./types";

let contextDead = false;

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
  const hasJobCards = Boolean(document.querySelector(".job-card-wrapper, .job-primary, [ka='job-card'], [data-jobid]"));
  const pathLooksLikeJobs = /\/jobs?(?:\.html|\/|$)|\/search(?:\/|$)|\/recommend(?:\/|$)/i.test(location.pathname);
  return hasJobCards || pathLooksLikeJobs;
}

function hasJobCards(): boolean {
  return Boolean(document.querySelector("a[href*='/job_detail/'], a[href*='/job/'], .job-card-wrapper, .job-primary, [ka='job-card'], [data-jobid], [class*='job-card']"));
}

async function getSettings(): Promise<Settings> {
  return await runtimeMessage<Settings>({ type: "GET_SETTINGS" }) || {
    jobKeywords: "", excludeCompanies: "", targetLocations: "", targetSalary: "", workMode: "", jobTypes: "", workExperience: "", education: "", companyIndustries: "", companySizes: "", maxPages: "5", minMatchScore: "50", candidateProfileClean: "",
    jobIntent: { targetTitles: [], skills: [], locations: [], salary: "", workModes: [], summary: "" }, profileSyncedAt: "", aiEnabled: false, agentAutoStart: false,
    aiBaseUrl: "", aiModel: "", aiApiKey: "",
    costThresholdYuan: "5", inputPriceYuanPerMillion: "0", outputPriceYuanPerMillion: "0", greetCap: "10", greetMessage: ""
  };
}

function cardFor(node: Element): Element {
  return node.closest(".job-card-wrapper, .job-primary, [ka='job-card'], li") || node;
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
  const selectors = ["a[href*='/job_detail/']", "a[href*='/job/']", ".job-card-wrapper", ".job-primary", "[ka='job-card']", "[data-jobid]"];
  const seen = new Set<Element>();
  const keywords = linesOf(settings.jobKeywords || settings.jobIntent.targetTitles.join("\n")).map(normalize);
  const locations = linesOf(settings.targetLocations || settings.jobIntent.locations.join("\n")).map(normalize);
  const excluded = linesOf(settings.excludeCompanies).map(normalize);
  const jobs: Job[] = [];
  for (const node of [...document.querySelectorAll(selectors.join(","))]) {
    const card = cardFor(node);
    if (seen.has(card)) continue;
    seen.add(card);
    const link = card.matches("a[href]") ? card as HTMLAnchorElement : card.querySelector<HTMLAnchorElement>("a[href*='/job_detail/'], a[href*='/job/'], a[href]");
    if (!link?.href) continue;
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
    const job: Job = { title, company, salary, location, description: description.slice(0, 2200), url: link.href.split("#")[0], score, matchedKeywords };
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
  const locations = linesOf(settings.targetLocations || settings.jobIntent.locations.join("\n")).map(normalize);
  const excluded = linesOf(settings.excludeCompanies).map(normalize);
  const minimum = Number(settings.minMatchScore || 0);
  const experience = linesOf(settings.workExperience).map(normalize);
  const education = linesOf(settings.education).map(normalize);
  const industries = linesOf(settings.companyIndustries).map(normalize);
  const companySizes = linesOf(settings.companySizes).map(normalize);
  const workModes = linesOf(settings.workMode || settings.jobIntent.workModes.join("\n")).map(normalize);
  const conditionMatches = (values: string[], text: string, signal: RegExp): boolean => {
    if (!values.length) return true;
    if (values.some(value => text.includes(value))) return true;
    return !signal.test(text);
  };
  return jobs.filter(job => {
    const text = normalize(`${job.title} ${job.company} ${job.salary} ${job.location} ${job.description}`);
    const locationOk = !locations.length || locations.some(item => normalize(job.location).includes(item));
    const excludedCompany = excluded.some(item => normalize(job.company).includes(item));
    const experienceOk = conditionMatches(experience, text, /不限经验|无经验|应届|\d+年/i);
    const educationOk = conditionMatches(education, text, /不限学历|大专|本科|硕士|博士/i);
    const industryOk = conditionMatches(industries, text, /互联网|软件|金融|教育|医疗|制造|零售/i);
    const companySizeOk = conditionMatches(companySizes, text, /少于15人|15-50人|50-150人|150-500人|500-2000人|2000人以上/i);
    const workModeOk = conditionMatches(workModes, text, /全职|兼职|远程|混合办公|现场/i);
    return locationOk && !excludedCompany && experienceOk && educationOk && industryOk && companySizeOk && workModeOk && job.score >= minimum;
  }).sort((a, b) => b.score - a.score);
}

async function rankJobs(jobs: Job[]): Promise<Job[]> {
  const settings = await getSettings();
  const ranking = await runtimeMessage<{ ok: boolean; ranking?: Array<{ url: string; score: number; reason: string }>; reason?: string; error?: string }>({ type: "RANK_JOBS", jobs });
  if (!ranking?.ok || !ranking.ranking?.length) return jobs.map(job => ({ ...job, reason: ranking?.reason || "规则匹配" }));
  const map = new Map(ranking.ranking.map(item => [item.url, item]));
  return jobs.map(job => ({ ...job, score: map.get(job.url)?.score ?? job.score, reason: map.get(job.url)?.reason || "规则匹配" }))
    .filter(job => job.score >= Number(settings.minMatchScore || 0))
    .sort((a, b) => b.score - a.score);
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
    element.click();
  },
  navigateToUrl: async (url: string) => {
    // Phase B Runtime 打开已批准岗位：交给 background 在源标签页导航（同源 zhipin）。
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error("无效的岗位 URL"); }
    if (!/(^|\.)zhipin\.com$/i.test(parsed.hostname)) throw new Error("非 zhipin 域，已拒绝导航");
    await runtimeMessage({ type: "NAVIGATE_SOURCE_TAB", url: parsed.href });
  },
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
      sendResponse({ url: location.href, jobContainer, jobCard, chipProbe, nav });
    } catch (error) {
      sendResponse({ error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (message.type === "PING") {
    sendResponse({ ok: true, page: location.href });
    return false;
  }
  if (message.type === "AUTOMATE_BOOTSTRAP") {
    sendResponse({ ok: true, pending: true, message: "Agent 已开始执行" });
    void runner.start(Boolean(message.restart));
    return false;
  }
  if (message.type === "RESET_AGENT") {
    runner.reset();
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
    void runner.resume();
    return false;
  }
  if (message.type === "RESOLVE_UNKNOWN_GREET") {
    // 人工裁决未知打招呼结果：sent→verified（入 greeted），skipped→failed。
    const url = typeof message.url === "string" ? message.url : "";
    const verdict = message.verdict === "sent" ? "sent" : "skipped";
    sendResponse({ ok: true });
    if (url) {
      runner.resolveUnknownGreet(url, verdict);
      void runner.resume();
    }
    return false;
  }
  return false;
});

void runner.resume();
