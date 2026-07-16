import { buildAgentIntent } from "./intent";
import { newAgentState, bumpState } from "./state";
import { snapshotPage } from "./snapshot";
import { validateDecision, effectiveQuerySatisfied, validateSelectedUrls } from "./validate";
import { executeBrowserAction } from "./browser-action";
import { buildLlmPayload } from "./payload";
import { mergeRecovery } from "./recovery";
import { nextGreetStatus, greetVerify } from "./greet";
import { shouldBreak, recordAction } from "./guardrails";
import type { AgentActionResult, AgentDecision, AgentState, AgentStep, AgentTools, BossQueryContext, Job, PageSnapshot, Settings } from "../types";

const STORAGE_KEY = "boss-agent-state";

// 决策日志：每轮把 action+ref+reason+页面当前 cur 写入 chrome.storage.agentLog，dashboard 读显示，便于诊断。
async function logDecision(line: string): Promise<void> {
  try {
    const { agentLog = [] } = await chrome.storage.local.get({ agentLog: [] as string[] });
    agentLog.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
    await chrome.storage.local.set({ agentLog: agentLog.slice(-40) });
  } catch { /* 日志失败不影响主流程 */ }
}
function describeQuery(q: BossQueryContext): string {
  const parts: string[] = [];
  if (q.keyword) parts.push(`关键词=${q.keyword}`);
  for (const [k, v] of Object.entries(q)) if (Array.isArray(v) && v.length) parts.push(`${k}=${(v as string[]).join("/")}`);
  return parts.join(" ") || "（空）";
}
const CANDIDATES_KEY = "boss-agent-candidates";
const TERMINAL_STEPS: AgentStep[] = ["done", "failed"];
const MAX_TURNS = 50;

const nowIso = (): string => new Date().toISOString();
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function hashAction(d: AgentDecision): string {
  return `${d.action}|${d.ref ?? ""}|${d.value ?? ""}|${d.direction ?? ""}|${d.amount ?? ""}`;
}

function actionProgressSignature(state: AgentState, snapshot: PageSnapshot): string {
  // 同一个页面快照和 ref 编号可能在不同岗位重复出现；岗位 URL/索引必须
  // 纳入签名，否则跨岗位的正常点击会被误判为连续卡死。
  return `${snapshot.summary}|phase=${state.phase}|greetIndex=${state.currentGreetIndex}|greetUrl=${state.currentGreetUrl}`;
}

function greetJobLabel(state: AgentState, url: string): string {
  const job = state.lastRankedJobs.find(item => item.url === url);
  // confirm:success 会先推进 currentGreetIndex 再写日志，不能用当前指针
  // 计算已完成岗位的序号，否则第 N 个岗位会显示成 N+1/N。
  const approvedIndex = state.approvedForGreet.indexOf(url);
  const position = approvedIndex >= 0 ? approvedIndex + 1 : state.currentGreetIndex + 1;
  return `${position}/${state.approvedForGreet.length} ${job?.company || "未知公司"} · ${job?.title || url}`;
}

const IMMEDIATE_GREET_TEXT = /立即沟通|打招呼/i;

function jobIdFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
    return path.replace(/\.html$/i, "");
  } catch {
    return "";
  }
}

function hasGreetedJob(state: AgentState, url: string): boolean {
  const jobId = jobIdFromUrl(url);
  return state.greeted.some(item => item === url || (jobId && jobIdFromUrl(item) === jobId));
}

function findImmediateGreetRef(
  snapshot: PageSnapshot,
  resolveRef: (ref: string, snapshotId?: string) => HTMLElement | null,
  currentJobUrl: string
): string | null {
  const candidates = snapshot.elements
    .filter(element => element.region !== "filter" && IMMEDIATE_GREET_TEXT.test(element.text))
    .sort((a, b) => Number(b.role === "btn") - Number(a.role === "btn"));
  const currentJobId = jobIdFromUrl(currentJobUrl);
  if (currentJobId) {
    const matched = candidates.find(candidate => {
      const element = resolveRef(candidate.id, snapshot.snapshotId);
      const ka = element?.getAttribute("ka") || "";
      return ka.endsWith(currentJobId);
    });
    if (matched) return matched.id;
  }
  return candidates[0]?.id || null;
}

export class AgentRunner {
  private state: AgentState;
  private running = false;
  private candidates: Job[];
  private currentSnapshot: PageSnapshot | null = null;

  constructor(
    private readonly storage: Storage,
    private readonly tools: AgentTools,
    private readonly sourceTabId: number | null
  ) {
    this.state = this.readState() || newAgentState(crypto.randomUUID(), sourceTabId, nowIso());
    this.candidates = this.readCandidates();
  }

  private readState(): AgentState | null {
    try {
      const value = JSON.parse(this.storage.getItem(STORAGE_KEY) || "null") as Partial<AgentState> | null;
      if (!value?.runId) return null;
      return { ...newAgentState(value.runId, this.sourceTabId, nowIso()), ...value };
    } catch {
      return null;
    }
  }

  private readCandidates(): Job[] {
    try {
      const value = JSON.parse(this.storage.getItem(CANDIDATES_KEY) || "[]");
      return Array.isArray(value) ? value as Job[] : [];
    } catch {
      return [];
    }
  }

  private persist(): void {
    this.storage.setItem(STORAGE_KEY, JSON.stringify(this.state));
  }

