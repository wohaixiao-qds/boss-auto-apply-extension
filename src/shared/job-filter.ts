import type { JobItem } from "./types";
import { hasSendableJobTarget } from "./job-target";

const OUTSOURCING_PATTERN = /外包|人力外包|劳务派遣|第三方派遣|驻场开发|驻场服务|项目外派|外派开发|服务外包/;
const NEGATIVE_PATTERN = /不接受外包|拒绝外包|非外包|不招外包/;
const HEADHUNTER_PATTERN = /猎头|猎聘顾问|人才寻访|寻访顾问|招聘顾问|人才顾问|\bRPO\b|人力资源服务|人才服务|招聘服务/i;
const HEADHUNTER_NEGATIVE_PATTERN = /不接受猎头|拒绝猎头|非猎头|不是猎头/;

export interface JobFilterOptions {
  excludeOutsourcing: boolean;
  excludeHeadhunter: boolean;
}

export interface JobFilterResult {
  jobs: JobItem[];
  excluded: {
    unrecognizedPosition: number;
    invalidTarget: number;
    outsourcing: number;
    headhunter: number;
    contacted: number;
  };
}

function jobText(job: JobItem): string {
  return [job.companyName, job.positionName, job.sourceText || ""].join(" ").replace(/\s+/g, " ");
}

export function isOutsourcingJob(job: JobItem): boolean {
  const text = jobText(job);
  if (NEGATIVE_PATTERN.test(text)) return false;
  return OUTSOURCING_PATTERN.test(text);
}

export function isHeadhunterJob(job: JobItem): boolean {
  const text = jobText(job);
  if (HEADHUNTER_NEGATIVE_PATTERN.test(text)) return false;
  return HEADHUNTER_PATTERN.test(text);
}

export function hasRecognizedPosition(job: JobItem): boolean {
  const positionName = normalizeLabel(job.positionName);
  if (positionName.length < 2) return false;
  if (/未识别|未知岗位|未知职位|职位未识别|岗位未识别|查看更多信息|查看详情|更多信息|职位详情/.test(positionName)) return false;
  if (/\d+(?:\.\d+)?\s*(?:[-~至–—－]\s*\d+(?:\.\d+)?\s*)?K(?:\s*[·•.]\s*\d+\s*薪)?/i.test(positionName)) return false;

  const comparablePosition = comparableLabel(positionName);
  if (!comparablePosition) return false;
  if (comparablePosition === comparableLabel(job.companyName)) return false;
  if (comparablePosition === comparableLabel(job.city)) return false;
  return true;
}

function normalizeLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function comparableLabel(value: string): string {
  return normalizeLabel(value).replace(/[\s·•,，。;；:：/\\|()[\]{}【】（）_-]+/g, "").toLocaleLowerCase();
}

export function filterJobs(jobs: JobItem[], options: JobFilterOptions): JobFilterResult {
  const result: JobFilterResult = {
    jobs: [],
    excluded: { unrecognizedPosition: 0, invalidTarget: 0, outsourcing: 0, headhunter: 0, contacted: 0 },
  };

  for (const job of jobs) {
    if (!hasRecognizedPosition(job)) {
      result.excluded.unrecognizedPosition += 1;
    } else if (!hasSendableJobTarget(job)) {
      result.excluded.invalidTarget += 1;
    } else if (job.status !== "pending") {
      result.excluded.contacted += 1;
    } else if (options.excludeOutsourcing && isOutsourcingJob(job)) {
      result.excluded.outsourcing += 1;
    } else if (options.excludeHeadhunter && isHeadhunterJob(job)) {
      result.excluded.headhunter += 1;
    } else {
      result.jobs.push(job);
    }
  }
  return result;
}
