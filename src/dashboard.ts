import type { AgentIntent, ApprovalRequest, BootstrapStatus, BossQueryContext, Job, PageSnapshot, Settings } from "./types";

if (new URLSearchParams(location.search).has("embedded")) document.body.classList.add("embedded");
let sourceTabId = Number(new URLSearchParams(location.search).get("tabId")) || null;
let dead = false;
let collectListening = false;

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
  const splitValues = (value: string | undefined): string[] => (value || "")
    .split(/[\n,，、]+/)
    .map(item => item.trim())
    .filter(Boolean);
  const tags = [
    ...splitValues(settings.jobKeywords),
    ...splitValues(settings.targetLocations),
    ...splitValues(settings.targetSalary),
    ...splitValues(settings.jobTypes),
    ...splitValues(settings.workExperience),
    ...splitValues(settings.education),
    ...splitValues(settings.companyIndustries),
    ...splitValues(settings.companySizes),
    ...splitValues(settings.workMode)
  ];
  $("intentTags").innerHTML = tags.length ? tags.map(tag => `<span>${esc(tag)}</span>`).join("") : "<span>尚未设置岗位条件</span>";
  const filters = [
    ["关键词", settings.jobKeywords],
    ["城市", settings.targetLocations],
    ["薪资", settings.targetSalary],
    ["求职类型", settings.jobTypes],
    ["经验", settings.workExperience],
    ["学历", settings.education],
    ["行业", settings.companyIndustries],
    ["规模", settings.companySizes],
    ["工作方式", settings.workMode],
    ["最低分", settings.minMatchScore]
  ].filter(([, value]) => Boolean(value));
  $("filterSummary").innerHTML = filters.length ? filters.map(([label, value]) => `<span>${esc(label)}：${esc(value)}</span>`).join("") : "<span>尚未设置，点击“岗位筛选设置”</span>";
  const aiReady = Boolean(settings.aiEnabled && settings.aiApiKey);
  // P2-004：当前没有本地 Planner 兜底——无 LLM 时 planAgentAction 直接失败，UI 必须如实说明，不能说“使用本地规则”。
  $("aiStatus").textContent = aiReady ? `已连接 · ${settings.aiModel || "gpt-4o-mini"}` : "未配置 LLM，无法启动";
  $("aiStatus").className = aiReady ? "connected" : "offline";
  $("aiDetails").textContent = aiReady
    ? `模型：${settings.aiModel || "gpt-4o-mini"} · 用于页面观察、动作规划与岗位匹配`
    : "请在设置中配置 API Base URL、模型和 API Key；无 LLM 时 Agent 无法运行。";
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
  const contextRaw = tab?.id ? await tabsMessage<AgentContextSnapshot & { ok?: boolean; error?: string; snapshot?: PageSnapshot }>(tab.id, { type: "GET_AGENT_CONTEXT" }) : null;
  // GET_AGENT_CONTEXT 出错时返回 {ok:false,error}（truthy 但非 context），renderAgentContext 会当 context 崩。
  // 只当确有 snapshot 字段才当 context，否则按 null 处理。
  const context = contextRaw && contextRaw.snapshot ? contextRaw : null;
  renderAgentContext(context, status);
  if (status?.message) setNotice(status.message, status.ok === false);
  renderApproval(approval?.pendingApproval || null);
  const { agentLog = [] } = await chrome.storage.local.get({ agentLog: [] as string[] });
  const logEl = document.getElementById("decisionLog");
  if (logEl) logEl.textContent = agentLog.slice(-15).join("\n");
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
    setNotice("当前不在职位列表页，正在打开职位列表并开始筛选…");
    await runtimeMessage({ type: "SET_BOOTSTRAP_STATUS", status: { ok: true, message: "正在转到职位列表…", step: "find_jobs" } });
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
  if (!confirm("重置本次 Agent 任务和已筛选结果？岗位筛选设置和模型配置会保留。")) return;
  await runtimeMessage({ type: "CLEAR_IMPORTED_DATA" });
  const tab = await sourceTab();
  if (tab?.id) await tabsMessage(tab.id, { type: "RESET_AGENT" });
  setNotice("已重置本次任务，岗位筛选设置已保留");
  await refresh();
});
$("settings").addEventListener("click", () => void chrome.runtime.openOptionsPage());

