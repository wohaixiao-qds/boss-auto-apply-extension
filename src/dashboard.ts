import type { AgentIntent, ApprovalRequest, BootstrapStatus, BossQueryContext, Job, PageSnapshot, Settings } from "./types";

if (new URLSearchParams(location.search).has("embedded")) document.body.classList.add("embedded");
let sourceTabId = Number(new URLSearchParams(location.search).get("tabId")) || null;
let dead = false;
let autoTriggered = false;

interface AgentContextSnapshot {
  snapshot: PageSnapshot;
  currentQuery: BossQueryContext;
  intent: AgentIntent;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const esc = (value: unknown): string => String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

async function runtimeMessage<T>(message: unknown): Promise<T | null> {
  if (dead) return null;
  try { return await chrome.runtime.sendMessage(message) as T; }
  catch { dead = true; setNotice("插件刚刚更新，请关闭控制台并刷新 BOSS 页面", true); return null; }
}

async function tabsMessage<T>(tabId: number, message: unknown): Promise<T | null> {
  if (dead) return null;
  try { return await chrome.tabs.sendMessage(tabId, message) as T; }
  catch { return null; }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForContentScript(tabId: number): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await tabsMessage<{ ok: boolean }>(tabId, { type: "PING" });
    if (result?.ok) return true;
    await delay(300 * (attempt + 1));
  }
  return false;
}

function setNotice(message: string, error = false): void {
  $("notice").textContent = message;
  $("notice").className = `notice${error ? " error" : ""}`;
}

async function sourceTab(): Promise<chrome.tabs.Tab | null> {
  const isBossTab = (tab: chrome.tabs.Tab | null): tab is chrome.tabs.Tab => Boolean(tab?.id && /zhipin\.com/.test(tab.url || ""));
  if (sourceTabId) {
    const tab = await chrome.tabs.get(sourceTabId).catch(() => null);
    if (isBossTab(tab)) return tab;
    sourceTabId = null;
  }
  const { agentSourceTabId } = await chrome.storage.local.get({ agentSourceTabId: null }) as { agentSourceTabId: number | null };
  if (agentSourceTabId) {
    const tab = await chrome.tabs.get(agentSourceTabId).catch(() => null);
    if (isBossTab(tab)) {
      sourceTabId = tab.id || null;
      return tab;
    }
    await chrome.storage.local.remove("agentSourceTabId");
  }
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (isBossTab(activeTab)) {
    sourceTabId = activeTab.id || null;
    await chrome.storage.local.set({ agentSourceTabId: sourceTabId });
    return activeTab;
  }
  const tabs = await chrome.tabs.query({ windowType: "normal" });
  const bossTab = tabs.find(isBossTab) || null;
  if (bossTab?.id) {
    sourceTabId = bossTab.id;
    await chrome.storage.local.set({ agentSourceTabId: bossTab.id });
  }
  return bossTab;
}