  private async persistRecovery(): Promise<void> {
    if (!this.tools.setAgentRecovery) return;
    try {
      await this.tools.setAgentRecovery({
        runId: this.state.runId,
        stateVersion: this.state.stateVersion,
        updatedAt: this.state.updatedAt,
        phase: this.state.phase,
        approvedForGreet: this.state.approvedForGreet,
        greeted: this.state.greeted,
        currentGreetIndex: this.state.currentGreetIndex,
        greetListUrl: this.state.greetListUrl
      });
    } catch {
      // 恢复镜像写入失败不应阻断主流程。
    }
  }

  private async loadRecovery(): Promise<void> {
    if (!this.tools.getAgentRecovery) return;
    try {
      const remote = await this.tools.getAgentRecovery();
      if (!remote) return;
      // 镜像是 AgentState 的子集；叠加到本地状态上以形成完整 AgentState 供 mergeRecovery 比较。
      const remoteState: AgentState = { ...this.state, ...remote };
      const merged = mergeRecovery(this.state, remoteState);
      if (merged === remoteState) {
        this.state = merged;
        this.persist();
      }
    } catch {
      // 恢复读取失败不应阻断主流程。
    }
  }

  private persistCandidates(): void {
    this.storage.setItem(CANDIDATES_KEY, JSON.stringify(this.candidates));
  }

  private async setStatus(ok: boolean, message: string, step?: AgentStep): Promise<void> {
    await this.tools.setStatus({ ok, message, step: step ?? this.state.step, runId: this.state.runId, state: this.state });
  }

  async start(restart = false): Promise<{ ok: boolean; pending: boolean; message: string }> {
    if (this.running) return { ok: true, pending: true, message: "Agent 已在执行中" };
    if (restart || TERMINAL_STEPS.includes(this.state.step)) {
      this.state = newAgentState(crypto.randomUUID(), this.sourceTabId, nowIso());
      this.candidates = [];
      this.persistCandidates();
      await chrome.storage.local.remove("agentLog");
    }
    this.running = true;
    try {
      // 若从已恢复的 greet 状态继续（非 restart），同样先校验 approvedForGreet（幂等）。
      if (!restart && this.state.phase === "greet") await this.validateApprovedForGreet();
      await this.run();
    } finally {
      this.running = false;
    }
    return { ok: this.state.step !== "failed", pending: !TERMINAL_STEPS.includes(this.state.step), message: "Agent 已开始观察页面" };
  }

  reset(): void {
    this.state = newAgentState(crypto.randomUUID(), this.sourceTabId, nowIso());
    this.candidates = [];
    this.persist();
    this.persistCandidates();
  }

  async resume(): Promise<void> {
    if (TERMINAL_STEPS.includes(this.state.step) || this.running) return;
    // 必须在第一次 await 之前占用运行锁。
    // 否则页面导航、审批回调和 content 初始化可能同时调用 resume()，
    // 两个 Agent loop 会并行操作同一个 BOSS 页面。
    this.running = true;
    try {
      // 从 chrome.storage.local 镜像合并恢复数据（审批通过后由 background 写入）。
      await this.loadRecovery();
      // Carry-forward（Task 7→8）：审批通过的列表到达后，先过 validateSelectedUrls 再进入打招呼循环。
      await this.validateApprovedForGreet();
      await this.run();
    } finally {
      this.running = false;
    }
  }

  /**
   * 人工裁决未知打招呼结果（RESOLVE_UNKNOWN_GREET）。
   * sent → verified（并入 greeted，去重）；skipped → failed。随后推进到下一岗位。
   */
  resolveUnknownGreet(url: string, verdict: "sent" | "skipped"): void {
    // P1-008：仅信任针对“当前批准列表内、且确实处于 unknown 态”的 url；其余一律忽略，
    // 避免错误岗位被标记已发送、当前岗位被错误跳过、或重复提交多次推进 index。
    if (!url || !this.state.approvedForGreet.includes(url)) return;
    if (this.state.greetStatus[url] !== "unknown") return;
    const status = verdict === "sent" ? "verified" : "failed";
    this.state.greetStatus = { ...this.state.greetStatus, [url]: status };
    if (status === "verified" && !hasGreetedJob(this.state, url)) {
      this.state.greeted = [...this.state.greeted, url];
    }
    if (this.state.currentGreetUrl === url) this.state.currentGreetUrl = "";
    if (this.state.approvedForGreet[this.state.currentGreetIndex] === url) {
      this.state.currentGreetIndex += 1;
    }
    this.state = bumpState({ ...this.state, lastDecision: `resolve_unknown_greet: ${url} → ${status}` }, nowIso());
    this.persist();
  }

  /**
   * Carry-forward：审批通过的 approvedForGreet 到达后，过滤掉非 zhipin/未排序/排除公司/超 cap 的 URL。
   * 仅在刚进入 Phase B、尚未开始推进时执行一次（幂等：对已校验列表再跑结果不变）。
   */
  private async validateApprovedForGreet(): Promise<void> {
    if (this.state.phase !== "greet") return;
    if (!this.state.approvedForGreet.length) return;
    if (this.state.currentGreetIndex !== 0 || this.state.greeted.length > 0) return;
    const settings = await this.tools.getSettings();
    // 进入 Phase B 时用 Settings.greetCap 覆盖默认值（newAgentState 硬编码为 10）。
    this.state.greetCap = Number(settings.greetCap) || 10;
    const { valid, rejected } = validateSelectedUrls(this.state.approvedForGreet, this.state.lastRankedJobs, settings);
    if (rejected.length) {
      this.state = bumpState({ ...this.state, approvedForGreet: valid, error: rejected.length ? `已拒绝未通过校验的 URL：${rejected.join("; ")}` : this.state.error }, nowIso());
    } else {
      this.state.approvedForGreet = valid;
    }
    this.persist();
  }