// 诊断快照：在不开 DevTools（BOSS 反调试会闪退）的前提下，直接在侧栏查看 content script
// 对当前页的解析结果（snapshot.elements / currentQuery），并标注关键控件是否命中。
$("diagSnapshot").addEventListener("click", async () => {
  const out = $("diagOutput");
  out.hidden = false;
  out.textContent = "正在解析当前 BOSS 页面…";
  const tab = await sourceTab();
  if (!tab?.id) { out.textContent = "未找到 BOSS 标签页（请先在 zhipin.com 打开职位列表）"; return; }
  const result = await tabsMessage<{ snapshot?: { elements?: unknown[]; currentQuery?: Record<string, unknown>; kind?: string; url?: string }; error?: string }>(tab.id, { type: "GET_AGENT_CONTEXT" });
  if (!result?.snapshot) { out.textContent = `取快照失败：${result?.error || "content script 未响应（扩展是否已重载？）"}`; return; }
  const snap = result.snapshot;
  const els = Array.isArray(snap.elements) ? snap.elements as Array<{ id: string; role: string; text: string; region: string; current?: string; checked?: boolean }> : [];
  const has = (pred: (e: typeof els[number]) => boolean) => els.some(pred);
  const lines: string[] = [];
  lines.push(`页面：${snap.kind || "?"}  ${snap.url || ""}`);
  lines.push(`元素：${els.length} 个`);
  const cq = snap.currentQuery || {};
  const cqSummary = ["keyword","location","salary","jobTypes","workModes","experience","education","industries","companySizes"]
    .map(k => { const v = cq[k]; const arr = Array.isArray(v) ? v.filter(Boolean) : (v ? [String(v)] : []); return arr.length ? `${k}=${arr.join("/")}` : null; })
    .filter(Boolean).join("  ");
  lines.push(`currentQuery：${cqSummary || "（空）"}`);
  lines.push("");
  lines.push("命中检查（决定后续 LLM 能否操作）：");
  const mark = (ok: boolean, label: string) => `  ${ok ? "✓" : "✗"} ${label}`;
  const searchOk = has(e => e.region === "search" || /input/i.test(e.role));
  const salaryChip = els.find(e => e.region === "filter" && /薪资|薪水/.test(e.text));
  const expChip = els.find(e => e.region === "filter" && /经验/.test(e.text));
  const eduChip = els.find(e => e.region === "filter" && /学历/.test(e.text));
  const pager = has(e => e.region === "pager");
  const chatSend = has(e => e.region === "chat" && /发送|send/i.test(e.text));
  const jobCount = els.filter(e => e.region === "job").length;
  lines.push(`<span class="${searchOk ? "ok" : "miss"}">${mark(searchOk, "搜索框")}</span>`);
  lines.push(`<span class="${salaryChip ? "ok" : "miss"}">${mark(Boolean(salaryChip), `薪资 chip${salaryChip ? `（当前=${salaryChip.current || "不限"}）` : ""}`)}</span>`);
  lines.push(`<span class="${expChip ? "ok" : "miss"}">${mark(Boolean(expChip), `经验 chip${expChip ? `（当前=${expChip.current || "不限"}）` : ""}`)}</span>`);
  lines.push(`<span class="${eduChip ? "ok" : "miss"}">${mark(Boolean(eduChip), `学历 chip${eduChip ? `（当前=${eduChip.current || "不限"}）` : ""}`)}</span>`);
  lines.push(`<span class="${jobCount > 0 ? "ok" : "miss"}">${mark(jobCount > 0, `岗位卡（${jobCount}）`)}</span>`);
  lines.push(`<span class="${pager ? "ok" : "miss"}">${mark(pager, "分页控件")}</span>`);
  lines.push(`<span class="${chatSend ? "ok" : "miss"}">${mark(chatSend, "沟通发送按钮（需在岗位详情/沟通窗）")}</span>`);
  lines.push("");
  lines.push("elements（前 40）：");
  for (const e of els.slice(0, 40)) {
    const parts = [`[e${e.id}]`, e.role, `"${esc((e.text || "").slice(0, 30))}"`];
    if (e.current) parts.push(`cur="${esc(e.current)}"`);
    if (e.checked) parts.push("✓");
    parts.push(`@${e.region}`);
    lines.push(parts.join(" "));
  }
  if (els.length > 40) lines.push(`…还有 ${els.length - 40} 个`);
  out.innerHTML = lines.join("\n");
});

