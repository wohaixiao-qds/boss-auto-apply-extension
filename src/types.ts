export type AgentStep =
  | "idle" | "find_jobs" | "apply_filters" | "extract_jobs"
  | "filter_jobs" | "rank_jobs" | "awaiting_approval"
  | "greeting" | "awaiting_input" | "done" | "failed";

export type AgentGoal = "greet_matching";

export type LlmAction =
  | "click" | "fill" | "scroll" | "next_page" | "open_jobs"
  | "collect_jobs" | "filter_jobs" | "rank_jobs"
  | "request_greet_approval" | "pause";
export type RuntimeAction = "open_approved_job" | "finish";
export type AgentAction = LlmAction | RuntimeAction;

export type SnapshotRegion = "search" | "filter" | "pager" | "job" | "chat" | "other";

export interface SnapshotElement {
  id: string;
  role: "btn" | "link" | "input" | "option" | "menuitem" | "tab" | "text" | "select";
  text: string;
  hint?: string;
  current?: string;
  checked?: boolean;
  region: SnapshotRegion;
}

export interface PageSnapshot {
  snapshotId: string;
  kind: "jobs" | "job_detail" | "login" | "unknown";
  url: string;
  path: string;
  currentQuery: BossQueryContext;
  summary: string;
  elements: SnapshotElement[];
}

export interface AgentDecision {
  snapshotId: string;
  action: LlmAction;
  ref?: string;
  value?: string;
  direction?: "up" | "down";
  amount?: number;
  reason: string;
  expected: string;
  confidence?: number;
  target?: string;
}

export type GreetStatus =
  | "pending" | "opening" | "message_filled" | "sent"
  | "verified" | "unknown" | "failed";

export interface GreetContext { message: string; }

export type AgentPhase = "screen" | "greet";

export interface AgentState {
  runId: string;
  stateVersion: number;
  updatedAt: string;
  phase: AgentPhase;
  step: AgentStep;
  phaseTurns: number;
  retryCount: number;
  startedAt: string;
  error: string;
  goal: AgentGoal;
  appliedFilters: string[];
  lastDecision: string;
  candidateCount: number;
  filteredCount: number;
  jobsCollected: boolean;
  filterCompleted: boolean;
  ranked: boolean;
  pagesVisited: number;
  visitedPageSignatures: string[];
  currentGreetIndex: number;
  currentGreetUrl: string;
  approvedForGreet: string[];
  greeted: string[];
  greetCap: number;
  greetStatus: Record<string, GreetStatus>;
  lastRankedJobs: Job[];
  tokensUsed: number;
  costYuan: number;
  lastActionHash: string;
  sameActionCount: number;
  lastProgressSignature: string;
  sourceTabId: number | null;
}

export interface JobIntent {
  targetTitles: string[]; skills: string[]; locations: string[];
  salary: string; workModes: string[]; summary: string;
}

export interface Settings {
  jobKeywords: string; excludeCompanies: string;
  targetLocations: string; targetSalary: string;
  workMode: string; jobTypes: string;
  workExperience: string; education: string;
  companyIndustries: string; companySizes: string;
  maxPages: string; minMatchScore: string;
  candidateProfileClean: string;
  jobIntent: JobIntent;
  profileSyncedAt: string;
  aiEnabled: boolean; agentAutoStart: boolean;
  aiBaseUrl: string; aiModel: string; aiApiKey: string;
  // v5 新增
  costThresholdYuan: string;
  inputPriceYuanPerMillion: string;
  outputPriceYuanPerMillion: string;
  greetCap: string;
  greetMessage: string;
}

export interface BossQueryContext {
  keyword: string;
  location: string[]; salary: string[]; jobTypes: string[];
  workModes: string[]; experience: string[]; education: string[];
  industries: string[]; companySizes: string[];
  source: "recommend" | "search" | "unknown";
}

export interface EffectiveQuery extends BossQueryContext {
  changed: string[]; preserved: string[];
}

export interface AgentIntent {
  objective: AgentGoal;
  query: EffectiveQuery;
  excludeCompanies: string[];
  minMatchScore: number;
  summary: string;
  defined: boolean;
  source: "user" | "page";
}

export interface Job {
  title: string; company: string; salary: string; location: string;
  description: string; url: string; score: number;
  matchedKeywords: string[]; reason?: string;
}

export interface ApprovalRequest {
  id: string; action: string; title: string; description: string;
  createdAt: string; status: "pending" | "approved" | "rejected";
  jobs?: Job[];
}

export interface AgentActionResult {
  ok: boolean;
  message: string;
  pageMayChange?: boolean;
  partial?: boolean;
  greetStatus?: GreetStatus;
}

export interface BootstrapStatus {
  ok: boolean; message: string;
  step?: AgentStep; runId?: string;
  state?: AgentState; tool?: string;
  approval?: ApprovalRequest;
}

export interface AgentTools {
  getSettings(): Promise<Settings>;
  snapshot(): PageSnapshot;
  resolveRef(ref: string): HTMLElement | null;
  planAction(payload: Record<string, unknown>): Promise<{ decision: AgentDecision; usage: { tokensIn: number; tokensOut: number; cumulativeYuan: number; estimated: boolean } }>;
  validateDecision(d: AgentDecision, ctx: import("./agent/validate").ValidationContext): { ok: boolean; reason: string };
  executeBrowserAction(d: AgentDecision, ctx: { phase: AgentPhase; greetMessage: string; forceGreetMessage: boolean }): Promise<AgentActionResult>;
  runRuntimeAction(action: RuntimeAction): Promise<AgentActionResult>;
  isJobListPage(): boolean;
  hasJobCards(): boolean;
  findJobsEntry(): Promise<HTMLElement | null>;
  navigate(element: HTMLElement): Promise<void>;
  extractJobs(): Promise<Job[]>;
  filterJobs(jobs: Job[]): Promise<Job[]>;
  rankJobs(jobs: Job[]): Promise<Job[]>;
  saveJobs(jobs: Job[]): Promise<void>;
  setStatus(status: BootstrapStatus): Promise<void>;
  requestApproval(request: Omit<ApprovalRequest, "id" | "createdAt" | "status">): Promise<ApprovalRequest>;
}