  private async openNextJobFromList(url: string): Promise<{ handled: boolean; pause: boolean }> {
    const job = this.state.lastRankedJobs.find(item => item.url === url);
    const listUrl = job?.listUrl || this.state.greetListUrl;
    if (!listUrl) {
      return await this.failCurrentJob(url, "找不到该岗位对应的 BOSS 列表页");
    }

    const current = this.tools.snapshot();
    // BOSS 选择岗位后可能只更新右侧详情/URL 参数，snapshot 仍是 jobs；
    // 只要当前仍是列表页，就留在原页面切换卡片，不要重新导航。
    if (current.kind !== "jobs") {
      this.state.currentGreetUrl = url;
      // 仍保持 pending：回到列表页后还要真正点击岗位卡片，不能让下一轮 LLM 误以为已经进入详情页。
      const targetUrl = listUrl.split("#")[0];
      this.state = bumpState({ ...this.state, error: "", lastDecision: `return_to_job_list: ${targetUrl}` }, nowIso());
      this.persist();
      await this.persistRecovery();
      if (!this.tools.navigateToUrl) {
        return await this.failCurrentJob(url, "当前无法返回岗位列表页");
      }
      await this.tools.navigateToUrl(targetUrl);
      await this.setStatus(true, "返回岗位列表，准备打开下一条岗位", "greeting");
      return { handled: true, pause: true };
    }

    if (!this.tools.openJobFromList) {
      return await this.failCurrentJob(url, "当前页面不支持从岗位列表打开岗位");
    }
    const targetJob = this.state.lastRankedJobs.find(item => item.url === url);
    if (!targetJob) {
      return await this.failCurrentJob(url, "批准岗位不在当前排序结果中");
    }

    this.state.currentGreetUrl = url;
    await logDecision(`GREET ${greetJobLabel(this.state, url)} | select_card:start | 等待列表卡片与右侧详情对应`);
    // 选择卡片和确认右侧详情期间仍保持 pending；只有确认出现“立即沟通”后才进入 opening。
    this.state.greetStatus = { ...this.state.greetStatus, [url]: "pending" };
    this.state = bumpState({ ...this.state, error: "", lastDecision: `select_job_card: ${url}` }, nowIso());
    this.persist();
    await this.persistRecovery();
    const opened = await this.tools.openJobFromList(targetJob);
    if (!opened.ok) {
      // 保留 pending，允许用户确认列表已加载后继续，不跳过批准岗位。
      this.state.greetStatus = { ...this.state.greetStatus, [url]: "pending" };
      this.state = bumpState({ ...this.state, step: "awaiting_input", error: opened.message, lastDecision: `click_job_from_list 失败：${opened.message}` }, nowIso());
      this.persist();
      await this.persistRecovery();
      await this.setStatus(true, `${opened.message}；请确认当前列表页包含该岗位后继续`, "awaiting_input");
      await logDecision(`GREET ${greetJobLabel(this.state, url)} | select_card:failed | ${opened.message}`);
      return { handled: true, pause: true };
    }
    this.state.greetStatus = { ...this.state.greetStatus, [url]: "opening" };
    this.state = bumpState({ ...this.state, error: "", lastDecision: `job_card_selected: ${url}` }, nowIso());
    this.persist();
    await this.persistRecovery();
    await this.setStatus(true, "已从岗位列表打开目标岗位，进入沟通", "greeting");
    await logDecision(`GREET ${greetJobLabel(this.state, url)} | select_card:verified | 右侧已出现立即沟通`);
    // 普通链接点击会销毁当前 content 上下文；若 BOSS 使用 SPA 路由，定时恢复也能继续流程。
    setTimeout(() => void this.resume(), 1200);
    return { handled: true, pause: true };
  }

  private async resolveSentGreet(url: string): Promise<{ handled: boolean; pause: boolean }> {
    if (this.state.greetStatus[url] !== "sent") return { handled: true, pause: false };
    await logDecision(`GREET ${greetJobLabel(this.state, url)} | confirm:start | 等待 BOSS 发送成功弹窗`);
    const confirmation = this.tools.confirmAndDismissGreet
      ? await this.tools.confirmAndDismissGreet()
      : { ok: false, message: "当前页面不支持确认 BOSS 发送结果" };

    // 另一个恢复循环可能已经完成了同一岗位；不要用较晚的失败结果覆盖 verified。
    if (this.state.greetStatus[url] !== "sent") return { handled: true, pause: false };
    if (!confirmation.ok) {
      const message = `${confirmation.message}，未确认打招呼成功，暂停当前岗位`;
      this.state.greetStatus = { ...this.state.greetStatus, [url]: "unknown" };
      this.state = bumpState({ ...this.state, step: "awaiting_input", error: message, lastDecision: "greet_confirmation_missing" }, nowIso());
      this.persist();
      await this.persistRecovery();
      await this.setStatus(true, message, "awaiting_input");
      await logDecision(`GREET ${greetJobLabel(this.state, url)} | confirm:failed | ${confirmation.message}`);
      return { handled: true, pause: true };
    }

    this.state.greetStatus = { ...this.state.greetStatus, [url]: "verified" };
    if (!hasGreetedJob(this.state, url)) this.state.greeted = [...this.state.greeted, url];
    this.state.currentGreetIndex += 1;
    this.state.currentGreetUrl = "";
    this.state = bumpState({
      ...this.state,
      error: "",
      lastDecision: `greet confirmation: ${url}；已确认发送`,
      lastActionHash: "",
      sameActionCount: 0,
      lastProgressSignature: ""
    }, nowIso());
    this.persist();
    await this.persistRecovery();
    await this.setStatus(true, "已确认 BOSS 发送招呼成功，返回列表继续下一岗位", "greeting");
    await logDecision(`GREET ${greetJobLabel(this.state, url)} | confirm:success | 已关闭成功弹窗，推进下一岗位`);
    await sleep(300);
    return { handled: true, pause: false };
  }