// DOM 探测：采集真实 BOSS 的岗位容器/岗位卡/chip/导航祖先结构（outerHTML 片段），
// 用于校准 snapshot 的选择器（诊断快照只给文本，这里给结构）。
$("diagDom").addEventListener("click", async () => {
  const out = $("diagOutput");
  out.hidden = false;
  out.textContent = "正在探测 BOSS DOM 结构…";
  const tab = await sourceTab();
  if (!tab?.id) { out.textContent = "未找到 BOSS 标签页"; return; }
  const r = await tabsMessage<{ url?: string; jobContainer?: Array<{ found: boolean; sel: string; tag?: string; cls?: string; childCount?: number; outer?: string }>; jobCard?: Array<{ found: boolean; sel: string; tag?: string; cls?: string; outer?: string }>; chipProbe?: Array<{ found: boolean; sel: string; outer?: string }>; nav?: { tag?: string; cls?: string; outer?: string; ancestors?: string[] } | null; error?: string }>(tab.id, { type: "GET_DIAG_DOM" });
  if (r?.error) { out.textContent = `探测出错：${r.error}`; return; }
  if (!r) { out.textContent = "content script 未响应（重载扩展？）"; return; }
  const esc2 = (s: string) => esc(s).replaceAll("\n", " ");
  const lines: string[] = [`URL：${r.url || ""}`];
  const section = (title: string, items: typeof r.jobContainer | undefined) => {
    lines.push("", title);
    if (!items) { lines.push("（无）"); return; }
    for (const it of items) {
      if (!it.found) { lines.push(`  ✗ ${it.sel}`); continue; }
      lines.push(`  ✓ ${it.sel}  tag=${it.tag} cls="${esc2(it.cls || "")}" children=${it.childCount ?? "?"}`);
    }
  };
  section("=== 岗位容器候选 ===", r.jobContainer);
  section("=== 岗位卡候选 ===", r.jobCard);
  section("=== chip 候选 ===", r.chipProbe);
  lines.push("", "=== “首页”导航祖先链 ===");
  if (r.nav) {
    lines.push(`节点：${r.nav.tag}.${esc2(r.nav.cls || "")}  outer=${esc2(r.nav.outer || "")}`);
    for (const a of r.nav.ancestors || []) lines.push(`  ↑ ${esc2(a)}`);
  } else { lines.push("（未找到“首页”链接）"); }
  // 命中的容器/卡各取第一个 outerHTML 样本
  const firstFound = (arr: typeof r.jobContainer | undefined) => arr?.find(x => x.found);
  const jc = firstFound(r.jobContainer); const jcard = firstFound(r.jobCard); const chip = firstFound(r.chipProbe);
  lines.push("", "=== outerHTML 样本（前 400 字，贴回给我）===");
  if (jc?.outer) lines.push(`[岗位容器 ${jc.sel}]`, esc2(jc.outer));
  if (jcard?.outer) lines.push(`[岗位卡 ${jcard.sel}]`, esc2(jcard.outer));
  if (chip?.outer) lines.push(`[chip ${chip.sel}]`, esc2(chip.outer));
  if (!jc && !jcard && !chip) lines.push("（以上候选均未命中——需要你贴一段岗位区域的 HTML）");
  // 当前打开的下拉选项（用户先手动点开某个筛选，再点 DOM 探测）
  const opts = (r as { optionCandidates?: Array<{ tag?: string; cls?: string; text?: string; selected?: boolean }> }).optionCandidates;
  const panel = (r as { panelSample?: { tag?: string; cls?: string; outer?: string } | null }).panelSample;
  if (opts && opts.length) {
    lines.push("", `=== 当前打开的下拉选项（${opts.length} 个）===`);
    for (const o of opts) lines.push(`  ${o.selected ? "☑" : "☐"} ${esc2(o.text || "")}  <${o.tag} class="${esc2(o.cls || "")}">`);
  } else {
    lines.push("", "=== 当前打开的下拉选项 ===", "（无——请先在 BOSS 页面手动点开一个筛选下拉，再点 DOM 探测）");
  }
  if (panel?.outer) lines.push("", "[选项面板容器]", esc2(panel.outer));
  out.innerHTML = lines.join("\n");
});

