import { buildAgentIntent } from "./intent";
import type { AgentAction, AgentContext, AgentDecision, AgentState, AgentStep, AgentTools, BootstrapStatus, Job } from "../types";
import { AgentTaskQueue } from "./task-queue";

const STORAGE_KEY = "boss-agent-state";
const CANDIDATES_KEY = "boss-agent-candidates";
const TERMINAL_STEPS: AgentStep[] = ["done", "failed"];
const MAX_TURNS = 40;

const ACTION_STEP: Partial<Record<AgentAction, AgentStep>> = {
  click: "apply_filters",
  fill: "apply_filters",
  select: "apply_filters",
  scroll: "extract_jobs",
  next_page: "extract_jobs",
  open_profile: "find_profile",
  import_profile: "analyze_profile",
  open_jobs: "find_jobs",
  apply_filters: "apply_filters",
  collect_jobs: "extract_jobs",
  filter_jobs: "filter_jobs",
  rank_jobs: "rank_jobs",
  finish: "done",
  pause: "awaiting_input"
};

const nextState = (state: AgentState, step: AgentStep, error = ""): AgentState => ({
  ...state,
  step,
  error,
  updatedAt: new Date().toISOString()
});

export class AgentRunner {
  private state: AgentState;
  private queue: AgentTaskQueue;
  private running = false;
  private candidates: Job[];

  constructor(
    private readonly storage: Storage,
    private readonly tools: AgentTools,
    private readonly sourceTabId: number | null
  ) {
    this.state = this.readState() || this.newState();
    this.queue = new AgentTaskQueue(this.state.queue);
    this.candidates = this.readCandidates();
  }

  private newState(): AgentState {
    const now = new Date().toISOString();
    return {
      runId: crypto.randomUUID(),
      step: "idle",
      sourceTabId: this.sourceTabId,
      retryCount: 0,
      startedAt: now,
      updatedAt: now,
      error: "",
      queue: new AgentTaskQueue().snapshot(),
      currentTaskId: null,
      goal: "screen_jobs",
      appliedFilters: [],
      lastDecision: "",
      candidateCount: 0,
      filteredCount: 0,
      jobsCollected: false,
      filterCompleted: false,
      ranked: false
    };
  }

  private readState(): AgentState | null {
    try {
      const value = JSON.parse(this.storage.getItem(STORAGE_KEY) || "null") as Partial<AgentState> | null;
      if (!value?.runId || !value.step) return null;
      return { ...this.newState(), ...value, queue: value.queue?.length ? value.queue : new AgentTaskQueue().snapshot() };
    } catch {
      return null;
    }
  }

  private persist(): void {
    this.state.queue = this.queue.snapshot();
    this.storage.setItem(STORAGE_KEY, JSON.stringify(this.state));
  }

  private readCandidates(): Job[] {
    try {
      const value = JSON.parse(this.storage.getItem(CANDIDATES_KEY) || "[]");
      return Array.isArray(value) ? value as Job[] : [];
    } catch {
      return [];
    }
  }

  private persistCandidates(): void {
    this.storage.setItem(CANDIDATES_KEY, JSON.stringify(this.candidates));
  }

  private async transition(step: AgentStep, message: string, ok = true): Promise<void> {
    this.state = nextState(this.state, step, ok ? "" : message);
    const task = this.queue.activate(step);
    this.state.currentTaskId = task?.id || null;
    this.persist();
    await this.tools.setStatus({ ok, message, step, runId: this.state.runId, state: this.state, tool: step });
  }