  /**
   * Phase B Runtime 编排：终态判定、岗位指针推进、自动打开下一岗位。
   * 返回 handled=true 表示本轮由 Runtime 处理（调用方应直接返回 pause）；handled=false 表示交给 LLM 单步。
   */
  private async runPhaseBRuntime(_settings: Settings): Promise<{ handled: boolean; pause: boolean }> {
    const approved = this.state.approvedForGreet;

    // 终态：达到 greetCap 或已遍历完批准列表 → finish。
    if (this.state.greeted.length >= this.state.greetCap || this.state.currentGreetIndex >= approved.length) {
      await this.finishGreet();
      return { handled: true, pause: true };
    }

    const url = approved[this.state.currentGreetIndex];
    if (!url) {
      await this.finishGreet();
      return { handled: true, pause: true };
    }
    const status = this.state.greetStatus[url] ?? "pending";

    // 双重判重防护：当前 url 已是终态（verified/failed）或已记入 greeted[]，
    // 直接推进指针，不落入 LLM 单步（避免对已打招呼的 URL 二次打招呼）。
    if (status === "verified" || status === "failed" || hasGreetedJob(this.state, url)) {
      this.state.currentGreetIndex += 1;
      this.state.currentGreetUrl = "";
      this.state = bumpState({ ...this.state, lastDecision: `skip already-greeted: ${url}（${status}）` }, nowIso());
      this.persist();
      await this.persistRecovery();
      return { handled: true, pause: false };
    }

    // 当前岗位尚未打开 → 先回到该岗位所在列表页，再点击岗位卡片。
    if (status === "pending") {
      return await this.openNextJobFromList(url);
    }

    // opening（已确认“立即沟通”）/message_filled → 交给 LLM 单步（fall through）。
    // verified/unknown/failed 为终态：verified/failed 应已在产生时推进 index；unknown 暂停等待人工。
    if (status === "unknown") {
      const message = `岗位 ${url} 打招呼结果不明确，等待人工裁决`;
      if (this.state.step !== "awaiting_input") {
        this.state = bumpState({ ...this.state, step: "awaiting_input", error: message, lastDecision: "unknown: 等待 RESOLVE_UNKNOWN_GREET" }, nowIso());
        this.persist();
        await this.persistRecovery();
        await this.setStatus(true, message, "awaiting_input");
      }
      return { handled: true, pause: true };
    }

    // sent 表示已经点击过“立即沟通”，只等待成功弹窗确认，禁止再次点击。
    if (status === "sent") return await this.resolveSentGreet(url);

    // opening 只允许在右侧“立即沟通”仍可见时交给 LLM。
    // 页面刷新、SPA 状态回退或旧版本状态恢复时，如果按钮不存在，重新走列表卡片选择。
    if (status === "opening") {
      const current = this.tools.snapshot();
      const greetReady = current.elements.some(element => /立即沟通/.test(element.text));
      if (!greetReady) {
        this.state.greetStatus = { ...this.state.greetStatus, [url]: "pending" };
        this.state = bumpState({ ...this.state, error: "", lastDecision: `opening_not_ready: ${url}；快照未发现立即沟通` }, nowIso());
        this.persist();
        await this.persistRecovery();
        return await this.openNextJobFromList(url);
      }
    }

    return { handled: false, pause: false };
  }

  /** 当前岗位标记失败、推进指针、自动进入下一岗（下一轮 Runtime 处理）。 */
  private async failCurrentJob(url: string, reason: string): Promise<{ handled: boolean; pause: boolean }> {
    this.state.greetStatus = { ...this.state.greetStatus, [url]: "failed" };
    this.state.currentGreetIndex += 1;
    this.state.currentGreetUrl = "";
    this.state = bumpState({ ...this.state, error: reason, lastDecision: `open_approved_job 失败：${reason}` }, nowIso());
    this.persist();
    await this.persistRecovery();
    await this.setStatus(false, `${reason}；跳过 ${url}`);
    await sleep(400);
    return { handled: true, pause: false };
  }

  /** Phase B 完成。区分“被拒绝（进入 greet 时批准列表为空）”与“正常完成”。 */
  private async finishGreet(): Promise<void> {
    const greeted = this.state.greeted.length;
    const total = this.state.approvedForGreet.length;
    // 拒绝路径：进入打招呼阶段时批准列表就是空（用户在审批清单点了“拒绝”）。
    // spec §6：拒绝=终止本次任务，不 greet；报“已拒绝”而非“完成 0/N”。
    if (total === 0) {
      const message = "已拒绝审批，未发送任何招呼";
      this.state = bumpState({ ...this.state, phase: "greet", step: "done", error: "", lastDecision: "finish: rejected, no greet", currentGreetUrl: "" }, nowIso());
      this.persist();
      await this.persistRecovery();
      await this.setStatus(true, message, "done");
      return;
    }
    const message = `打招呼阶段完成：已打招呼 ${greeted}/${Math.min(total, this.state.greetCap)}`;
    this.state = bumpState({ ...this.state, phase: "greet", step: "done", error: "", lastDecision: "finish: greet done", currentGreetUrl: "" }, nowIso());
    this.persist();
    await this.persistRecovery();
    await this.setStatus(true, message, "done");
  }

