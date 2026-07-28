import type { JobItem } from "./types";

export function extractJobIdFromUrl(value: string): string {
  try {
    const url = new URL(value, "https://www.zhipin.com");
    return url.pathname.match(/\/(?:job_detail|job)\/([^/?#]+)/i)?.[1]?.replace(/\.html$/i, "") ?? "";
  } catch {
    return "";
  }
}

export function normalizeBossJobUrl(value: string): string {
  try {
    const url = new URL(value, "https://www.zhipin.com");
    if (!/^(?:www\.)?zhipin\.com$/i.test(url.hostname)) return "";
    if (!extractJobIdFromUrl(url.href)) return "";
    return url.href;
  } catch {
    return "";
  }
}

export function hasSendableJobTarget(job: Pick<JobItem, "jobId" | "url">): boolean {
  const url = normalizeBossJobUrl(job.url);
  return Boolean(job.jobId && url && extractJobIdFromUrl(url) === job.jobId);
}