function renderSettings(settings: Settings): void {
  const profile = settings.candidateProfileClean || "";
  $("profileSummary").className = `summary${profile ? "" : " empty"}`;
  const summary = settings.jobIntent?.summary || profile.split(/\n+/).filter(Boolean).slice(0, 3).join("；");
  $("profileSummary").textContent = summary || "点击“开始智能筛选”，Agent 会先读取当前简历";
  $("profileDetails").style.display = profile ? "block" : "none";
  $("profileRaw").textContent = profile;
  $("profileTime").textContent = settings.profileSyncedAt ? `已导入 ${new Date(settings.profileSyncedAt).toLocaleString()}` : "尚未导入";
  const intent = settings.jobIntent || { targetTitles: [], skills: [], locations: [], salary: "", workModes: [], summary: "" };
  const tags = [...intent.targetTitles, ...intent.skills.slice(0, 10), ...intent.locations, intent.salary, ...intent.workModes].filter(Boolean);
  $("intentTags").innerHTML = tags.length ? tags.map(tag => `<span>${esc(tag)}</span>`).join("") : "<span>尚未分析</span>";
  const filters = [
    ["关键词", settings.jobKeywords || intent.targetTitles.join("、")],
    ["城市", settings.targetLocations || intent.locations.join("、")],
    ["薪资", settings.targetSalary || intent.salary],
    ["求职类型", settings.jobTypes],
    ["经验", settings.workExperience],
    ["学历", settings.education],
    ["行业", settings.companyIndustries],
    ["规模", settings.companySizes],
    ["工作方式", settings.workMode || intent.workModes.join("、")],
    ["最低分", settings.minMatchScore]
  ].filter(([, value]) => Boolean(value));
  $("filterSummary").innerHTML = filters.length ? filters.map(([label, value]) => `<span>${esc(label)}：${esc(value)}</span>`).join("") : "<span>尚未设置，点击“岗位筛选设置”</span>";
  const aiReady = Boolean(settings.aiEnabled && settings.aiApiKey);
  $("aiStatus").textContent = aiReady ? `已连接 · ${settings.aiModel || "gpt-4o-mini"}` : "未连接，使用本地规则";
  $("aiStatus").className = aiReady ? "connected" : "offline";
  $("aiDetails").textContent = aiReady ? `模型：${settings.aiModel || "gpt-4o-mini"} · 用于简历清洗、意向分析和岗位匹配` : "请在设置中配置 API Base URL、模型和 API Key";
}

function queryValues(query: BossQueryContext): string[] {
  return [
    query.keyword && `关键词：${query.keyword}`,
    query.location.length && `城市：${query.location.join("、")}`,
    query.salary.length && `薪资：${query.salary.join("、")}`,
    query.jobTypes.length && `类型：${query.jobTypes.join("、")}`,
    query.workModes.length && `方式：${query.workModes.join("、")}`,
    query.experience.length && `经验：${query.experience.join("、")}`,
    query.education.length && `学历：${query.education.join("、")}`,
    query.industries.length && `行业：${query.industries.join("、")}`,
    query.companySizes.length && `规模：${query.companySizes.join("、")}`
  ].filter(Boolean) as string[];
}

function renderAgentContext(context: AgentContextSnapshot | null, status: BootstrapStatus | null): void {
  if (!context) {
    $("currentPage").textContent = "等待连接 BOSS 页面";
    $("currentQuerySummary").innerHTML = "<span>打开 BOSS 页面后自动读取</span>";
    return;
  }
  const sourceLabels: Record<AgentIntent["source"], string> = {
    user: "来自用户设置",
    page: "来自 BOSS 当前条件"
  };
  const pageLabels: Record<PageSnapshot["kind"], string> = {
    jobs: "当前在职位列表页",
    job_detail: "当前在职位详情页",
    login: "当前需要登录",
    unknown: "页面暂未识别"
  };
  const currentValues = queryValues(context.currentQuery);
  const targetValues = [
    ...queryValues(context.intent.query),
    ...context.intent.excludeCompanies.map(company => `排除：${company}`),
    context.intent.minMatchScore > 0 ? `最低匹配：${context.intent.minMatchScore}分` : ""
  ].filter(Boolean);
  $("intentSource").textContent = sourceLabels[context.intent.source];
  $("intentSummary").textContent = context.intent.summary;
  $("intentSummary").className = `intent-summary${context.intent.defined ? "" : " empty"}`;
  $("currentPage").textContent = pageLabels[context.snapshot.kind];
  $("currentQuerySummary").innerHTML = currentValues.length ? currentValues.map(value => `<span>${esc(value)}</span>`).join("") : "<span>当前页面没有已识别条件</span>";
  $("filterSummary").innerHTML = targetValues.length ? targetValues.map(value => `<span>${esc(value)}</span>`).join("") : "<span>尚未设置岗位目标</span>";
  $("lastDecision").textContent = status?.state?.lastDecision || "尚未开始观察";
  const nextLabels: Record<string, string> = {
    idle: "观察当前页面",
    find_jobs: "进入职位列表页",
    apply_filters: "把目标条件写入 BOSS 查询控件",
    extract_jobs: "读取岗位并自动翻页",
    filter_jobs: "按意图约束筛除不符合岗位",
    rank_jobs: "计算匹配度并排序",
    awaiting_approval: "等待你确认打招呼名单",
    awaiting_input: "等待补充岗位目标",
    greeting: "按批准名单逐个打招呼",
    done: "展示最终岗位结果",
    failed: "等待处理失败原因"
  };
  $("nextAction").textContent = nextLabels[status?.step || "idle"] || "继续观察并重新规划";
}

