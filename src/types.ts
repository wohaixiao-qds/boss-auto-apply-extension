export type AgentStep =
  | "idle"
  | "thinking"
  | "acting"
  | "find_profile"
  | "read_profile"
  | "analyze_profile"
  | "find_jobs"
  | "apply_filters"
  | "extract_jobs"
  | "filter_jobs"
  | "rank_jobs"
  | "awaiting_input"
  | "awaiting_approval"
  | "done"
  | "failed";

export interface JobIntent {
  targetTitles: string[];
  skills: string[];
  locations: string[];
  salary: string;
  workModes: string[];
  summary: string;
}

export interface Settings {
  jobKeywords: string;
  excludeCompanies: string;
  targetLocations: string;
  targetSalary: string;
  workMode: string;
  jobTypes: string;
  workExperience: string;
  education: string;
  companyIndustries: string;
  companySizes: string;
  maxPages: string;
  minMatchScore: string;
  candidateProfileClean: string;
  jobIntent: JobIntent;
  profileSyncedAt: string;
  aiEnabled: boolean;
  agentAutoStart: boolean;
  aiBaseUrl: string;
  aiModel: string;
  aiApiKey: string;
}

export interface BossQueryContext {
  keyword: string;
  location: string[];
  salary: string[];
  jobTypes: string[];
  workModes: string[];
  experience: string[];
  education: string[];
  industries: string[];
  companySizes: string[];
  source: "recommend" | "search" | "unknown";
}

export interface EffectiveQuery extends BossQueryContext {
  changed: string[];
  preserved: string[];
}

export interface AgentIntent {
  objective: AgentGoal;
  query: EffectiveQuery;
  excludeCompanies: string[];
  minMatchScore: number;
  summary: string;
  defined: boolean;
  source: "user" | "profile" | "mixed" | "page";
}

export interface QueryApplyResult {
  applied: string[];
  skipped: string[];
  verified: boolean;
  effective: EffectiveQuery;
}

export interface Job {
  title: string;
  company: string;
  salary: string;
  location: string;
  description: string;
  url: string;
  score: number;
  matchedKeywords: string[];
  reason?: string;
}

export interface AgentState {
  runId: string;
  step: AgentStep;
  sourceTabId: number | null;
  retryCount: number;
  startedAt: string;
  updatedAt: string;
  error: string;
  queue: AgentTask[];
  currentTaskId: string | null;
  goal: AgentGoal;
  appliedFilters: string[];
  lastDecision: string;
  candidateCount: number;
  filteredCount: number;
  jobsCollected: boolean;
  filterCompleted: boolean;
  ranked: boolean;
}

export type AgentGoal = "screen_jobs";

export type PageKind = "profile" | "jobs" | "job_detail" | "login" | "unknown";

export interface PageObservation {
  url: string;
  path: string;
  kind: PageKind;
  hasProfileContent: boolean;
  hasJobCards: boolean;
  hasSearchInput: boolean;
  visibleActions: string[];
  loginRequired: boolean;
}

export interface AgentContext {
  goal: AgentGoal;
  intent: AgentIntent;
  settings: Settings;
  currentQuery: BossQueryContext;
  profileReady: boolean;
  candidatesCount: number;
  filteredCount: number;
  ranked: boolean;
  observation: PageObservation;
  state: AgentState;
}

export type AgentAction =
  | "click"
  | "fill"
  | "select"
  | "scroll"
  | "next_page"
  | "open_profile"
  | "import_profile"
  | "open_jobs"
  | "apply_filters"
  | "collect_jobs"
  | "filter_jobs"
  | "rank_jobs"
  | "finish"
  | "pause";

export interface AgentDecision {
  action: AgentAction;
  reason: string;
  expected: string;
  target?: string;
  value?: string;
  direction?: "up" | "down";
  amount?: number;
  confidence?: number;
}

export interface AgentActionResult {
  ok: boolean;
  message: string;
  pageMayChange?: boolean;
  data?: unknown;
}

export type AgentTaskStatus = "pending" | "running" | "completed" | "failed";

export interface AgentTask {
  id: string;
  step: AgentStep;
  status: AgentTaskStatus;
  attempts: number;
  maxAttempts: number;
  error: string;
}

export interface ApprovalRequest {
  id: string;
  action: string;
  title: string;
  description: string;
  createdAt: string;
  status: "pending" | "approved" | "rejected";
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  risk: "read" | "write" | "high";
}

export interface BootstrapStatus {
  ok: boolean;
  message: string;
  step?: AgentStep;
  runId?: string;
  state?: AgentState;
  tool?: string;
  approval?: ApprovalRequest;
}

export interface ProfileAnalysisResult {
  cleanProfile: string;
  summary: string;
  intent: JobIntent;
}

export interface AgentTools {
  getSettings(): Promise<Settings>;
  observePage(): PageObservation;
  readQueryContext(): BossQueryContext;
  planAction(context: AgentContext): Promise<AgentDecision>;
  executeBrowserAction(decision: AgentDecision): Promise<AgentActionResult>;
  verifyAction(decision: AgentDecision, before: PageObservation): Promise<AgentActionResult>;
  isProfilePage(): boolean;
  findProfileEntry(): Promise<HTMLElement | null>;
  navigate(element: HTMLElement): Promise<void>;
  importProfile(): Promise<{ ok: boolean; reason?: string; analysis?: ProfileAnalysisResult }>;
  isJobListPage(): boolean;
  hasJobCards(): boolean;
  applyFilters(): Promise<QueryApplyResult>;
  findJobsEntry(): Promise<HTMLElement | null>;
  extractJobs(): Promise<Job[]>;
  filterJobs(jobs: Job[]): Promise<Job[]>;
  rankJobs(jobs: Job[]): Promise<Job[]>;
  saveJobs(jobs: Job[]): Promise<void>;
  waitFor(check: () => boolean, description: string, timeoutMs?: number): Promise<void>;
  setStatus(status: BootstrapStatus): Promise<void>;
  requestApproval(request: Omit<ApprovalRequest, "id" | "createdAt" | "status">): Promise<ApprovalRequest>;
}
