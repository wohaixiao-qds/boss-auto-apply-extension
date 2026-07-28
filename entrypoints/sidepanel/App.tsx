import {
  Badge,
  Box,
  Button,
  Card,
  Dialog,
  Flex,
  Heading,
  IconButton,
  Progress,
  Separator,
  SegmentedControl,
  Switch,
  Text,
  TextField,
  Tooltip,
} from "@radix-ui/themes";
import {
  Check,
  CircleAlert,
  Info,
  ListRestart,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  ScanSearch,
  Send,
  Square,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { browser } from "wxt/browser";
import { DAILY_STATS_KEY, getDailyStats, getSettings, getTaskState, saveSettings } from "../../src/shared/storage";
import { toChineseError } from "../../src/shared/errors";
import { createEmptyTask, DEFAULT_SETTINGS, getProgress, MAX_BATCH_LIMIT, type DailyStats, type JobItem, type RuntimeMessage, type ScanResponse, type TaskState, type TaskStatus } from "../../src/shared/types";
import type { Settings } from "../../src/shared/types";
import { filterJobs } from "../../src/shared/job-filter";

const statusLabels: Record<TaskStatus | JobItem["status"], string> = {
  idle: "待扫描",
  awaiting_approval: "待审核",
  running: "发送中",
  paused: "已暂停",
  completed: "已完成",
  stopped: "已停止",
  pending: "待发送",
  sending: "发送中",
  sent: "已发送",
  skipped: "已跳过",
  failed: "失败",
};

type ListFilter = "pending" | "success" | "failed";

function statusColor(status: TaskStatus | JobItem["status"]): "gray" | "blue" | "green" | "orange" | "red" {
  if (status === "sent" || status === "completed") return "green";
  if (status === "running" || status === "sending") return "blue";
  if (status === "paused" || status === "awaiting_approval" || status === "skipped") return "orange";
  if (status === "failed" || status === "stopped") return "red";
  return "gray";
}

function JobRow({ job, onRemove }: { job: JobItem; onRemove: (id: string) => void }) {
  return (
    <Card className="job-card" size="1">
      <Flex align="start" justify="between" gap="3">
        <Box className="job-copy">
          <Flex align="start" gap="2" className="job-field">
            <Text size="1" color="gray" className="job-field-label">公司</Text>
            <Text weight="bold" size="2" className="job-company">{job.companyName || "未识别公司"}</Text>
          </Flex>
          <Flex align="start" gap="2" className="job-field">
            <Text size="1" color="gray" className="job-field-label">岗位</Text>
            <Text color="gray" size="2" className="job-position">{job.positionName}</Text>
          </Flex>
          <Flex align="center" gap="2" className="job-meta">
            <Text color={job.salary ? "orange" : "gray"} size="1" weight={job.salary ? "medium" : "regular"}>
              {job.salary || "薪资未识别"}
            </Text>
            <Text color="gray" size="1">{job.city || "城市未识别"}</Text>
          </Flex>
          {job.reason ? (
            <Text as="div" color="red" size="1" className="job-reason">
              {job.reason}
            </Text>
          ) : null}
        </Box>
        <Flex align="center" gap="2" className="job-actions">
          <Badge color={statusColor(job.status)} variant="soft">
            {statusLabels[job.status]}
          </Badge>
          {job.status === "pending" ? (
            <Tooltip content="移除">
              <IconButton variant="ghost" color="gray" size="1" onClick={() => onRemove(job.jobId)} aria-label="移除职位">
                <Trash2 size={15} />
              </IconButton>
            </Tooltip>
          ) : null}
        </Flex>
      </Flex>
    </Card>
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// 扩展刚重新加载后，原页面的内容脚本会被卸载，sendMessage 会抛这类底层错误。
function isConnectionLost(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /receiving end does not exist|could not establish connection|message port closed|disconnected/i.test(message);
}

async function waitForTabComplete(tabId: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tab = await browser.tabs.get(tabId);
      if (tab.status === "complete") return;
    } catch {
      return;
    }
    await delay(300);
  }
}

// 内容脚本在线但没抓到职位时，把原因翻译成可操作的提示。
function analyzeEmptyScan(warning: string | undefined, scriptReachable: boolean): string {
  if (warning) return warning;
  if (!scriptReachable) {
    return "无法连接 BOSS 页面，请确认已打开 BOSS 直聘职位列表并重试。";
  }
  return "未识别到职位。请确认当前是 BOSS 职位列表页、已完成城市/关键词/薪资等筛选，并等待列表加载完成后再扫描。";
}

function NumberSetting({
  label,
  value,
  min = 1,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const parsed = Number.parseInt(draft, 10);
    const normalized = Number.isFinite(parsed)
      ? Math.max(min, max === undefined ? parsed : Math.min(max, parsed))
      : value;
    setDraft(String(normalized));
    if (normalized !== value) onCommit(normalized);
  };

  return (
    <Flex align="center" gap="2" className="compact-setting">
      <Text size="1" color="gray">{label}</Text>
      <TextField.Root
        type="number"
        min={String(min)}
        max={max === undefined ? undefined : String(max)}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(String(value));
            event.currentTarget.blur();
          }
        }}
        className="batch-input"
      />
    </Flex>
  );
}

