import type { JobItem } from "../shared/types";

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
}

export function enrichVisibleJob(visibleJob: JobItem, apiJob?: JobItem): JobItem {
  if (!apiJob) return visibleJob;
  return {
    ...apiJob,
    ...visibleJob,
    companyName: recognizedValue(visibleJob.companyName, apiJob.companyName, "未识别公司"),
    positionName: recognizedValue(visibleJob.positionName, apiJob.positionName, "未识别职位"),
    salary: visibleJob.salary || apiJob.salary,
    city: visibleJob.city || apiJob.city,
    url: absoluteUrl(visibleJob.url, apiJob.url),
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
    url: absoluteUrl(next.url, current.url),
    sourceText: combineSourceText(current.sourceText, next.sourceText),
    status: current.status === "sent" || next.status === "sent" ? "sent" : "pending",
  };
}

function recognizedValue(primary: string, fallback: string, placeholder: string): string {
  if (primary && primary !== placeholder) return primary;
  return fallback || primary;
}

function absoluteUrl(primary: string, fallback: string): string {
  if (/^https?:\/\//i.test(primary)) return primary;
  return fallback || primary;
}

function combineSourceText(left?: string, right?: string): string {
  if (!left) return right || "";
  if (!right || left.includes(right)) return left;
  if (right.includes(left)) return right;
  return `${left} ${right}`;
}