  private async requestApprovalWhenScreenReady(settings: Settings): Promise<boolean> {
    if (this.state.phase !== "screen"
      || !this.state.jobsCollected
      || !this.state.filterCompleted
      || !this.state.ranked
      || !this.candidates.length) return false;

    const snapshot = this.tools.snapshot();
    const intent = buildAgentIntent(settings, snapshot.currentQuery);
    const { satisfied, missing } = effectiveQuerySatisfied(intent.query, snapshot.currentQuery, snapshot);
    if (!satisfied) {
      this.state = bumpState({
        ...this.state,
        error: `筛选未完成：${missing.join("、")}`,
        lastDecision: "等待补齐 BOSS 查询条件后再申请打招呼审批"
      }, nowIso());
      this.persist();
      return false;
    }

    const listUrl = snapshot.kind === "jobs" ? snapshot.url.split("#")[0] : this.state.greetListUrl;
    const approval = await this.tools.requestApproval({
      action: "greet",
      title: "打招呼审批",
      description: `已排序 ${this.state.lastRankedJobs.length} 个岗位，是否开始打招呼？`,
      jobs: this.state.lastRankedJobs
    });
    void approval;
    this.state = bumpState({
      ...this.state,
      greetListUrl: listUrl,
      step: "awaiting_approval",
      error: "",
      lastDecision: "runtime: 岗位已收集、过滤和排序完成，申请打招呼审批"
    }, nowIso());
    this.persist();
    await this.persistRecovery();
    await this.setStatus(true, "已请求打招呼审批，等待人工确认", "awaiting_approval");
    return true;
  }

  /**
   * Phase B 状态机推进：根据刚执行的 LLM 动作派生 GreetEvent 并推进 greetStatus[currentGreetUrl]。
   * 派生规则：
   *   - fill 命中 chat 区 → "filled"（opening→message_filled）
   *   - click 命中 @chat-send（chat 区且文本匹配 发送/send）→ "send_clicked"（message_filled→sent），
   *     随即重快照跑 greetVerify：verify_clear→verified / verify_unclear→unknown / failed→failed
   * 终态处理：verified/failed→推进 index 自动下一岗；unknown→暂停等待 RESOLVE_UNKNOWN_GREET。
   * 返回 {pause} 表示已产生终态、调用方应据此返回；返回 null 表示非 greet 关键动作、继续默认节奏。
   */
  private async advanceGreetFsm(decision: AgentDecision, snapshotBefore: PageSnapshot): Promise<{ pause: boolean } | null> {
    const url = this.state.currentGreetUrl;
    if (!url) return null;
    const cur = this.state.greetStatus[url] ?? "pending";
    const refEl = decision.ref !== undefined ? snapshotBefore.elements.find(e => e.id === decision.ref) : undefined;

    let event: import("./greet").GreetEvent | null = null;
    if (decision.action === "fill" && refEl?.region === "chat") event = "filled";
    else if (decision.action === "click" && refEl?.region === "chat" && /发送|send/i.test(refEl.text)) event = "send_clicked";

    if (!event) return null; // 非关键动作（如点击“立即沟通”、滚动）不推进 FSM

    let next = nextGreetStatus(cur, event);
    this.state.greetStatus = { ...this.state.greetStatus, [url]: next };

    // send_clicked → 立即重快照验证
    if (event === "send_clicked" && next === "sent") {
      await sleep(500);
      const after = snapshotPage();
      this.currentSnapshot = after;
      const verify = greetVerify(after);
      next = nextGreetStatus("sent", verify === "verified" ? "verify_clear" : verify === "failed" ? "failed" : "verify_unclear");
      this.state.greetStatus = { ...this.state.greetStatus, [url]: next };
    }

    if (next === "verified") {
      if (!hasGreetedJob(this.state, url)) this.state.greeted = [...this.state.greeted, url];
      this.state.currentGreetIndex += 1;
      this.state.currentGreetUrl = "";
      this.state = bumpState({ ...this.state, error: "", lastDecision: `greet verified: ${url}；自动进入下一岗` }, nowIso());
      this.persist();
      await this.persistRecovery();
      await this.setStatus(true, `已打招呼：${url}，继续下一岗位`, "greeting");
      await sleep(300);
      return { pause: false }; // 下一轮 runPhaseBRuntime 自动打开下一岗
    }
    if (next === "failed") {
      this.state.currentGreetIndex += 1;
      this.state.currentGreetUrl = "";
      this.state = bumpState({ ...this.state, error: `岗位 ${url} 打招呼失败`, lastDecision: `greet failed: ${url}；跳过` }, nowIso());
      this.persist();
      await this.persistRecovery();
      await this.setStatus(false, `岗位 ${url} 打招呼失败，跳过`);
      await sleep(300);
      return { pause: false };
    }
    if (next === "unknown") {
      const message = `岗位 ${url} 打招呼结果不明确，等待人工裁决`;
      this.state = bumpState({ ...this.state, step: "awaiting_input", error: message, lastDecision: "unknown: 等待 RESOLVE_UNKNOWN_GREET" }, nowIso());
      this.persist();
      await this.persistRecovery();
      await this.setStatus(true, message, "awaiting_input");
      return { pause: true };
    }

    // opening/message_filled/sent（未到终态）→ 正常节奏，交下一轮 LLM。
    this.state = bumpState(this.state, nowIso());
    this.persist();
    await sleep(300);
    return null;
  }

