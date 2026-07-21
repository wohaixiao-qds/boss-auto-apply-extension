import { browser } from "wxt/browser";
import { defineBackground } from "wxt/sandbox";
import { getSettings, getTaskState, saveTaskState } from "../src/shared/storage";
import { toChineseError } from "../src/shared/errors";
import {
  createEmptyTask,
  randomDelay,
  type JobItem,
  type RuntimeMessage,
  type SendResult,
  type TaskState,
} from "../src/shared/types";

let processing = false;

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(async () => {
    const task = await getTaskState();
    if (!task.updatedAt) await saveTaskState(createEmptyTask());
    try {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    } catch {
      // Older Chrome versions can still open the panel via the action fallback below.
    }
  });

  browser.action.onClicked.addListener(async (tab) => {
    if (tab.windowId) await chrome.sidePanel.open({ windowId: tab.windowId });
  });

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    void handleMessage(message as RuntimeMessage).then(sendResponse);
    return true;
  });
});

async function handleMessage(message: RuntimeMessage) {
  switch (message.type) {
    case "GET_TASK_STATE":
      return getTaskState();
    case "START_TASK":
      return startTask(message.jobs);
    case "PAUSE_TASK":
      return updateStatus("paused", "任务已暂停，可以继续发送。");
    case "RESUME_TASK":
      return resumeTask();
    case "STOP_TASK":
      processing = false;
      return updateStatus("stopped", "任务已停止。");
    case "TEST_NOTIFICATION":
      return createSystemNotification("通知测试", "BOSS 自动打招呼系统通知测试成功。", "测试通知");
    default:
      return undefined;
  }
}

async function startTask(jobs: JobItem[]) {
  if (jobs.length === 0) throw new Error("没有可发送的职位。");
  const settings = await getSettings();
  const uniqueJobs = [...new Map(jobs.filter((job) => job.jobId).map((job) => [job.jobId, job])).values()];
  const limitedJobs = uniqueJobs.slice(0, settings.batchLimit).map((job) => ({ ...job, status: "pending" as const, reason: undefined }));
  const jobMap = Object.fromEntries(limitedJobs.map((job) => [job.jobId, job]));
  const task: TaskState = {
    ...createEmptyTask(),
    jobs: jobMap,
    queue: limitedJobs.map((job) => job.jobId),
    status: "running",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    message: limitedJobs.length < uniqueJobs.length ? `本批最多发送 ${settings.batchLimit} 条。` : undefined,
  };
  await saveTaskState(task);
  void processTask();
  return task;
}

async function resumeTask() {
  const task = await getTaskState();
  if (task.status !== "paused") return task;
  await saveTaskState({ ...task, status: "running", message: "任务继续发送。" });
  void processTask();
  return getTaskState();
}

async function processTask() {
  if (processing) return;
  processing = true;
  try {
    const settings = await getSettings();

    while (true) {
      const task = await getTaskState();
      if (task.status !== "running") break;
      if (task.currentIndex >= task.queue.length) {
        const completedTask = { ...task, status: "completed" as const, message: `当前批次已投递完成：成功 ${task.successCount} 条，跳过 ${task.skippedCount} 条，失败 ${task.failedCount} 条。` };
        await saveTaskState(completedTask);
        void notifyBatchCompleted(completedTask);
        break;
      }

      const index = task.currentIndex;
      const jobId = task.queue[index];
      const job = task.jobs[jobId];
      if (!job) {
        await saveTaskState({ ...task, currentIndex: index + 1, failedCount: task.failedCount + 1, message: `职位 ${jobId} 已不在任务中。` });
        continue;
      }
      const sendingTask = {
        ...task,
        jobs: replaceJob(task.jobs, jobId, { ...job, status: "sending" }),
        message: `正在打开详情页：${job.companyName} · ${job.positionName}`,
      };
      await saveTaskState(sendingTask);

      let result: SendResult;
      try {
        await saveTaskState({ ...sendingTask, message: `正在发送打招呼：${job.companyName} · ${job.positionName}` });
        result = await sendJobInDetailTab(job);
      } catch (error) {
        result = { status: "paused", reason: toChineseError(error, "无法打开职位详情页，任务已暂停，请检查 BOSS 登录状态。") };
      }

      const latest = await getTaskState();
      const nextStatus = result.status === "paused" ? "paused" : "running";
      const nextJobStatus = result.status === "sent" ? "sent" : result.status === "skipped" ? "skipped" : "failed";
      await saveTaskState({
        ...latest,
        status: nextStatus,
        currentIndex: result.status === "paused" ? index : index + 1,
        jobs: replaceJob(latest.jobs, jobId, { ...job, status: nextJobStatus, reason: result.reason }),
        successCount: latest.successCount + (result.status === "sent" ? 1 : 0),
        skippedCount: latest.skippedCount + (result.status === "skipped" ? 1 : 0),
        failedCount: latest.failedCount + (result.status === "failed" ? 1 : 0),
        message: result.reason || (result.status === "sent"
          ? `已完成：${job.companyName}，正在准备下一条。`
          : result.status === "skipped" ? `已跳过：${job.companyName}。` : `处理失败：${job.companyName}。`),
      });
      if (result.status === "paused") break;
      await wait(randomDelay(settings));
    }
  } catch (error) {
    await updateStatus("paused", toChineseError(error, "任务遇到未知错误，已暂停，请检查当前页面状态。"));
  } finally {
    processing = false;
  }
}

