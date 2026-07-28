import { browser } from "wxt/browser";
import { createEmptyTask, DEFAULT_SETTINGS, MAX_BATCH_LIMIT, type DailyStats, type Settings, type TaskState } from "./types";

export const TASK_STATE_KEY = "boss-greeting-task";
export const SETTINGS_KEY = "boss-greeting-settings";
export const DAILY_STATS_KEY = "boss-greeting-daily";

export async function getTaskState(): Promise<TaskState> {
  const result = await browser.storage.local.get(TASK_STATE_KEY);
  const stored = result[TASK_STATE_KEY] as Partial<TaskState> | undefined;
  // 清理旧版本的数组任务，避免旧的 hash id 继续参与自动发送。
  if (!stored || Array.isArray(stored.jobs) || !stored.queue || typeof stored.jobs !== "object" || hasLegacyJobIds(stored.jobs)) {
    return createEmptyTask();
  }
  return { ...createEmptyTask(), ...stored, jobs: stored.jobs as Record<string, TaskState["jobs"][string]>, queue: stored.queue };
}

function hasLegacyJobIds(jobs: Partial<TaskState["jobs"]>): boolean {
  return Object.values(jobs).some((job) => {
    if (!job?.jobId || !job.url) return false;
    const detailId = job.url.match(/(?:job_detail|job)\/([^/?#]+)/)?.[1]?.replace(/\.html$/i, "");
    return Boolean(detailId && detailId !== job.jobId);
  });
}

export async function saveTaskState(task: TaskState): Promise<void> {
  await browser.storage.local.set({
    [TASK_STATE_KEY]: { ...task, updatedAt: Date.now() },
  });
}

export async function getSettings(): Promise<Settings> {
  const result = await browser.storage.local.get(SETTINGS_KEY);
  const settings = { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] as Partial<Settings> | undefined) };
  return {
    ...settings,
    batchLimit: Math.max(1, Math.min(MAX_BATCH_LIMIT, Math.floor(settings.batchLimit))),
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
}

function todayKey(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export async function getDailyStats(): Promise<DailyStats> {
  const result = await browser.storage.local.get(DAILY_STATS_KEY);
  const stored = result[DAILY_STATS_KEY] as Partial<DailyStats> | undefined;
  const today = todayKey();
  if (!stored || stored.date !== today) {
    return { date: today, sentCount: 0 };
  }
  return { date: today, sentCount: stored.sentCount ?? 0 };
}

export async function incrementDailySent(): Promise<DailyStats> {
  const current = await getDailyStats();
  const next: DailyStats = { date: current.date, sentCount: current.sentCount + 1 };
  await browser.storage.local.set({ [DAILY_STATS_KEY]: next });
  return next;
}
