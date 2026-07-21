import type { JobItem } from "./types";

const OUTSOURCING_PATTERN = /外包|人力外包|劳务派遣|第三方派遣|驻场开发|驻场服务|项目外派|外派开发|服务外包/;
const NEGATIVE_PATTERN = /不接受外包|拒绝外包|非外包|不招外包/;

export function isOutsourcingJob(job: JobItem): boolean {
  const text = [job.companyName, job.positionName, job.sourceText || ""].join(" ").replace(/\s+/g, " ");
  if (NEGATIVE_PATTERN.test(text)) return false;
  return OUTSOURCING_PATTERN.test(text);
}