  async start(restart = false): Promise<{ ok: boolean; pending: boolean; message: string }> {
    if (this.running) return { ok: true, pending: true, message: "Agent 已在执行中" };
    if (restart || this.state.step === "done" || this.state.step === "failed") {
      this.state = this.newState();
      this.queue = new AgentTaskQueue(this.state.queue);
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
    this.state = this.newState();
    this.queue = new AgentTaskQueue(this.state.queue);
    this.candidates = [];
    this.persist();
    this.persistCandidates();
  }

  async resume(): Promise<void> {
    if (!this.state || TERMINAL_STEPS.includes(this.state.step) || this.running) return;
    this.running = true;
    try {
      await this.run();
    } finally {
      this.running = false;
    }
  }

  private async executeDecision(decision: AgentDecision): Promise<{ ok: boolean; message: string; pageMayChange?: boolean }> {
    switch (decision.action) {
      case "click":
      case "fill":
      case "select":
      case "scroll":
      case "next_page":
      case "open_jobs":
      case "apply_filters":
        return await this.tools.executeBrowserAction(decision);
      case "open_profile": {
        const link = await this.tools.findProfileEntry();
        if (!link) return { ok: false, message: "没有找到简历入口" };
        await this.tools.navigate(link);
        return { ok: true, message: "正在进入简历页", pageMayChange: true };
      }
      case "import_profile": {
        const result = await this.tools.importProfile();
        return { ok: result.ok, message: result.ok ? "简历信息已读取" : result.reason || "简历读取失败" };
      }
      case "collect_jobs": {
        if (!this.tools.hasJobCards()) return { ok: false, message: "当前页面没有可读取的岗位卡片" };
        this.candidates = await this.tools.extractJobs();
        this.state.candidateCount = this.candidates.length;
        this.state.jobsCollected = true;
        this.persistCandidates();
        return { ok: true, message: `已收集 ${this.candidates.length} 个岗位` };
      }
      case "filter_jobs": {
        if (!this.candidates.length) return { ok: false, message: "还没有岗位候选，无法执行岗位过滤" };
        this.candidates = await this.tools.filterJobs(this.candidates);
        this.state.filteredCount = this.candidates.length;
        this.state.filterCompleted = true;
        this.persistCandidates();
        return { ok: true, message: `过滤后剩余 ${this.candidates.length} 个岗位` };
      }
      case "rank_jobs": {
        if (!this.candidates.length) return { ok: false, message: "没有符合条件的岗位可供排序" };
        this.candidates = await this.tools.rankJobs(this.candidates);
        this.state.ranked = true;
        this.persistCandidates();
        await this.tools.saveJobs(this.candidates);
        return { ok: true, message: `已完成 ${this.candidates.length} 个岗位的匹配排序` };
      }
      case "finish":
        await this.tools.saveJobs(this.candidates);
        return { ok: true, message: `Agent 已完成目标，共 ${this.candidates.length} 个岗位` };
      case "pause":
        return { ok: true, message: decision.reason };
    }
  }

  private async run(): Promise<void> {
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      try {
        const settings = await this.tools.getSettings();
        const observation = this.tools.observePage();
        const currentQuery = this.tools.readQueryContext();
        const intent = buildAgentIntent(settings, currentQuery);
        const context: AgentContext = {
          goal: this.state.goal || "screen_jobs",
          intent,
          settings,
          currentQuery,
          profileReady: Boolean(settings.candidateProfileClean),
          candidatesCount: this.state.candidateCount || this.candidates.length,
          filteredCount: this.state.filteredCount,
          ranked: this.state.ranked,
          observation,
          state: this.state
        };
        await this.transition("thinking", "Agent 正在观察页面并请求 LLM 决策…");
        const decision = await this.tools.planAction(context);
        this.state.lastDecision = `${decision.action}: ${decision.reason}`;
        this.persist();

        if (decision.action === "pause") {
          await this.transition("awaiting_input", decision.reason);
          return;
        }
        const step = ACTION_STEP[decision.action] || "idle";
        await this.transition(step, `Agent 决定：${decision.reason}`);
        const result = await this.executeDecision(decision);
        if (!result.ok) {
          this.state.error = result.message;
          this.persist();
          await this.tools.setStatus({ ok: false, message: `${result.message}；Agent 将重新观察并调整动作`, step, runId: this.state.runId, state: this.state });
          await new Promise(resolve => setTimeout(resolve, 900));
          continue;
        }
        if (!result.pageMayChange) {
          const verification = await this.tools.verifyAction(decision, observation);
          if (!verification.ok) {
            this.state.error = verification.message;
            this.persist();
            await this.tools.setStatus({ ok: false, message: `${verification.message}；Agent 将重新规划`, step, runId: this.state.runId, state: this.state });
            await new Promise(resolve => setTimeout(resolve, 700));
            continue;
          }
          await this.transition("acting", verification.message);
        }
        this.state.error = "";
        this.persist();
        if (decision.action === "finish") {
          await this.transition("done", result.message);
          return;
        }
        await this.tools.setStatus({ ok: true, message: result.message, step, runId: this.state.runId, state: this.state, tool: decision.action });
        if (result.pageMayChange) {
          setTimeout(() => void this.resume(), 1500);
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 450));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || "Agent 执行失败");
        this.state = nextState(this.state, "failed", message);
        this.persist();
        await this.tools.setStatus({ ok: false, message, step: "failed", runId: this.state.runId, state: this.state });
        return;
      }
    }
    const message = `Agent 已达到本轮最大观察次数（${MAX_TURNS}），已暂停以避免重复操作`;
    this.state = nextState(this.state, "awaiting_input", message);
    this.persist();
    await this.tools.setStatus({ ok: true, message, step: "awaiting_input", runId: this.state.runId, state: this.state });
  }
}
