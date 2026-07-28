import { hasRecognizedPosition } from "./job-filter";
import { hasSendableJobTarget } from "./job-target";
import type { JobItem } from "./types";

export function prepareTaskJobs(jobs: JobItem[], batchLimit: number): {
  jobs: JobItem[];
  removedCount: number;
  limitedCount: number;
} {
  const uniqueJobs = [...new Map(jobs.filter((job) => job.jobId).map((job) => [job.jobId, job])).values()];
  const eligibleJobs = uniqueJobs.filter((job) => hasRecognizedPosition(job) && hasSendableJobTarget(job));
  const preparedJobs = eligibleJobs.slice(0, batchLimit).map((job) => ({ ...job, status: "pending" as const, reason: undefined }));
  return {
    jobs: preparedJobs,
    removedCount: uniqueJobs.length - eligibleJobs.length,
    limitedCount: eligibleJobs.length - preparedJobs.length,
  };
}
