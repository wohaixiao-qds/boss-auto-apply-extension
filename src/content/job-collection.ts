import type { JobItem } from "../shared/types";
import { extractJobIdFromUrl, normalizeBossJobUrl } from "../shared/job-target";

export function mergeVisibleJobs(
  target: Map<string, JobItem>,
  visibleJobs: Iterable<JobItem>,
  apiJobs: ReadonlyMap<string, JobItem>,
): void {
  for (const visibleJob of visibleJobs) {
    if (!visibleJob.jobId) continue;
    const enriched = enrichVisibleJob(visibleJob, apiJobs.get(visibleJob.jobId));
    const current = target.get(visibleJob.jobId);
    target.set(visibleJob.jobId, current ? mergeCollectedJob(current, enriched) : enriched);
  }

  // API 响应可能晚于列表滚动；只回填已经被 DOM 发现的职位，绝不加入 API 独有职位。
  for (const [jobId, collectedJob] of target) {
    const apiJob = apiJobs.get(jobId);
    if (apiJob) target.set(jobId, enrichVisibleJob(collectedJob, apiJob));
  }
}

export function enrichVisibleJob(visibleJob: JobItem, apiJob?: JobItem): JobItem {
  if (!apiJob || apiJob.jobId !== visibleJob.jobId) return visibleJob;
  return {
    ...visibleJob,
    companyName: recognizedValue(apiJob.companyName, visibleJob.companyName, "未识别公司"),
    positionName: recognizedValue(apiJob.positionName, visibleJob.positionName, "未识别职位"),
    salary: apiJob.salary || visibleJob.salary,
    city: apiJob.city || visibleJob.city,
    url: preferredJobUrl(visibleJob.url, apiJob.url, visibleJob.jobId),
    sourceText: combineSourceText(apiJob.sourceText, visibleJob.sourceText),
    status: visibleJob.status,
  };
}

function mergeCollectedJob(current: JobItem, next: JobItem): JobItem {
  return {
    ...current,
    ...next,
    companyName: recognizedValue(next.companyName, current.companyName, "未识别公司"),
    positionName: recognizedValue(next.positionName, current.positionName, "未识别职位"),
    salary: next.salary || current.salary,
    city: next.city || current.city,
    url: preferredJobUrl(next.url, current.url, next.jobId),
    sourceText: combineSourceText(current.sourceText, next.sourceText),
    status: current.status === "sent" || next.status === "sent" ? "sent" : "pending",
  };
}

function recognizedValue(primary: string, fallback: string, placeholder: string): string {
  if (primary && primary !== placeholder) return primary;
  return fallback || primary;
}

function preferredJobUrl(primary: string, fallback: string, jobId: string): string {
  const primaryUrl = normalizeBossJobUrl(primary);
  if (primaryUrl && extractJobIdFromUrl(primaryUrl) === jobId) return primaryUrl;
  const fallbackUrl = normalizeBossJobUrl(fallback);
  if (fallbackUrl && extractJobIdFromUrl(fallbackUrl) === jobId) return fallbackUrl;
  return primaryUrl || fallbackUrl || primary || fallback;
}

function combineSourceText(left?: string, right?: string): string {
  if (!left) return right || "";
  if (!right || left.includes(right)) return left;
  if (right.includes(left)) return right;
  return `${left} ${right}`;
}