  private async executeTurn(settings: Settings): Promise<{ pause: boolean }> {
    // Phase B（greet）由 Runtime 驱动岗位指针；LLM 只负责页内沟通微动作。
    if (this.state.phase === "greet") {
      const phaseB = await this.runPhaseBRuntime(settings);
      if (phaseB.handled) return { pause: phaseB.pause };
    }

    let snapshot = snapshotPage();
    // URL 跳转后 BOSS 需要异步 hydrate 筛选栏和岗位列表；首个快照为空时短暂重试，避免误判为“没有可操作元素”。
      if (this.state.phase === "screen" && this.state.appliedFilters.includes("url_filters_applied") && snapshot.elements.length === 0) {
      for (let attempt = 0; attempt < 6 && snapshot.elements.length === 0; attempt += 1) {
        await sleep(500);
        snapshot = snapshotPage();
      }
    }
    this.currentSnapshot = snapshot;
    const intent = buildAgentIntent(settings, snapshot.currentQuery);
    const payload = buildLlmPayload({
      state: this.state, intent, snapshot,
      currentQuery: snapshot.currentQuery, effectiveQuery: intent.query,
      greetContext: this.state.phase === "greet" ? { message: settings.greetMessage } : undefined
    });

    const planned = await this.tools.planAction(payload);
    let decision = planned.decision;
    const pageContext = snapshot.kind === "job_detail" ? "当前岗位详情页" : `页面cur: ${describeQuery(snapshot.currentQuery)}`;
    void logDecision(`T${this.state.phaseTurns} ${decision.action} ${decision.ref ?? ""}${decision.value ? `="${decision.value.slice(0, 15)}"` : ""} | ${decision.reason.slice(0, 50)} | ${pageContext}`);
    const ctx = {
      snapshot,
      phase: this.state.phase,
      greetMessage: settings.greetMessage,
      jobsCollected: this.state.jobsCollected,
      filterCompleted: this.state.filterCompleted,
      ranked: this.state.ranked
    };
    let validation = this.tools.validateDecision(decision, ctx);

    // Phase B 已由 Runtime 确认右侧存在“立即沟通”时，LLM 偶尔会返回一个
    // 旧/错误的筛选 ref。这里不执行该危险 ref，而是把意图收敛到当前快照
    // 中唯一合法的立即沟通控件；这是安全修正，不是放宽 Phase B 校验。
    if (!validation.ok
      && this.state.phase === "greet"
      && decision.action === "click"
      && decision.snapshotId === snapshot.snapshotId
      && this.state.currentGreetUrl
      && ["opening", "message_filled"].includes(this.state.greetStatus[this.state.currentGreetUrl] || "")) {
      const greetRef = findImmediateGreetRef(snapshot, this.tools.resolveRef, this.state.currentGreetUrl);
      if (greetRef && greetRef !== decision.ref) {
        const repaired = {
          ...decision,
          ref: greetRef,
          reason: `Runtime 将错误 ref ${decision.ref || "（空）"} 修正为当前岗位的立即沟通控件`
        };
        const repairedValidation = this.tools.validateDecision(repaired, ctx);
        if (repairedValidation.ok) {
          decision = repaired;
          validation = repairedValidation;
          await logDecision(`GREET ${greetJobLabel(this.state, this.state.currentGreetUrl)} | decision:repair | ${decision.ref} | 原 ref ${planned.decision.ref || "（空）"} 不属于沟通控件`);
        }
      }
    }

    if (!validation.ok) {
      // 校验失败也必须进入卡死检测；此前该分支直接 return，导致 LLM 可以
      // 无限返回同一个非法 ref，sameActionCount 永远不会达到阈值。
      const invalidHash = hashAction(decision);
      this.state = recordAction(this.state, invalidHash, actionProgressSignature(this.state, snapshot));
      const repeatedInvalid = this.state.sameActionCount >= 2;
      const message = repeatedInvalid
        ? `连续重复非法决策 ${this.state.sameActionCount + 1} 次，已暂停：${validation.reason}`
        : `决策校验失败：${validation.reason}`;
      this.state = bumpState({ ...this.state, step: repeatedInvalid ? "awaiting_input" : this.state.step, error: message, lastDecision: `${decision.action}: ${decision.reason}` }, nowIso());
      this.persist();
      if (this.state.phase === "greet" && this.state.currentGreetUrl) {
        await logDecision(`GREET ${greetJobLabel(this.state, this.state.currentGreetUrl)} | decision:rejected | ${message}`);
      }
      await this.setStatus(false, message, repeatedInvalid ? "awaiting_input" : undefined);
      return { pause: repeatedInvalid };
    }

    // 卡死检测：统一由 guardrails.recordAction 记录；命中阈值后在下一轮 run() 开头由 shouldBreak 判定。
    const sig = actionProgressSignature(this.state, snapshot);
    const h = hashAction(decision);
    this.state = recordAction(this.state, h, sig);

    // 累计 cost 进 state（供下一轮 payload 使用）
    this.state.tokensUsed += planned.usage.tokensIn + planned.usage.tokensOut;
    this.state.costYuan = planned.usage.cumulativeYuan;

    if (decision.action === "pause") {
      this.state = bumpState({ ...this.state, step: "awaiting_input", error: decision.reason, lastDecision: `pause: ${decision.reason}` }, nowIso());
      this.persist();
      await this.setStatus(true, decision.reason, "awaiting_input");
      return { pause: true };
    }

    if (decision.action === "request_greet_approval") {
      // 前置三件套（jobsCollected && filterCompleted && ranked）已由 validateDecision 校验通过。
      // 完成校验：effectiveQuery 是否已在页面落实（或无对应控件）。
      const { satisfied, missing } = effectiveQuerySatisfied(intent.query, snapshot.currentQuery, snapshot);
      if (!satisfied) {
        const message = `筛选未完成：${missing.join("、")}`;
        this.state = bumpState({ ...this.state, error: message, lastDecision: `request_greet_approval: ${decision.reason}` }, nowIso());
        this.persist();
        await this.setStatus(false, message);
        await sleep(400);
        return { pause: false };
      }
      const listUrl = snapshot.kind === "jobs" ? snapshot.url.split("#")[0] : this.state.greetListUrl;
      this.state = bumpState({
        ...this.state,
        greetListUrl: listUrl,
        error: "",
        lastDecision: `request_greet_approval: ${decision.reason}`
      }, nowIso());
      this.persist();
      // 满足 → 请求人工审批打招呼，进入等待。
      const approval = await this.tools.requestApproval({
        action: "greet",
        title: "打招呼审批",
        description: `已排序 ${this.state.lastRankedJobs.length} 个岗位，是否开始打招呼？`,
        jobs: this.state.lastRankedJobs
      });
      void approval;
      this.state = bumpState({ ...this.state, step: "awaiting_approval", lastDecision: `request_greet_approval: ${decision.reason}` }, nowIso());
      this.persist();
      await this.persistRecovery();
      await this.setStatus(true, "已请求打招呼审批，等待人工确认", "awaiting_approval");
      return { pause: true };
    }

    let result: AgentActionResult;
    let pageMayChange = false;
    // Phase B 的 fill 一律用 forceGreetMessage（executeBrowserAction 会用 settings.greetMessage 覆盖 value）。
    const forceGreetMessage = this.state.phase === "greet";
    switch (decision.action) {
      case "click":
      case "fill":
      case "scroll":
        result = await this.tools.executeBrowserAction(decision, { phase: this.state.phase, greetMessage: settings.greetMessage, forceGreetMessage });
        pageMayChange = Boolean(result.pageMayChange);
        break;
      case "next_page": {
        result = await this.tools.executeBrowserAction(decision, { phase: this.state.phase, greetMessage: settings.greetMessage, forceGreetMessage: false });
        pageMayChange = Boolean(result.pageMayChange);
        this.state.pagesVisited += 1;
        const sigAfter = `${location.href}|${document.querySelector<HTMLAnchorElement>("a[href*='/job_detail/'], a[href*='/job/']")?.href || ""}`;
        if (!this.state.visitedPageSignatures.includes(sigAfter)) this.state.visitedPageSignatures.push(sigAfter);
        break;
      }
      case "open_jobs": {
        const link = await this.tools.findJobsEntry();
        if (!link) {
          result = { ok: false, message: "没有找到职位列表入口" };
        } else {
          await this.tools.navigate(link);
          result = { ok: true, message: "正在进入职位列表页" };
          pageMayChange = true;
        }
        break;
      }
      case "collect_jobs": {
        if (!this.tools.hasJobCards()) {
          result = { ok: false, message: "当前页面没有可读取的岗位卡片" };
        } else {
          const visible = await this.tools.extractJobs();
          // 合并候选池（去重 by url），不在此处翻页——翻页由 next_page 驱动。
          const merged = new Map<string, Job>(this.candidates.map(j => [j.url, j]));
          for (const j of visible) merged.set(j.url, j);
          this.candidates = [...merged.values()];
          this.state.candidateCount = this.candidates.length;
          this.state.jobsCollected = true;
          this.persistCandidates();
          result = { ok: true, message: `已收集 ${visible.length} 个岗位，累计 ${this.candidates.length}` };
        }
        break;
      }
      case "filter_jobs": {
        if (!this.candidates.length) {
          result = { ok: false, message: "还没有岗位候选，无法过滤" };
        } else {
          this.candidates = await this.tools.filterJobs(this.candidates);
          this.state.filteredCount = this.candidates.length;
          this.state.filterCompleted = true;
          this.persistCandidates();
          result = { ok: true, message: `过滤后剩余 ${this.candidates.length} 个岗位` };
        }
        break;
      }
      case "rank_jobs": {
        if (!this.candidates.length) {
          result = { ok: false, message: "当前 BOSS 查询条件下没有可供排序的岗位，请调整 BOSS 查询条件后重试" };
        } else {
          this.candidates = await this.tools.rankJobs(this.candidates);
          this.state.ranked = true;
          this.state.lastRankedJobs = this.candidates;
          this.persistCandidates();
          this.persist();
          await this.tools.saveJobs(this.candidates);
          // 排序成功后立即进入审批，避免下一轮 LLM 再次选择 rank_jobs。
          if (await this.requestApprovalWhenScreenReady(settings)) return { pause: true };
          result = { ok: true, message: `已完成 ${this.candidates.length} 个岗位的匹配排序` };
        }
        break;
      }
      default:
        // AgentDecision.action 仅含 LlmAction；RuntimeAction（open_approved_job/finish）由 runPhaseBRuntime 接管，不会走到这里。
        result = { ok: false, message: `未知动作：${decision.action}` };
        break;
    }

    if (!result.ok) {
      const message = result.message;
      if (this.state.phase === "greet" && this.state.currentGreetUrl) {
        await logDecision(`GREET ${greetJobLabel(this.state, this.state.currentGreetUrl)} | click:failed | ${message}`);
      }
      this.state = bumpState({ ...this.state, error: message, lastDecision: `${decision.action}: ${decision.reason}` }, nowIso());
      this.persist();
      await this.setStatus(false, `${message}；Agent 将重新观察并调整动作`);
      await sleep(800);
      return { pause: false };
    }

    // BOSS 的“立即沟通”是当前岗位的发送动作，但最终状态仍以成功弹窗为准。
    // 执行层返回 greetStatus=sent，避免依赖可能已经变化的旧快照 ref 文本。
    const clickedOpenChat = this.state.phase === "greet"
      && decision.action === "click"
      && result.greetStatus === "sent";
    if (clickedOpenChat) {
      await sleep(350);
      const afterClick = snapshotPage();
      this.currentSnapshot = afterClick;
      const url = this.state.currentGreetUrl;
      if (url) {
        // 先落盘 sent，再等待弹窗确认，防止并发恢复或下一轮再次点击同一个按钮。
        this.state.greetStatus = { ...this.state.greetStatus, [url]: "sent" };
        this.state = bumpState({ ...this.state, error: "", lastDecision: `greet click: ${url}；等待发送确认` }, nowIso());
        this.persist();
        await this.persistRecovery();
        await logDecision(`GREET ${greetJobLabel(this.state, url)} | click:sent | 已点击立即沟通，禁止重复点击，等待弹窗确认`);
        return await this.resolveSentGreet(url);
      }
    }

    // Phase B FSM：根据刚执行的动作 + 快照推 event，推进 greetStatus。
    if (this.state.phase === "greet") {
      const advanced = await this.advanceGreetFsm(decision, snapshot);
      if (advanced) return { pause: advanced.pause };
    }

    this.state = bumpState({
      ...this.state,
      error: "",
      phaseTurns: this.state.phaseTurns + 1,
      lastDecision: `${decision.action}: ${decision.reason}`
    }, nowIso());
    this.persist();
    await this.setStatus(true, result.message);

    if (pageMayChange) {
      setTimeout(() => void this.resume(), 1200);
      return { pause: true };
    }
    await sleep(400);
    return { pause: false };
  }