function renderJobs(jobs: Job[]): void {
  $("jobCount").textContent = `${jobs.length} 个匹配岗位`;
  $("jobsBody").innerHTML = jobs.length
    ? jobs.map(job => `<tr><td><span class="score">${esc(job.score)} 分</span></td><td>${esc(job.company)}</td><td>${esc(job.title)}</td><td>${esc(job.location)}</td><td>${esc(job.salary)}</td><td>${esc(job.reason || job.matchedKeywords.join("、") || "规则匹配")}</td></tr>`).join("")
    : `<tr><td colspan="6" class="empty-cell">没有达到筛选条件的岗位</td></tr>`;
}

function renderAgentStatus(status: BootstrapStatus | null): void {
  const element = $("status");
  const step = status?.step || "idle";
  element.textContent = status?.ok === false ? "执行失败" : step === "done" ? "已完成" : step === "awaiting_input" ? "等待补充" : step === "idle" ? "待启动" : "执行中";
  element.className = `status-pill ${status?.ok === false ? "error" : step === "done" ? "done" : step === "idle" ? "idle" : "running"}`;
}

function renderProgress(status: BootstrapStatus | null): void {
  const order = ["find_jobs", "apply_filters", "extract_jobs", "filter_jobs", "rank_jobs", "awaiting_approval", "greeting", "awaiting_input", "done"];
  const raw = String(status?.step || "idle");
  const current = raw === "awaiting_input" ? "awaiting_input" : raw === "done" ? "done" : raw === "idle" ? "find_jobs" : order.includes(raw) ? raw : "find_jobs";
  const currentIndex = order.indexOf(current);
  const label = current === "done" ? "已完成" : status?.ok === false ? "失败" : current === "awaiting_input" ? "等待补充岗位目标" : current === "awaiting_approval" ? "等待打招呼审批" : status?.message || "执行中";
  $("progressLabel").textContent = label;
  document.querySelectorAll<HTMLElement>("[data-agent-step]").forEach(element => {
    const step = element.dataset.agentStep || "";
    const index = order.indexOf(step);
    element.className = index < currentIndex || current === "done" ? "completed" : index === currentIndex ? status?.ok === false ? "failed" : "active" : "";
  });
}

function renderApproval(approval: ApprovalRequest | null): void {
  const card = $("approvalCard");
  if (!approval || approval.status !== "pending") {
    card.style.display = "none";
    return;
  }
  card.style.display = "block";
  $("approvalAction").textContent = approval.action;
  $("approvalDescription").textContent = `${approval.title}：${approval.description}`;
  const jobsBody = $("approvalJobs");
  const jobs = approval.jobs || [];
  jobsBody.innerHTML = jobs.length
    ? jobs.map(job => `<label class="approval-job"><input type="checkbox" data-url="${esc(job.url)}" checked /><span class="score">${esc(job.score)} 分</span><span class="company">${esc(job.company)}</span><span class="title">${esc(job.title)}</span><span class="reason">${esc(job.reason || job.matchedKeywords.join("、") || "")}</span></label>`).join("")
    : `<p class="empty-cell">没有待审批的岗位</p>`;
  ($("approveAction") as HTMLButtonElement).dataset.approvalId = approval.id;
  ($("rejectAction") as HTMLButtonElement).dataset.approvalId = approval.id;
}

