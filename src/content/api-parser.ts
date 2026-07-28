import type { JobItem } from "../shared/types";
import { extractJobIdFromUrl, normalizeBossJobUrl } from "../shared/job-target";

const ENCRYPTED_ID_KEYS = ["encryptJobId", "encrypt_job_id"];
const JOB_ID_KEYS = ["jobId", "job_id"];
const TITLE_KEYS = ["jobName", "job_name", "jobTitle", "job_title", "positionName", "position_name", "title"];
const COMPANY_KEYS = ["brandName", "brand_name", "companyName", "company_name", "company", "brand"];
const SALARY_KEYS = ["salaryDesc", "salary_desc", "salaryName", "salary_name", "salary"];
const CITY_KEYS = ["cityName", "city_name", "areaDistrict", "area_district", "location", "city"];
const URL_KEYS = ["jobUrl", "job_url", "jobDetailUrl", "job_detail_url", "url"];

export function parseApiJobs(payload: unknown): JobItem[] {
  const jobs: JobItem[] = [];
  const seen = new Set<string>();
  walk(payload, (candidate) => {
    const job = toJobItem(candidate);
    if (!job || seen.has(job.jobId)) return;
    seen.add(job.jobId);
    jobs.push(job);
  });
  return jobs;
}

export function isJobListApiUrl(value: string): boolean {
  try {
    const url = new URL(value, "https://www.zhipin.com");
    return /(?:search\/joblist|recommend\/job\/list|joblist(?:\.json)?)/i.test(url.pathname);
  } catch {
    return false;
  }
}

function walk(value: unknown, visit: (value: Record<string, unknown>) => void): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, visit));
    return;
  }
  const record = value as Record<string, unknown>;
  visit(record);
  Object.values(record).forEach((child) => walk(child, visit));
}

function toJobItem(record: Record<string, unknown>): JobItem | null {
  const positionName = firstString(record, TITLE_KEYS);
  if (!positionName || !isRealTitle(positionName)) return null;

  const rawUrl = normalizeBossJobUrl(firstString(record, URL_KEYS));
  const encryptedId = firstString(record, ENCRYPTED_ID_KEYS);
  const fallbackId = firstString(record, JOB_ID_KEYS);
  const jobId = extractJobIdFromUrl(rawUrl) || encryptedId || (isCanonicalLookingId(fallbackId) ? fallbackId : "");
  if (!jobId) return null;
  const companyName = firstString(record, COMPANY_KEYS);
  const salary = firstString(record, SALARY_KEYS);
  const city = firstString(record, CITY_KEYS);
  if (!companyName && !salary && !city) return null;

  return {
    jobId,
    companyName: companyName || "未识别公司",
    positionName,
    salary,
    city,
    url: rawUrl || `https://www.zhipin.com/job_detail/${encodeURIComponent(jobId)}.html`,
    sourceText: safeStringify(record),
    status: "pending",
  };
}

function safeStringify(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value).slice(0, 5000);
  } catch {
    return "";
  }
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).replace(/\s+/g, " ").trim();
      if (text) return text;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nestedValue = firstString(value as Record<string, unknown>, ["name", "text", "value", "desc"]);
      if (nestedValue) return nestedValue;
    }
  }
  return "";
}

function isRealTitle(value: string): boolean {
  return value.length >= 2 && !/查看更多信息|查看详情|更多信息|职位详情/.test(value);
}

function isCanonicalLookingId(value: string): boolean {
  return value.length >= 12 && /[a-z]/i.test(value) && /\d/.test(value);
}