  private async run(): Promise<void> {
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      try {
        const settings = await this.tools.getSettings();

        // 停止按钮：每轮开头、执行任何动作前检查 chrome.storage.local.stopRequested。
        const { stopRequested } = await chrome.storage.local.get({ stopRequested: false });
        if (stopRequested) {
          await chrome.storage.local.remove("stopRequested");
          const message = "用户已请求停止 Agent";
          this.state = bumpState({ ...this.state, step: "awaiting_input", error: message, lastDecision: "stop_requested" }, nowIso());
          this.persist();
          await this.setStatus(true, message, "awaiting_input");
          return;
        }

        // 护栏：费用熔断 / 轮数上限 / 卡死 / greetCap。费用由上一轮 planAction 写入 state.costYuan，此处生效。
        const brk = shouldBreak(this.state, settings);
        if (brk) {
          this.state = bumpState({ ...this.state, step: "awaiting_input", error: brk.reason, lastDecision: `guardrail: ${brk.reason}` }, nowIso());
          this.persist();
          await this.setStatus(true, brk.reason, "awaiting_input");
          return;
        }

        // URL 优先应用岗位筛选条件：BOSS 下拉依赖真实 hover，DOM click 不可靠时由 URL 直接进入筛选结果。
        // 只在本轮筛选阶段执行一次；跳转后的新 content script 会从 sessionStorage 恢复并继续采集岗位。
        if (this.state.phase === "screen" && !this.state.appliedFilters.includes("url_filters_applied") && this.tools.applyUrlFilters) {
          const urlResult = await this.tools.applyUrlFilters();
          if (!urlResult.ok) {
            this.state = bumpState({ ...this.state, error: urlResult.message, lastDecision: `url_filters failed: ${urlResult.message}` }, nowIso());
            this.persist();
            await this.setStatus(false, urlResult.message, "failed");
            return;
          }
          this.state.appliedFilters = [...this.state.appliedFilters, "url_filters_applied"];
          this.state = bumpState({ ...this.state, step: "apply_filters", error: "", lastDecision: `url_filters: ${urlResult.message}` }, nowIso());
          this.persist();
          await this.setStatus(true, urlResult.message, "apply_filters");
          if (urlResult.pageMayChange) {
            setTimeout(() => void this.resume(), 1200);
            return;
          }
        }

        // 排序完成后由 Runtime 直接进入审批，避免 LLM 在 ranked=true 时反复选择 rank_jobs。
        if (await this.requestApprovalWhenScreenReady(settings)) return;

        const { pause } = await this.executeTurn(settings);
        if (pause) return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || "Agent 执行失败");
        this.state = bumpState({ ...this.state, step: "failed", error: message }, nowIso());
        this.persist();
        await this.setStatus(false, message, "failed");
        return;
      }
    }
    const message = `Agent 已达到本轮最大观察次数（${MAX_TURNS}），已暂停以避免重复操作`;
    this.state = bumpState({ ...this.state, step: "awaiting_input", error: message }, nowIso());
    this.persist();
    await this.setStatus(true, message, "awaiting_input");
  }
}