function renderUnknown(status: BootstrapStatus | null): void {
  const card = $("unknownCard");
  const greetStatus = status?.state?.greetStatus || {};
  const ranked = status?.state?.lastRankedJobs || [];
  const rankedByUrl = new Map(ranked.map(job => [job.url, job]));
  const unknownUrls = Object.entries(greetStatus).filter(([, s]) => s === "unknown").map(([url]) => url);
  if (!unknownUrls.length) {
    card.style.display = "none";
    $("unknownBody").innerHTML = "";
    return;
  }
  card.style.display = "block";
  $("unknownBody").innerHTML = unknownUrls.map(url => {
    const job = rankedByUrl.get(url);
    const label = job ? `${esc(job.company)} · ${esc(job.title)}` : esc(url);
    return `<div class="unknown-row" data-url="${esc(url)}"><span class="unknown-label">${label}</span><button class="secondary" data-verdict="sent">已发送</button><button class="danger" data-verdict="skipped">未发送，跳过</button></div>`;
  }).join("");
}

function renderCostReadout(status: BootstrapStatus | null): void {
  const state = status?.state;
  if (!state) { $("costReadout").textContent = ""; return; }
  const phaseLabel = state.phase === "greet" ? "打招呼阶段" : state.phase === "screen" ? "筛选阶段" : "";
  const cost = Number(state.costYuan || 0).toFixed(2);
  $("costReadout").textContent = `${phaseLabel} · 已花费 ¥${cost}`;
}

async function refresh(): Promise<void> {
  const [settings, results, status, approval] = await Promise.all([
    runtimeMessage<Settings>({ type: "GET_SETTINGS" }),
    runtimeMessage<{ lastScanResults: Job[] }>({ type: "GET_SCAN_RESULTS" }),
    runtimeMessage<BootstrapStatus>({ type: "GET_BOOTSTRAP_STATUS" }),
    runtimeMessage<{ pendingApproval: ApprovalRequest | null }>({ type: "GET_APPROVAL" })
  ]);
  if (settings) renderSettings(settings);
  if (results?.lastScanResults) renderJobs(results.lastScanResults);
  renderAgentStatus(status);
  renderProgress(status);
  renderCostReadout(status);
  renderUnknown(status);
  const tab = await sourceTab();
  const context = tab?.id ? await tabsMessage<AgentContextSnapshot>(tab.id, { type: "GET_AGENT_CONTEXT" }) : null;
  renderAgentContext(context, status);
  if (status?.message) setNotice(status.message, status.ok === false);
  renderApproval(approval?.pendingApproval || null);
}

async function bootstrap(restart = true): Promise<void> {
  const button = $("bootstrap") as HTMLButtonElement;
  button.disabled = true;
  setNotice("正在启动 Agent…");
  const tab = await sourceTab();
  if (!tab?.id || !/zhipin\.com/.test(tab.url || "")) {
    setNotice("请先打开已登录的 BOSS 页面", true);
    button.disabled = false;
    return;
  }
  sourceTabId = tab.id;
  await chrome.storage.local.set({ agentSourceTabId: sourceTabId });
  await runtimeMessage({ type: "SET_BOOTSTRAP_STATUS", status: { ok: true, message: "正在启动 Agent…", step: "idle" } });
  if (!(await waitForContentScript(tab.id))) {
    setNotice("无法连接 BOSS 页面脚本，请刷新当前 BOSS 页面后重试", true);
    button.disabled = false;
    return;
  }
  const result = await tabsMessage<{ ok: boolean; message?: string; reason?: string }>(tab.id, { type: "AUTOMATE_BOOTSTRAP", restart });
  if (!result) setNotice("Agent 启动请求没有收到页面响应，请刷新 BOSS 页面后重试", true);
  else setNotice(result.ok ? result.message || "Agent 正在执行…" : result.reason || "Agent 启动失败", !result.ok);
  button.disabled = false;
}

