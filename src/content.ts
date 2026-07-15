import { AgentRunner } from "./agent/workflow";
import { ToolRegistry } from "./agent/tool-registry";
import { buildAgentIntent } from "./agent/intent";
import { mergeBossQueryWithUser } from "./agent/query-plan";
import type { AgentActionResult, AgentDecision, AgentTools, BossQueryContext, EffectiveQuery, Job, PageObservation, ProfileAnalysisResult, QueryApplyResult, Settings } from "./types";

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
const linesOf = (value: unknown): string[] => String(value || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
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

function findAgentClickable(target: string): HTMLElement | null {
  const wanted = normalize(target);
  if (!wanted) return null;
  const candidates = [...document.querySelectorAll<HTMLElement>("a, button, [role='button'], [role='tab'], [role='menuitem'], [role='option']")]
    .filter(isVisible)
    .map(element => ({
      element,
      text: normalize(textOf(element)),
      label: normalize(`${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""} ${element.className || ""}`)
    }))
    .filter(item => item.text || item.label);
  return candidates
    .sort((left, right) => {
      const score = (item: typeof left): number => item.text === wanted ? 4 : item.text.includes(wanted) ? 3 : item.label.includes(wanted) ? 2 : 0;
      return score(right) - score(left);
    })
    .find(item => item.text === wanted || item.text.includes(wanted) || item.label.includes(wanted))?.element || null;
}

function findAgentInput(target: string): HTMLInputElement | null {
  const wanted = normalize(target);
  const inputs = [...document.querySelectorAll<HTMLInputElement>("input, textarea")].filter(isVisible);
  return inputs
    .map(input => ({
      input,
      label: normalize(`${input.placeholder || ""} ${input.getAttribute("aria-label") || ""} ${input.getAttribute("name") || ""}`)
    }))
    .sort((left, right) => (right.label === wanted ? 3 : right.label.includes(wanted) ? 2 : 0) - (left.label === wanted ? 3 : left.label.includes(wanted) ? 2 : 0))
    .find(item => item.label === wanted || item.label.includes(wanted))?.input || visibleInput([target]);
}

async function executeBrowserAction(decision: AgentDecision): Promise<AgentActionResult> {
  const target = decision.target || "";
  switch (decision.action) {
    case "click": {
      const element = findAgentClickable(target);
      if (!element) return { ok: false, message: `没有找到可点击控件：${target}` };
      element.click();
      await wait(700);
      return { ok: true, message: `已点击：${target}`, pageMayChange: element.tagName === "A" };
    }
    case "fill": {
      const input = findAgentInput(target);
      if (!input) return { ok: false, message: `没有找到输入框：${target}` };
      if (typeof decision.value !== "string") return { ok: false, message: "填写动作缺少 value" };
      setInputValue(input, decision.value);
      await wait(350);
      return { ok: true, message: `已填写${target}：${decision.value}` };
    }
    case "select": {
      if (!target || !decision.value) return { ok: false, message: "选择动作缺少 target 或 value" };
      const selected = await chooseFilter([target], [decision.value]);
      return selected ? { ok: true, message: `已选择${target}：${decision.value}` } : { ok: false, message: `无法选择${target}：${decision.value}` };
    }
    case "scroll": {
      const amount = Math.max(100, Math.min(1200, decision.amount || 600));
      window.scrollBy({ top: decision.direction === "up" ? -amount : amount, behavior: "smooth" });
      await wait(700);
      return { ok: true, message: `已向${decision.direction === "up" ? "上" : "下"}滚动` };
    }
    case "next_page": {
      const before = pageSignature();
      const next = findNextPage();
      if (!next) return { ok: false, message: "没有找到下一页控件" };
      next.click();
      try { await toolsWaitFor(() => pageSignature() !== before && hasJobCards(), "下一页岗位", 12000); } catch { return { ok: false, message: "点击下一页后页面没有变化" }; }
      return { ok: true, message: "已进入下一页", pageMayChange: true };
    }
    case "open_jobs": {
      const link = await (tools.findJobsEntry());
      if (!link) return { ok: false, message: "没有找到职位列表入口" };
      await tools.navigate(link);
      return { ok: true, message: "正在进入职位列表页", pageMayChange: true };
    }
    case "apply_filters": {
      const result = await applyFilters();
      return { ok: result.verified || result.applied.length > 0, message: result.applied.length ? `已应用：${result.applied.join("、")}` : `未能稳定应用筛选条件：${result.skipped.join("、")}` };
    }
    default:
      return { ok: false, message: `当前动作不属于浏览器操作：${decision.action}` };
  }
}

async function verifyBrowserAction(decision: AgentDecision, before: PageObservation): Promise<AgentActionResult> {
  await wait(350);
  const after = observePage();
  if (decision.action === "fill" && decision.target && typeof decision.value === "string") {
    const input = findAgentInput(decision.target);
    if (!input || !normalize(input.value).includes(normalize(decision.value))) return { ok: false, message: `验证失败：${decision.target} 没有显示目标值` };
  }
  if (decision.action === "select" && decision.value) {
    const query = readBossQueryContext();
    const queryText = normalize(JSON.stringify(query));
    if (!queryText.includes(normalize(decision.value)) && !hasSelectedValue([decision.value])) return { ok: false, message: `验证失败：页面没有显示已选择的 ${decision.value}` };
  }
  const changed = before.url !== after.url || before.kind !== after.kind || before.hasJobCards !== after.hasJobCards || before.visibleActions.join("|") !== after.visibleActions.join("|");
  return { ok: true, message: changed ? "页面已发生变化，验证通过" : "页面已接受动作，继续观察新状态" };
}

function findVisibleMenuOption(labels: string[]): HTMLElement | null {
  const wanted = labels.map(normalize).filter(Boolean);
  const candidates = [...document.querySelectorAll<HTMLElement>("[role='option'], [role='menuitem'], li, [class*='option'], [class*='dropdown-item'], [class*='filter-item'], [class*='select-item']")]
    .filter(isVisible)
    .map(element => ({ element, text: normalize(textOf(element)) }))
    .filter(({ text }) => text && text.length <= 80);
  return candidates.find(({ text }) => wanted.some(value => text === value))?.element
    || candidates.sort((a, b) => a.text.length - b.text.length).find(({ text }) => wanted.some(value => text.includes(value)))?.element
    || null;
}

// 诊断用：采集页面筛选栏里所有“看起来像筛选触发器”的可见短文本元素，
// 用来对照 chooseFilter 里硬编码的触发器标签是否和 BOSS 真实 DOM 一致。
function collectFilterInventory(): string {
  const visibleEl = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    return Boolean(rect && rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden");
  };
  const roots = [...document.querySelectorAll<HTMLElement>(".search-condition, .job-filter, .filter-condition, .search-box, [class*='condition'], [class*='filter'], .job-box")]
    .filter(visibleEl)
    .sort((a, b) => textOf(b).length - textOf(a).length);
  const base = roots[0] || document.body;
  const nodes = [...base.querySelectorAll<HTMLElement>("a, button, [role='button'], span, div, li, p")]
    .filter(visibleEl)
    .map(element => ({ element, text: textOf(element) }))
    .filter(({ text }) => text.length > 0 && text.length <= 12);
  const seen = new Set<string>();
  const items: string[] = [];
  for (const { element, text } of nodes) {
    if (seen.has(text)) continue;
    seen.add(text);
    const cls = (element.className?.toString() || "").slice(0, 40);
    items.push(`${text}[${element.tagName}${cls ? "/" + cls : ""}]`);
    if (items.length >= 60) break;
  }
  return `ROOT:${base.tagName}.${(base.className?.toString() || "").slice(0, 40)} | ${items.join(" , ")}`;
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

function observePage(): PageObservation {
  const path = location.pathname.toLowerCase();
  const body = textOf(document.body);
  const profile = isProfilePage();
  const jobs = isJobListPage();
  const detail = /\/job_detail\//i.test(path);
  const actions = [...document.querySelectorAll<HTMLElement>("a, button, [role='button']")]
    .filter(isVisible)
    .map(element => textOf(element))
    .filter(text => text && text.length <= 24)
    .slice(0, 40);
  return {
    url: location.href,
    path: location.pathname,
    kind: /请登录|登录后|手机号登录|密码登录/.test(body) ? "login" : profile ? "profile" : detail ? "job_detail" : jobs ? "jobs" : "unknown",
    hasProfileContent: profile,
    hasJobCards: hasJobCards(),
    hasSearchInput: Boolean(visibleInput(["搜索职位", "职位、公司"])),
    visibleActions: actions,
    loginRequired: /请登录|登录后|手机号登录|密码登录/.test(body)
  };
}

function extractVisibleProfileText(): string {
  const roots = [...document.querySelectorAll<HTMLElement>("main, [class*='resume'], [class*='profile'], [class*='user-info']")]
    .filter(isVisible)
    .sort((a, b) => textOf(b).length - textOf(a).length);
  const raw = textOf(roots[0] || document.body);
  const ignored = /^(首页|职位|找工作|消息|通知|我的|设置|下载|登录|注册|反馈|帮助)$/;
  const scriptNoise = /(document\.|window\.|cookie|function\s*\(|getElementsByTagName|createElement|matchMedia|console\.|javascript:|<script|var\s+_[A-Za-z])/i;
  return [...new Set(linesOf(raw).filter(line => !ignored.test(line) && !scriptNoise.test(line) && line.length < 300))].slice(0, 260).join("\n");
}

async function importProfile(): Promise<{ ok: boolean; reason?: string; analysis?: ProfileAnalysisResult }> {
  if (!isProfilePage()) return { ok: false, reason: "当前页面还不是可识别的个人简历页面" };
  const raw = extractVisibleProfileText();
  if (raw.length < 80) return { ok: false, reason: "当前页面可见简历内容太少" };
  const result = await runtimeMessage<{ ok: boolean; profile?: string; summary?: string; intent?: ProfileAnalysisResult["intent"]; reason?: string; error?: string }>({ type: "ANALYZE_PROFILE", text: raw });
  if (!result?.ok) return { ok: false, reason: result?.reason || result?.error || "简历分析失败" };
  return {
    ok: true,
    analysis: { cleanProfile: result.profile || "", summary: result.summary || "", intent: result.intent || { targetTitles: [], skills: [], locations: [], salary: "", workModes: [], summary: "" } }
  };
}

async function findProfileEntry(): Promise<HTMLElement | null> {
  const stable = [...document.querySelectorAll<HTMLAnchorElement>("a[href*='/web/geek/resume'], a[href*='/web/geek/profile']")].find(isVisible);
  const direct = stable
    || findVisibleClickable(["我的简历", "个人中心", "个人信息", "简历", "账号设置", "我的主页", "求职意向"])
    || [...document.querySelectorAll<HTMLElement>("a[href*='resume'], a[href*='profile'], a[href*='personal'], a[href*='user']")].find(isVisible)
    || null;
  if (direct) return direct;
  const avatar = [...document.querySelectorAll<HTMLElement>("header [class*='avatar'], header [class*='user'], header [class*='account'], [class*='user-menu'], [class*='account-menu'], nav [class*='avatar'], nav [class*='user']")].find(isVisible);
  if (!avatar) return null;
  avatar.click();
  await wait(700);
  return findVisibleClickable(["我的简历", "个人中心", "个人信息", "简历", "账号设置"]);
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

async function getSettings(): Promise<Settings> {
  return await runtimeMessage<Settings>({ type: "GET_SETTINGS" }) || {
    jobKeywords: "", excludeCompanies: "", targetLocations: "", targetSalary: "", workMode: "", jobTypes: "", workExperience: "", education: "", companyIndustries: "", companySizes: "", maxPages: "5", minMatchScore: "50", candidateProfileClean: "",
    jobIntent: { targetTitles: [], skills: [], locations: [], salary: "", workModes: [], summary: "" }, profileSyncedAt: "", aiEnabled: false, agentAutoStart: false,
    aiBaseUrl: "", aiModel: "", aiApiKey: ""
  };
}

function visibleInput(labels: string[]): HTMLInputElement | null {
  return [...document.querySelectorAll<HTMLInputElement>("input")].find(input => {
    if (!isVisible(input)) return false;
    const hint = `${input.placeholder || ""} ${input.getAttribute("aria-label") || ""}`;
    return labels.some(label => hint.includes(label)) || input.type === "search";
  }) || null;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function chooseFilter(triggerLabels: string[], optionLabels: string[]): Promise<boolean> {
  const trigger = findVisibleClickable(triggerLabels);
  if (!trigger) return false;
  trigger.click();
  await wait(350);
  const option = findVisibleMenuOption(optionLabels) || findVisibleClickable(optionLabels);
  if (!option) return false;
  option.click();
  await wait(700);
  return true;
}

async function applyConfiguredFilter(triggerLabels: string[], rawValue: string, label: string, applied: string[], skipped: string[]): Promise<void> {
  const values = linesOf(rawValue);
  if (!values.length) return;
  const matched = await chooseFilter(triggerLabels, values);
  if (matched) applied.push(`${label}：${values.join("、")}`);
  else skipped.push(label);
}

function readCurrentFilterValue(triggerLabels: string[], defaults: string[]): string[] {
  const trigger = findVisibleClickable(triggerLabels);
  if (!trigger) return [];
  const value = textOf(trigger);
  if (!value || defaults.some(item => normalize(item) === normalize(value))) return [];
  return [value];
}

function readBossQueryContext(extra: Partial<BossQueryContext> = {}): BossQueryContext {
  const search = visibleInput(["搜索职位", "搜索职位、公司", "职位、公司"]);
  const keyword = search?.value.trim() || "";
  const location = readCurrentFilterValue(["北京", "上海", "广州", "深圳", "城市", "地点", ...(extra.location || [])], ["城市", "地点"]);
  const salary = readCurrentFilterValue(["薪资待遇", ...(extra.salary || [])], ["薪资待遇"]);
  const jobTypes = readCurrentFilterValue(["求职类型", ...(extra.jobTypes || [])], ["求职类型"]);
  const experience = readCurrentFilterValue(["工作经验", ...(extra.experience || [])], ["工作经验"]);
  const education = readCurrentFilterValue(["学历要求", ...(extra.education || [])], ["学历要求"]);
  const industries = readCurrentFilterValue(["公司行业", ...(extra.industries || [])], ["公司行业"]);
  const companySizes = readCurrentFilterValue(["公司规模", ...(extra.companySizes || [])], ["公司规模"]);
  const source = keyword || location.length || salary.length || jobTypes.length || experience.length || education.length ? "search" : "recommend";
  return { keyword, location, salary, jobTypes, workModes: [], experience, education, industries, companySizes, source };
}

async function applyMergedFilter(triggerLabels: string[], current: string[], desired: string[], label: string, applied: string[], preserved: string[], skipped: string[]): Promise<void> {
  if (!desired.length) return;
  if (current.length && desired.every(value => current.some(item => normalize(item).includes(normalize(value))))) {
    preserved.push(`${label}：${current.join("、")}`);
    return;
  }
  if (await chooseFilter([...triggerLabels, ...current], desired)) applied.push(`${label}：${desired.join("、")}`);
  else skipped.push(label);
}

function matchesAny(desired: string[], actual: string[]): boolean {
  return !desired.length || desired.every(value => actual.some(item => normalize(item).includes(normalize(value)) || normalize(value).includes(normalize(item))));
}

function hasSelectedValue(values: string[]): boolean {
  if (!values.length) return true;
  const selected = [...document.querySelectorAll<HTMLElement>("[aria-selected='true'], [aria-checked='true'], input:checked")]
    .filter(isVisible)
    .map(textOf)
    .map(normalize);
  return values.every(value => selected.some(item => item.includes(normalize(value))));
}

async function applyFilters(): Promise<QueryApplyResult> {
  const settings = await getSettings();
  await runtimeMessage({ type: "SET_BOOTSTRAP_STATUS", status: { ok: true, message: "正在读取 BOSS 当前查询条件…", step: "apply_filters" } });
  const current = readBossQueryContext();
  const effective: EffectiveQuery = mergeBossQueryWithUser(current, settings);
  const applied: string[] = [];
  const skipped: string[] = [];
  const preserved = effective.preserved;
  const effectiveValues = [effective.keyword, ...effective.location, ...effective.salary, ...effective.jobTypes, ...effective.experience, ...effective.education, ...effective.industries, ...effective.companySizes, ...effective.workModes].filter(Boolean);
  if (!effectiveValues.length) {
    await runtimeMessage({ type: "SET_BOOTSTRAP_STATUS", status: { ok: false, message: "没有可执行的查询条件，请先在“岗位筛选设置”中填写条件", step: "apply_filters" } });
    return { applied: [], skipped: ["未设置查询条件"], verified: false, effective };
  }
  await runtimeMessage({ type: "SET_BOOTSTRAP_STATUS", status: { ok: true, message: `已合并查询条件，准备操作 BOSS 页面：${effectiveValues.slice(0, 5).join("、")}`, step: "apply_filters" } });

  const keyword = effective.keyword;
  const search = visibleInput(["搜索职位", "搜索职位、公司", "职位、公司"]);
  if (keyword && search) {
    if (normalize(search.value) === normalize(keyword) && current.keyword) preserved.push(`关键词：${current.keyword}`);
    else {
      setInputValue(search, keyword);
      await runtimeMessage({ type: "SET_BOOTSTRAP_STATUS", status: { ok: true, message: `正在填写搜索关键词：${keyword}`, step: "apply_filters" } });
      const searchButton = findVisibleClickable(["搜索"]);
      if (searchButton) { searchButton.click(); await wait(900); applied.push(`关键词：${keyword}`); }
      else skipped.push("关键词搜索按钮");
    }
  } else if (keyword) skipped.push("关键词搜索框");

  const salaryOptions = effective.salary;
  await applyMergedFilter(["薪资待遇"], current.salary, salaryOptions, "薪资", applied, preserved, skipped);
  await applyMergedFilter(["城市", "地点"], current.location, effective.location, "城市", applied, preserved, skipped);
  await applyMergedFilter(["求职类型"], current.jobTypes, effective.jobTypes, "求职类型", applied, preserved, skipped);
  await applyMergedFilter(["工作经验"], current.experience, effective.experience, "工作经验", applied, preserved, skipped);
  await applyMergedFilter(["学历要求"], current.education, effective.education, "学历", applied, preserved, skipped);
  await applyMergedFilter(["公司行业"], current.industries, effective.industries, "行业", applied, preserved, skipped);
  await applyMergedFilter(["公司规模"], current.companySizes, effective.companySizes, "规模", applied, preserved, skipped);
  if (effective.workModes.length) skipped.push("工作方式（BOSS 无对应筛选器，使用岗位内容过滤）");
  const after = readBossQueryContext(effective);
  const matchesOrSelected = (desired: string[], actual: string[]): boolean => matchesAny(desired, actual) || hasSelectedValue(desired);
  const verification: Array<[string, boolean]> = [
    ["关键词", !effective.keyword || normalize(after.keyword).includes(normalize(effective.keyword))],
    ["城市", matchesOrSelected(effective.location, after.location)],
    ["薪资", matchesOrSelected(effective.salary, after.salary)],
    ["求职类型", matchesOrSelected(effective.jobTypes, after.jobTypes)],
    ["工作经验", matchesOrSelected(effective.experience, after.experience)],
    ["学历", matchesOrSelected(effective.education, after.education)],
    ["公司行业", matchesOrSelected(effective.industries, after.industries)],
    ["公司规模", matchesOrSelected(effective.companySizes, after.companySizes)],
    ["工作方式", true]
  ];
  const failedVerification = verification.filter(([label, ok]) => !ok && label !== "工作方式").map(([label]) => `${label}未验证`);
  if (failedVerification.length) {
    // 临时诊断：把页面真实的筛选栏元素清点进错误信息，便于对照修复 chooseFilter。
    skipped.push(`[诊断] 页面筛选元素：${collectFilterInventory()}`);
  }
  return {
    applied: [...applied, ...preserved.map(item => `保留${item}`)],
    skipped: [...skipped, ...failedVerification],
    verified: failedVerification.length === 0,
    effective
  };
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

function isDisabled(element: HTMLElement): boolean {
  return element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true" || /disabled|disable|forbid/i.test(element.className);
}

function findNextPage(): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>("a, button, [role='button'], [class*='next'], [class*='pager']")]
    .filter(isVisible)
    .filter(element => !isDisabled(element))
    .find(element => {
      const text = textOf(element).toLowerCase();
      const label = `${text} ${element.getAttribute("aria-label") || ""} ${element.className}`.toLowerCase();
      return text.includes("下一页") || text === ">" || label.includes("next");
    }) || null;
}

async function extractJobs(): Promise<Job[]> {
  const settings = await getSettings();
  const maxPages = Math.max(1, Math.min(20, Number.parseInt(settings.maxPages || "5", 10) || 5));
  const all = new Map<string, Job>();
  const visitedPages = new Set<string>();
  for (let page = 1; page <= maxPages; page += 1) {
    const currentSignature = pageSignature();
    if (visitedPages.has(currentSignature)) break;
    visitedPages.add(currentSignature);
    const pageJobs = await extractVisibleJobs();
    pageJobs.forEach(job => all.set(job.url, job));
    await runtimeMessage({ type: "SET_BOOTSTRAP_STATUS", status: { ok: true, message: `已读取第 ${page} 页，累计 ${all.size} 个岗位`, step: "extract_jobs" } });

    const next = findNextPage();
    if (!next || page >= maxPages) break;
    next.click();
    try {
      await toolsWaitFor(() => pageSignature() !== currentSignature && hasJobCards(), "下一页岗位", 12000);
    } catch {
      break;
    }
  }
  return [...all.values()].sort((a, b) => b.score - a.score);
}

async function toolsWaitFor(check: () => boolean, description: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await wait(300);
  }
  throw new Error(`等待${description}超时`);
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

const registry = new ToolRegistry();
registry.register({ name: "find_profile_entry", description: "查找 BOSS 简历入口", risk: "read" }, findProfileEntry);
registry.register({ name: "import_profile", description: "读取当前页面简历并分析求职意向", risk: "read" }, importProfile);
registry.register({ name: "find_jobs_entry", description: "查找 BOSS 职位列表入口", risk: "read" }, () => findVisibleClickable(["找工作", "职位", "招聘", "找职位"]));
registry.register({ name: "apply_filters", description: "观察并操作 BOSS 职位筛选控件", risk: "read" }, applyFilters);
registry.register({ name: "extract_jobs", description: "滚动职位列表并汇总岗位", risk: "read" }, extractJobs);
registry.register({ name: "filter_jobs", description: "按关键词、城市、公司和最低分筛选岗位", risk: "read" }, input => filterJobs((input || []) as Job[]));
registry.register({ name: "rank_jobs", description: "计算岗位匹配度并生成理由", risk: "read" }, input => rankJobs((input || []) as Job[]));
registry.register({ name: "save_jobs", description: "保存岗位筛选结果", risk: "write" }, async (input) => { await runtimeMessage({ type: "SAVE_SCAN_RESULTS", jobs: input }); });

const tools: AgentTools = {
  getSettings,
  observePage,
  readQueryContext: () => readBossQueryContext(),
  planAction: async context => {
    const response = await runtimeMessage<{ ok: boolean; decision?: AgentDecision; reason?: string }>({
      type: "PLAN_AGENT_ACTION",
      context: { goal: context.goal, intent: context.intent, observation: context.observation, currentQuery: context.currentQuery, state: context.state }
    });
    if (!response?.ok || !response.decision) throw new Error(response?.reason || "LLM 没有返回有效 Agent 动作");
    return response.decision;
  },
  executeBrowserAction,
  verifyAction: verifyBrowserAction,
  isProfilePage,
  findProfileEntry: () => registry.execute<HTMLElement | null>("find_profile_entry"),
  navigate: async element => {
    const anchor = element as HTMLAnchorElement;
    const href = anchor.href;
    const destination = href ? new URL(href, location.href) : null;
    const isBossDestination = Boolean(destination && /(^|\.)zhipin\.com$/i.test(destination.hostname));
    if (href && href !== location.href && isBossDestination) {
      // 由 background 使用 tabs.update 导航，避免 BOSS SPA 和页面点击事件吞掉跳转。
      void runtimeMessage({ type: "NAVIGATE_SOURCE_TAB", url: href });
      return;
    }
    element.click();
  },
  importProfile: () => registry.execute("import_profile"),
  isJobListPage,
  hasJobCards,
  applyFilters: () => registry.execute<QueryApplyResult>("apply_filters"),
  findJobsEntry: async () => {
    const stable = [...document.querySelectorAll<HTMLAnchorElement>("a[href*='/web/geek/jobs'], a[href*='/web/geek/job-recommend']")].find(isVisible);
    const direct = await registry.execute<HTMLElement | null>("find_jobs_entry");
    return stable || direct || [...document.querySelectorAll<HTMLAnchorElement>("a[href*='/job'], a[href*='/search']")].find(isVisible) || null;
  },
  extractJobs: () => registry.execute<Job[]>("extract_jobs"),
  filterJobs: jobs => registry.execute<Job[]>("filter_jobs", jobs),
  rankJobs: jobs => registry.execute<Job[]>("rank_jobs", jobs),
  saveJobs: jobs => registry.execute("save_jobs", jobs),
  waitFor: async (check, description, timeoutMs = 10000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (check()) return;
      await wait(300);
    }
    throw new Error(`等待${description}超时（当前页面：${location.pathname}）`);
  },
  setStatus: async status => { await runtimeMessage({ type: "SET_BOOTSTRAP_STATUS", status }); },
  requestApproval: async request => {
    const response = await runtimeMessage<{ ok: boolean; approval?: import("./types").ApprovalRequest }>({ type: "REQUEST_APPROVAL", request });
    if (!response?.ok || !response.approval) throw new Error("无法创建人工确认请求");
    return response.approval;
  }
};

const runner = new AgentRunner(sessionStorage, tools, null);

chrome.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
  if (message.type === "GET_AGENT_CONTEXT") {
    Promise.all([getSettings(), Promise.resolve(observePage())]).then(([settings, observation]) => {
      const currentQuery = readBossQueryContext();
      sendResponse({ observation, currentQuery, intent: buildAgentIntent(settings, currentQuery) });
    }).catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message.type === "PING") {
    sendResponse({ ok: true, page: location.href });
    return false;
  }
  if (message.type === "IMPORT_PROFILE") {
    importProfile().then(sendResponse).catch(error => sendResponse({ ok: false, reason: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message.type === "SCAN_JOBS") {
    extractJobs().then(filterJobs).then(rankJobs).then(async jobs => { await runtimeMessage({ type: "SAVE_SCAN_RESULTS", jobs }); sendResponse(jobs); }).catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
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
  return false;
});

void runner.resume();
