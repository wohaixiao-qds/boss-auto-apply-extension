import { browser } from "wxt/browser";
import { createEmptyTask, DEFAULT_SETTINGS, type Settings, type TaskState } from "./types";

export const TASK_STATE_KEY = "boss-greeting-task";
export const SETTINGS_KEY = "boss-greeting-settings";

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
  return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] as Partial<Settings> | undefined) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
}
