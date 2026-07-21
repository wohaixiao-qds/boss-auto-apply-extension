export type TaskStatus =
  | "idle"
  | "awaiting_approval"
  | "running"
  | "paused"
  | "completed"
  | "stopped";

export type JobStatus = "pending" | "sending" | "sent" | "skipped" | "failed";

export interface JobItem {
  jobId: string;
  companyName: string;
  positionName: string;
  salary: string;
  city: string;
  url: string;
  sourceText?: string;
  status: JobStatus;
  reason?: string;
}

export interface TaskState {
  jobs: Record<string, JobItem>;
  queue: string[];
  status: TaskStatus;
  currentIndex: number;
  successCount: number;
  skippedCount: number;
  failedCount: number;
  message?: string;
  startedAt?: number;
  updatedAt: number;
}

export interface Settings {
  minDelayMs: number;
  maxDelayMs: number;
  batchLimit: number;
  excludeOutsourcing: boolean;
}

export interface SendResult {
  status: "sent" | "skipped" | "failed" | "paused";
  reason?: string;
}

export type RuntimeMessage =
  | { type: "SCAN_JOBS" }
  | { type: "START_TASK"; jobs: JobItem[] }
  | { type: "PAUSE_TASK" }
  | { type: "RESUME_TASK" }
  | { type: "STOP_TASK" }
  | { type: "TEST_NOTIFICATION" }
  | { type: "GET_TASK_STATE" }
  | { type: "SEND_JOB"; job: JobItem; context?: "list" | "detail-tab" };

export interface ScanResponse {
  jobs: JobItem[];
  warning?: string;
  source?: "api" | "dom";
}

export const DEFAULT_SETTINGS: Settings = {
  minDelayMs: 3500,
  maxDelayMs: 7500,
  batchLimit: 30,
  excludeOutsourcing: true,
};

export function createEmptyTask(): TaskState {
  return {
    jobs: {},
    queue: [],
    status: "idle",
    currentIndex: 0,
    successCount: 0,
    skippedCount: 0,
    failedCount: 0,
    updatedAt: Date.now(),
  };
}

export function getProgress(task: TaskState): number {
  if (task.queue.length === 0) return 0;
  return Math.min(100, Math.round((task.currentIndex / task.queue.length) * 100));
}

export function randomDelay(settings: Settings, random = Math.random()): number {
  const min = Math.min(settings.minDelayMs, settings.maxDelayMs);
  const max = Math.max(settings.minDelayMs, settings.maxDelayMs);
  return Math.round(min + (max - min) * random);
}