async function scan(): Promise<void> {
  const tab = await sourceTab();
  if (!tab?.id || !/zhipin\.com/.test(tab.url || "")) { setNotice("请先打开 BOSS 职位列表页", true); return; }
  if (/\/resume|\/profile|\/personal|\/account/i.test(tab.url || "")) {
    setNotice("当前在简历页，正在打开职位列表并开始筛选…");
    await runtimeMessage({ type: "SET_BOOTSTRAP_STATUS", status: { ok: true, message: "正在从简历页转到职位列表…", step: "find_jobs" } });
    const result = await tabsMessage<{ ok: boolean; message?: string; reason?: string }>(tab.id, { type: "AUTOMATE_BOOTSTRAP", restart: true });
    if (!result?.ok) setNotice(result?.reason || "无法打开职位列表页", true);
    return;
  }
  const jobs = await tabsMessage<Job[]>(tab.id, { type: "SCAN_JOBS" });
  if (jobs) { renderJobs(jobs); setNotice(`已筛选 ${jobs.length} 个岗位`); }
}

$("bootstrap").addEventListener("click", () => void bootstrap());
$("scan").addEventListener("click", () => void scan());
$("stopAgent").addEventListener("click", async () => {
  await runtimeMessage({ type: "STOP_AGENT" });
  setNotice("已请求停止 Agent，下一轮开头生效");
});
$("clearData").addEventListener("click", async () => {
  if (!confirm("重置本次 Agent 任务和已导入结果？岗位筛选设置和模型配置会保留。")) return;
  await runtimeMessage({ type: "CLEAR_IMPORTED_DATA" });
  const tab = await sourceTab();
  if (tab?.id) await tabsMessage(tab.id, { type: "RESET_AGENT" });
  setNotice("已重置本次任务，岗位筛选设置已保留");
  await refresh();
});
$("settings").addEventListener("click", () => void chrome.runtime.openOptionsPage());
for (const [id, kind] of [["approveAction", "approve"], ["rejectAction", "reject"]] as const) {
  $(id).addEventListener("click", async () => {
    const approvalId = ($(id) as HTMLButtonElement).dataset.approvalId;
    if (!approvalId) return;
    const selectedUrls = kind === "approve"
      ? Array.from(document.querySelectorAll<HTMLInputElement>("#approvalJobs input[type=checkbox]:checked")).map(box => box.dataset.url || "").filter(Boolean)
      : [];
    const result = await runtimeMessage<{ ok: boolean; error?: string }>({ type: "RESOLVE_APPROVAL", id: approvalId, selectedUrls });
    setNotice(result?.ok ? (kind === "approve" && selectedUrls.length ? `已批准 ${selectedUrls.length} 个岗位并打招呼` : "已拒绝打招呼") : result?.error || "确认请求已失效", !result?.ok);
    await refresh();
  });
}

$("unknownBody").addEventListener("click", async (event) => {
  const button = event.target as HTMLButtonElement;
  if (button?.dataset?.verdict !== "sent" && button?.dataset?.verdict !== "skipped") return;
  const row = button.closest(".unknown-row") as HTMLElement | null;
  const url = row?.dataset.url || "";
  if (!url) return;
  button.disabled = true;
  const result = await runtimeMessage<{ ok: boolean; error?: string }>({ type: "RESOLVE_UNKNOWN_GREET", url, verdict: button.dataset.verdict as "sent" | "skipped" });
  setNotice(result?.ok ? (button.dataset.verdict === "sent" ? "已记录为发送" : "已跳过") : result?.error || "处理失败", !result?.ok);
  await refresh();
});

async function init(): Promise<void> {
  await refresh();
  const settings = await runtimeMessage<Settings>({ type: "GET_SETTINGS" });
  if (settings?.agentAutoStart && !autoTriggered) { autoTriggered = true; setTimeout(() => void bootstrap(false), 400); }
}

void init();
setInterval(() => void refresh().catch(() => undefined), 1500);
