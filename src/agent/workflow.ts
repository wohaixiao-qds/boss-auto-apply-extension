import { buildAgentIntent } from "./intent";
import { newAgentState, bumpState } from "./state";
import { snapshotPage } from "./snapshot";
import { validateDecision, effectiveQuerySatisfied } from "./validate";
import { executeBrowserAction } from "./browser-action";
import { buildLlmPayload } from "./payload";
import { mergeRecovery } from "./recovery";
import type { AgentActionResult, AgentDecision, AgentState, AgentStep, AgentTools, Job, PageSnapshot, Settings } from "../types";

const STORAGE_KEY = "boss-agent-state";
const CANDIDATES_KEY = "boss-agent-candidates";
const TERMINAL_STEPS: AgentStep[] = ["done", "failed"];
const MAX_TURNS = 50;

const nowIso = (): string => new Date().toISOString();
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function hashAction(d: AgentDecision): string {
  return `${d.action}|${d.ref ?? ""}|${d.value ?? ""}|${d.direction ?? ""}|${d.amount ?? ""}`;
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
        currentGreetIndex: this.state.currentGreetIndex
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
    }
    this.running = true;
    try {
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
    // 从 chrome.storage.local 镜像合并恢复数据（审批通过后由 background 写入）。
    await this.loadRecovery();
    this.running = true;
    try {
      await this.run();
    } finally {
      this.running = false;
    }
  }

  private async executeTurn(settings: Settings): Promise<{ pause: boolean }> {
    const snapshot = snapshotPage();
    this.currentSnapshot = snapshot;
    const intent = buildAgentIntent(settings, snapshot.currentQuery);
    const payload = buildLlmPayload({
      state: this.state, intent, snapshot,
      currentQuery: snapshot.currentQuery, effectiveQuery: intent.query,
      greetContext: this.state.phase === "greet" ? { message: settings.greetMessage } : undefined
    });

    const planned = await this.tools.planAction(payload);
    const decision = planned.decision;
    const ctx = {
      snapshot,
      phase: this.state.phase,
      greetMessage: settings.greetMessage,
      jobsCollected: this.state.jobsCollected,
      filterCompleted: this.state.filterCompleted,
      ranked: this.state.ranked
    };
    const validation = this.tools.validateDecision(decision, ctx);
    if (!validation.ok) {
      const message = `决策校验失败：${validation.reason}`;
      this.state = bumpState({ ...this.state, error: message, lastDecision: `${decision.action}: ${decision.reason}` }, nowIso());
      this.persist();
      await this.setStatus(false, message);
      return { pause: false };
    }

    // 卡死检测
    const sig = snapshot.summary;
    const h = hashAction(decision);
    if (h === this.state.lastActionHash && sig === this.state.lastProgressSignature) {
      this.state.sameActionCount += 1;
    } else {
      this.state.sameActionCount = 0;
    }
    this.state.lastActionHash = h;
    this.state.lastProgressSignature = sig;
    if (this.state.sameActionCount >= 3) {
      const message = "Agent 检测到重复动作且页面无进展，已暂停";
      this.state = bumpState({ ...this.state, step: "awaiting_input", error: message, lastDecision: `${decision.action}: ${decision.reason}` }, nowIso());
      this.persist();
      await this.setStatus(true, message, "awaiting_input");
      return { pause: true };
    }

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
    switch (decision.action) {
      case "click":
      case "fill":
      case "scroll":
        result = await this.tools.executeBrowserAction(decision, { phase: this.state.phase, greetMessage: settings.greetMessage, forceGreetMessage: false });
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
          result = { ok: false, message: "没有岗位可供排序" };
        } else {
          this.candidates = await this.tools.rankJobs(this.candidates);
          this.state.ranked = true;
          this.state.lastRankedJobs = this.candidates;
          this.persistCandidates();
          await this.tools.saveJobs(this.candidates);
          result = { ok: true, message: `已完成 ${this.candidates.length} 个岗位的匹配排序` };
        }
        break;
      }
      default:
        // Runtime actions (open_approved_job/finish) — 由 Task 7-9 接管；本任务直接暂停。
        this.state = bumpState({ ...this.state, step: "awaiting_input", lastDecision: `${decision.action}: runtime 未接入` }, nowIso());
        this.persist();
        await this.setStatus(true, `${decision.action} 暂未接入，已暂停`, "awaiting_input");
        return { pause: true };
    }

    if (!result.ok) {
      const message = result.message;
      this.state = bumpState({ ...this.state, error: message, lastDecision: `${decision.action}: ${decision.reason}` }, nowIso());
      this.persist();
      await this.setStatus(false, `${message}；Agent 将重新观察并调整动作`);
      await sleep(800);
      return { pause: false };
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