export default function App() {
  const [task, setTask] = useState<TaskState>(createEmptyTask);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [completionDismissed, setCompletionDismissed] = useState(false);
  const [listFilter, setListFilter] = useState<ListFilter>("pending");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [daily, setDaily] = useState<DailyStats>({ date: "", sentCount: 0 });
  const [settingsSaved, setSettingsSaved] = useState(false);

  const refresh = useCallback(async () => {
    const next = await getTaskState();
    setTask(next);
    if (next.status === "completed") setListFilter("pending");
  }, []);

  useEffect(() => {
    void refresh();
    void getSettings().then(setSettings);
    void getDailyStats().then(setDaily);
    const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes["boss-greeting-task"]) void refresh();
      if (changes[DAILY_STATS_KEY]) void getDailyStats().then(setDaily);
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  }, [refresh]);

  const updateSettings = async (next: Settings) => {
    setSettings(next);
    await saveSettings(next);
    setSettingsSaved(true);
  };

  const sendMessage = useCallback(async (message: RuntimeMessage) => {
    setError("");
    return browser.runtime.sendMessage(message);
  }, []);

  const scanJobs = useCallback(async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!tab?.id || !tab.url?.includes("zhipin.com")) {
        throw new Error("请先打开 BOSS 直聘职位列表页（zhipin.com）。");
      }

      const scanRequest = {
        type: "SCAN_JOBS",
        limit: settings.batchLimit,
        excludeOutsourcing: settings.excludeOutsourcing,
        excludeHeadhunter: settings.excludeHeadhunter,
      } satisfies RuntimeMessage;
      let response: ScanResponse | undefined;
      try {
        setNotice(`正在按投递上限收集职位，目标 ${settings.batchLimit} 个…`);
        response = (await browser.tabs.sendMessage(tab.id, scanRequest)) as ScanResponse;
      } catch (error) {
        if (!isConnectionLost(error)) throw error;
        // 内容脚本未连接（常见于扩展刚重新加载后页面脚本被卸载）。
        // 刷新 BOSS 页面以重建 fetch/XHR 信息桥，让扩展重新捕获职位列表接口响应。
        setNotice("BOSS 页面连接已断开，正在刷新页面重建连接…");
        await browser.tabs.reload(tab.id);
        await waitForTabComplete(tab.id);
        // 页面加载完成后，再留出时间让 BOSS 重新请求职位列表接口并被桥捕获。
        await delay(2500);
        try {
          response = (await browser.tabs.sendMessage(tab.id, scanRequest)) as ScanResponse;
        } catch {
          throw new Error("无法连接 BOSS 页面，已尝试刷新重建连接仍未成功，请手动刷新页面后重试。");
        }
      }

      if (!response?.jobs?.length) {
        // 内容脚本在线但没抓到职位：可能是 BOSS 列表接口尚未返回，等待后重试一次。
        setNotice("正在等待 BOSS 职位列表加载…");
        await delay(2000);
        try {
          response = (await browser.tabs.sendMessage(tab.id, scanRequest)) as ScanResponse;
        } catch {
          /* 保留上一次的空响应，交给下面统一分析报错 */
        }
      }

      if (!response?.jobs?.length) {
        throw new Error(analyzeEmptyScan(response?.warning, Boolean(response)));
      }

      const scannedJobs = response.jobs;
      const filtered = filterJobs(scannedJobs, settings);
      const jobs = filtered.jobs.slice(0, settings.batchLimit);
      if (!jobs.length) throw new Error("筛选后没有符合条件的职位，请调整外包/猎头过滤设置或 BOSS 搜索条件。");
      const exclusionParts = [
        filtered.excluded.unrecognizedPosition ? `岗位未识别 ${filtered.excluded.unrecognizedPosition} 个` : "",
        filtered.excluded.invalidTarget ? `职位链接无效 ${filtered.excluded.invalidTarget} 个` : "",
        filtered.excluded.outsourcing ? `外包 ${filtered.excluded.outsourcing} 个` : "",
        filtered.excluded.headhunter ? `猎头 ${filtered.excluded.headhunter} 个` : "",
        filtered.excluded.contacted ? `已沟通 ${filtered.excluded.contacted} 个` : "",
      ].filter(Boolean);
      const shortage = jobs.length < settings.batchLimit ? `；当前列表未发现更多职位，少于目标 ${settings.batchLimit} 个` : "";
      await browser.storage.local.set({
        "boss-greeting-task": {
          ...createEmptyTask(),
          jobs: Object.fromEntries(jobs.map((job) => [job.jobId, job])),
          queue: jobs.map((job) => job.jobId),
          status: "awaiting_approval",
          message: `已收集 ${scannedJobs.length} 个职位，筛选后保留 ${jobs.length} 个${exclusionParts.length ? `；已排除${exclusionParts.join("、")}` : ""}${shortage}，请审核后开始发送。`,
          updatedAt: Date.now(),
        },
      });
      setCompletionDismissed(false);
      setListFilter("pending");
      await refresh();
    } catch (cause) {
      setError(toChineseError(cause, "扫描失败，请确认 BOSS 页面已加载完成并重新尝试。"));
    } finally {
      setBusy(false);
      setNotice("");
    }
  }, [refresh, settings.batchLimit, settings.excludeHeadhunter, settings.excludeOutsourcing]);

  const removeJob = async (jobId: string) => {
    const { [jobId]: _removed, ...remainingJobs } = task.jobs;
    const next = { ...task, jobs: remainingJobs, queue: task.queue.filter((queuedJobId) => queuedJobId !== jobId), updatedAt: Date.now() };
    setTask(next);
    await browser.storage.local.set({ "boss-greeting-task": next });
  };

  const startTask = async () => {
    setConfirmOpen(false);
    setBusy(true);
    setCompletionDismissed(false);
    try {
      await sendMessage({ type: "START_TASK", jobs: task.queue.map((jobId) => task.jobs[jobId]).filter((job): job is JobItem => Boolean(job && job.status === "pending")) });
      await refresh();
    } catch (cause) {
      setError(toChineseError(cause, "任务启动失败，请先扫描并审核职位列表。"));
    } finally {
      setBusy(false);
    }
  };

  const controlTask = async (type: "PAUSE_TASK" | "RESUME_TASK" | "STOP_TASK") => {
    setBusy(true);
    try {
      await sendMessage({ type });
      await refresh();
    } catch (cause) {
      setError(toChineseError(cause, "操作失败，请检查当前 BOSS 页面和任务状态。"));
    } finally {
      setBusy(false);
    }
  };

  const clearTask = async () => {
    await sendMessage({ type: "STOP_TASK" });
    await browser.storage.local.remove("boss-greeting-task");
    await refresh();
  };

  const orderedJobs = task.queue.map((jobId) => task.jobs[jobId]).filter((job): job is JobItem => Boolean(job));
  const pendingCount = orderedJobs.filter((job) => job.status === "pending" || job.status === "sending").length;
  const readyCount = orderedJobs.filter((job) => job.status === "pending").length;
  const successCount = orderedJobs.filter((job) => job.status === "sent" || job.status === "skipped").length;
  const failedCount = orderedJobs.filter((job) => job.status === "failed").length;
  const visibleJobs = orderedJobs.filter((job) => {
    if (listFilter === "pending") return job.status === "pending" || job.status === "sending";
    if (listFilter === "success") return job.status === "sent" || job.status === "skipped";
    return job.status === "failed";
  });
  const batchCount = Math.min(readyCount, settings.batchLimit);
  const isRunning = task.status === "running";
  const isPaused = task.status === "paused";
  const isReviewable = task.status === "awaiting_approval" && readyCount > 0;
  const progress = useMemo(() => getProgress(task), [task]);
  const showCompletion = task.status === "completed" && !completionDismissed;

  return (
    <Box className="sidepanel-shell">
      <Flex direction="column" gap="3" className="sidepanel-content">
        <Box className="panel-header">
          <Flex align="center" justify="between" gap="2">
            <Flex align="center" gap="2" className="panel-title">
              <Box className="brand-mark"><Send size={16} /></Box>
              <Heading size="4">BOSS 自动打招呼</Heading>
            </Flex>
            <Badge color={statusColor(task.status)} variant="soft">
              {statusLabels[task.status]}
            </Badge>
          </Flex>
          <Text as="p" size="1" color="gray" className="subtitle">
            在侧边栏审核职位，不影响当前页面浏览
          </Text>
        </Box>

        <Card className="summary-card">
          <Flex align="center" justify="between" gap="3">
            <Box>
              <Text as="div" size="1" color="gray">当前任务进度</Text>
              <Text as="div" size="5" weight="bold">{task.currentIndex} / {task.queue.length}</Text>
            </Box>
            <Flex direction="column" align="end" gap="1">
              <Text size="2" color="green">成功 {task.successCount}</Text>
              <Text size="2" color="red">失败 {task.failedCount}</Text>
              <Text size="1" color="gray">今日投递 {daily.sentCount} / {settings.dailyLimit}</Text>
            </Flex>
          </Flex>
          <Progress value={progress} className="progress" />
        </Card>

        <Card className="settings-card">
          <Flex align="center" justify="between" gap="2" className="settings-inline">
            <Flex align="center" gap="2" className="settings-title">
              <Text weight="bold" size="2">投递设置</Text>
              {settingsSaved ? <Badge color="green" variant="soft">已保存</Badge> : null}
            </Flex>
            <Flex align="center" gap="3" className="settings-controls">
              <Flex align="center" gap="2" className="compact-setting">
                <Text size="1" color="gray">排除外包</Text>
                <Switch checked={settings.excludeOutsourcing} onCheckedChange={(checked) => void updateSettings({ ...settings, excludeOutsourcing: checked })} />
              </Flex>
              <Flex align="center" gap="2" className="compact-setting">
                <Text size="1" color="gray">排除猎头</Text>
                <Switch checked={settings.excludeHeadhunter} onCheckedChange={(checked) => void updateSettings({ ...settings, excludeHeadhunter: checked })} />
              </Flex>
              <NumberSetting
                label="投递上限"
                value={settings.batchLimit}
                max={MAX_BATCH_LIMIT}
                onCommit={(value) => void updateSettings({ ...settings, batchLimit: value })}
              />
              <NumberSetting
                label="每日上限"
                value={settings.dailyLimit}
                max={200}
                onCommit={(value) => void updateSettings({ ...settings, dailyLimit: value })}
              />
            </Flex>
          </Flex>
        </Card>

        {error ? (
          <Card className="error-card">
            <Flex align="start" gap="2">
              <CircleAlert size={17} aria-hidden="true" />
              <Text size="2">{error}</Text>
            </Flex>
          </Card>
        ) : null}

        {notice ? (
          <Card className="notice-card">
            <Flex align="start" gap="2">
              <Info size={17} aria-hidden="true" />
              <Text size="2">{notice}</Text>
            </Flex>
          </Card>
        ) : null}

        {task.message && task.status !== "completed" ? (
          <Card className={`task-message ${task.status === "running" ? "task-message-running" : ""}`}>
            <Flex align="start" gap="3" className="task-activity">
              <Box className="activity-icon">
                {task.status === "running" ? <LoaderCircle className="spin" size={18} /> : <CircleAlert size={16} />}
              </Box>
              <Box className="task-activity-copy">
                <Text as="div" size="1" color="gray" weight="medium">
                  {task.status === "running" ? "任务执行中" : "任务状态"}
                </Text>
                <Flex align="center" gap="1">
                  <Text size="2" weight="medium">{task.message}</Text>
                  {task.status === "running" ? <span className="animated-dots" aria-hidden="true"><i /> <i /> <i /></span> : null}
                </Flex>
              </Box>
            </Flex>
          </Card>
        ) : null}

        {showCompletion ? (
          <Card className="completion-card">
            <Flex align="start" justify="between" gap="3">
              <Box>
                <Text as="div" size="3" weight="bold">本批次已投递完成</Text>
                <Text as="div" size="2" color="gray" className="completion-summary">
                  成功 {task.successCount} 条 · 跳过 {task.skippedCount} 条 · 失败 {task.failedCount} 条
                </Text>
              </Box>
              <IconButton variant="ghost" color="gray" size="1" onClick={() => setCompletionDismissed(true)} aria-label="关闭完成提示">
                ×
              </IconButton>
            </Flex>
          </Card>
        ) : null}

        <Flex align="center" justify="between" gap="2" className="job-section-header">
          <Box>
            <Text as="div" weight="bold" size="3">待打招呼职位</Text>
            <Text as="div" size="1" color="gray">按投递上限收集并筛选职位，审核后开始发送</Text>
          </Box>
          <Tooltip content="收集职位">
            <IconButton variant="soft" onClick={() => void scanJobs()} disabled={busy} aria-label="按投递上限收集职位">
              {busy ? <RefreshCw className="spin" size={17} /> : <ScanSearch size={17} />}
            </IconButton>
          </Tooltip>
        </Flex>

        <SegmentedControl.Root
          value={listFilter}
          onValueChange={(value) => setListFilter(value as ListFilter)}
          size="2"
          className="status-tabs"
        >
          <SegmentedControl.Item value="pending">待投递 {pendingCount}</SegmentedControl.Item>
          <SegmentedControl.Item value="success">投递成功 {successCount}</SegmentedControl.Item>
          <SegmentedControl.Item value="failed">投递失败 {failedCount}</SegmentedControl.Item>
        </SegmentedControl.Root>

        <Box className="job-list-container">
          {visibleJobs.length ? (
            <Box className="job-list">
              <Flex direction="column" gap="2">
                {visibleJobs.map((job) => <JobRow key={job.jobId} job={job} onRemove={(jobId) => void removeJob(jobId)} />)}
              </Flex>
            </Box>
          ) : (
            <Card className="empty-state">
              <ListRestart size={28} strokeWidth={1.5} />
              <Text as="div" weight="bold" size="3">
                {listFilter === "pending" ? "待投递列表为空" : listFilter === "success" ? "还没有投递成功的职位" : "还没有投递失败的职位"}
              </Text>
              <Text as="div" size="2" color="gray" align="center">
                {listFilter === "pending" ? "任务完成后这里会自动清空，可切换到其他状态查看结果。" : "职位处理后会在对应状态列表中显示。"}
              </Text>
            </Card>
          )}
        </Box>

        <Separator size="4" />

        <Flex direction="column" gap="2" className="action-area">
          {isRunning ? (
            <Button size="3" color="orange" variant="soft" disabled={busy} onClick={() => void controlTask("PAUSE_TASK")}>
              <Pause size={17} /> 暂停发送
            </Button>
          ) : isPaused ? (
            <Flex gap="2">
              <Button size="3" className="grow" disabled={busy} onClick={() => void controlTask("RESUME_TASK")}>
                <Play size={17} /> 继续发送
              </Button>
              <Button size="3" color="red" variant="soft" disabled={busy} onClick={() => void controlTask("STOP_TASK")}>
                <Square size={16} /> 停止
              </Button>
            </Flex>
          ) : isReviewable ? (
            <Dialog.Root open={confirmOpen} onOpenChange={setConfirmOpen}>
              <Dialog.Trigger>
                <Button size="3" disabled={busy}>
                  <Check size={17} /> 同意并按顺序发送 ({batchCount})
                </Button>
              </Dialog.Trigger>
              <Dialog.Content maxWidth="380px">
                <Dialog.Title>确认开始打招呼？</Dialog.Title>
                <Dialog.Description size="2" mb="4">
                  当前筛选到 {pendingCount} 家，本批将按顺序发送 {batchCount} 条 BOSS 已配置的打招呼语。发送过程中可随时暂停。
                </Dialog.Description>
                <Flex justify="end" gap="2">
                  <Dialog.Close>
                    <Button variant="soft" color="gray">取消</Button>
                  </Dialog.Close>
                  <Button onClick={() => void startTask()}>
                    <Check size={16} /> 同意开始
                  </Button>
                </Flex>
              </Dialog.Content>
            </Dialog.Root>
          ) : (
            <Button size="3" variant="soft" onClick={() => void scanJobs()} disabled={busy}>
              <ScanSearch size={17} /> 按上限收集职位
            </Button>
          )}
          {orderedJobs.length > 0 && !isRunning && !isPaused ? (
            <Tooltip content="清除当前任务和列表">
              <Button size="2" variant="ghost" color="gray" onClick={() => void clearTask()}>
                <Trash2 size={15} /> 清除列表
              </Button>
            </Tooltip>
          ) : null}
        </Flex>
      </Flex>
    </Box>
  );
}