async function notifyBatchCompleted(task: TaskState): Promise<{ ok: boolean; reason?: string }> {
  return createSystemNotification(
    "BOSS 自动打招呼",
    `当前批次已投递完成：成功 ${task.successCount} 条，跳过 ${task.skippedCount} 条，失败 ${task.failedCount} 条。`,
    "批次完成",
  );
}

async function createSystemNotification(title: string, message: string, logLabel: string): Promise<{ ok: boolean; reason?: string }> {
  const notification = {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon.png"),
      title,
      message,
    } as const;

  try {
    const permission = await chrome.notifications.getPermissionLevel();
    if (permission === "denied") {
      return { ok: false, reason: "Chrome 系统通知权限已被拒绝，请在系统设置中允许 Google Chrome 通知。" };
    }

    await chrome.notifications.create(`boss-greeting-${Date.now()}`, notification);
    return { ok: true };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : "";
    if (/download all specified images|image|icon/i.test(rawMessage)) {
      try {
        // 图标资源加载失败时，使用无图标通知作为兜底，避免影响完成提醒。
        await chrome.notifications.create(`boss-greeting-${Date.now()}`, { type: "basic", title, message } as unknown as chrome.notifications.NotificationCreateOptions);
        return { ok: true };
      } catch {
        return { ok: false, reason: `${logLabel}失败：通知图标加载失败，请重新加载扩展。` };
      }
    }
    if (/permission|denied|not allowed/i.test(rawMessage)) {
      return { ok: false, reason: `${logLabel}失败：Chrome 系统通知权限未开启。` };
    }
    return { ok: false, reason: `${logLabel}失败：Chrome 暂时无法创建系统通知，请重新加载扩展。` };
  }
}

async function sendJobInDetailTab(job: JobItem): Promise<SendResult> {
  const tab = await browser.tabs.create({ url: job.url, active: false });
  if (!tab.id) throw new Error(`无法为职位 ${job.jobId} 创建后台详情标签页。`);

  try {
    return await sendWhenContentReady(tab.id, job);
  } finally {
    try {
      await browser.tabs.remove(tab.id);
    } catch {
      // 标签页可能已被页面或用户关闭。
    }
  }
}

async function sendWhenContentReady(tabId: number, job: JobItem): Promise<SendResult> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await browser.tabs.sendMessage(tabId, {
        type: "SEND_JOB",
        job,
        context: "detail-tab",
      } satisfies RuntimeMessage);
    } catch (error) {
      await wait(250);
    }
  }
  throw new Error(`职位 ${job.jobId} 的详情页加载超时，任务已暂停。`);
}

async function updateStatus(status: TaskState["status"], message: string) {
  const task = await getTaskState();
  const next = { ...task, status, message };
  await saveTaskState(next);
  return next;
}

function replaceJob(jobs: Record<string, JobItem>, jobId: string, job: JobItem): Record<string, JobItem> {
  return { ...jobs, [jobId]: job };
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