// 自动采集 BOSS 筛选下拉的真实选项（content script 自己 hover 每个筛选 chip，
// 抓选项后关闭）。结果存 chrome.storage.filterOptions，后续用于把设置页改成"从选项里选"。
$("collectOptions").addEventListener("click", async () => {
  const out = $("diagOutput");
  out.hidden = false;
  const tab = await sourceTab();
  if (!tab?.id) { out.textContent = "未找到 BOSS 标签页"; return; }
  if (!collectListening) {
    const r = await tabsMessage<{ ok?: boolean }>(tab.id, { type: "COLLECT_OPTIONS_LISTEN", action: "start" });
    if (!r?.ok) { out.textContent = "启动监听失败（重载扩展+刷新 BOSS 页）"; return; }
    collectListening = true;
    document.getElementById("collectOptions")!.textContent = "■ 结束监听";
    out.innerHTML = "监听中…请在 BOSS 页面依次 <b>hover 打开每个筛选下拉</b>（薪资/经验/学历/求职类型/行业/规模，每个停 1 秒）。<br>全部打开后回来点「结束监听」。";
  } else {
    const r = await tabsMessage<{ ok?: boolean; batches?: Array<Array<{ text: string; code: string }>> }>(tab.id, { type: "COLLECT_OPTIONS_LISTEN", action: "stop" });
    collectListening = false;
    document.getElementById("collectOptions")!.textContent = "采集筛选选项";
    if (!r?.ok) { out.textContent = "结束失败"; return; }
    const batches = r.batches || [];
    if (!batches.length) { out.innerHTML = "未抓到任何选项。请确认：监听期间确实 hover 打开了下拉（面板展开了），且选项是 li/[role=option] 结构。"; return; }
    const lines: string[] = [`抓到 ${batches.length} 批选项（请按 hover 顺序贴回：薪资→求职类型→经验→学历→规模→行业）：`];
    batches.forEach((b: Array<{ text: string; code: string }>, i: number) => {
      lines.push("", `【批次 ${i + 1}】（${b.length} 个）：`);
      for (const x of b) lines.push(`  ${esc(x.text)}  →  ${esc(x.code || "（无码）")}`);
    });
    out.innerHTML = lines.join("\n");
  }
});

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
  // 不自动启动 Agent——由用户手动点「开始智能筛选」。避免一打开侧栏就自动跑。
  await refresh();
}

$("collectDimBtn").addEventListener("click", async () => {
  const dimName: Record<string, string> = { jobTypes: "求职类型", targetSalary: "薪资", workExperience: "经验", education: "学历", companySizes: "规模", companyIndustries: "行业" };
  const dim = (document.getElementById("collectDim") as HTMLSelectElement).value;
  const out = $("diagOutput");
  out.hidden = false;
  out.textContent = `8 秒内请在 BOSS hover 打开「${dimName[dim] || dim}」下拉并保持展开…`;
  const tab = await sourceTab();
  if (!tab?.id) { out.textContent = "未找到 BOSS 标签页"; return; }
  const r = await tabsMessage<{ ok?: boolean; items?: Array<{ text: string; code: string; tag?: string; cls?: string }>; error?: string }>(tab.id, { type: "COLLECT_DIM_CODES", dim });
  if (!r?.ok) { out.textContent = `采集失败：${r?.error || "未响应（重载扩展+刷新）"}`; return; }
  const lines = [`【${dimName[dim] || dim}】采到 ${r.items?.length || 0} 个：`];
  for (const it of r.items || []) lines.push(`  ${it.text}  →  ${it.code || "（无码）"}  <${it.tag} .${it.cls || ""}>`);
  out.textContent = lines.join("\n");
  if (r.items?.length) await chrome.storage.local.set({ [`filterCodes_${dim}`]: r.items });
});

void init();
setInterval(() => void refresh().catch(() => undefined), 1500);
