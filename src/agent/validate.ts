import type { AgentDecision, AgentPhase, BossQueryContext, Job, PageSnapshot, Settings } from "../types";

export interface ValidationContext {
  snapshot: PageSnapshot;
  phase: AgentPhase;
  greetMessage: string;
  jobsCollected: boolean;
  filterCompleted: boolean;
  ranked: boolean;
}

export function validateDecision(d: AgentDecision, ctx: ValidationContext): { ok: boolean; reason: string } {
  if (d.snapshotId !== ctx.snapshot.snapshotId) return { ok: false, reason: `snapshotId 不匹配（决策 ${d.snapshotId} ≠ 当前 ${ctx.snapshot.snapshotId}）` };
  if (d.action === "pause") return { ok: true, reason: "" };
  const refEl = d.ref !== undefined ? ctx.snapshot.elements.find(e => e.id === d.ref) : undefined;
  const needRef: boolean = ["click", "fill", "next_page"].includes(d.action);
  if (needRef) {
    if (!d.ref) return { ok: false, reason: `${d.action} 缺少 ref` };
    if (!refEl) return { ok: false, reason: `ref ${d.ref} 不在当前快照` };
  }
  if (d.action === "fill" && d.value === undefined) return { ok: false, reason: "fill 缺少 value" };
  if (d.action === "next_page" && refEl && refEl.region !== "pager" && !/下一页|next/i.test(refEl.text)) return { ok: false, reason: "next_page 的 ref 不是分页控件" };

  if (ctx.phase === "screen") {
    if (refEl && (refEl.region === "chat" || /立即沟通|打招呼|沟通/.test(refEl.text))) return { ok: false, reason: "Phase A 不允许沟通操作" };
  }
  if (ctx.phase === "greet") {
    if (refEl && refEl.region === "filter") return { ok: false, reason: "Phase B 不允许改筛选" };
    if (d.action === "fill" && refEl && refEl.region !== "chat") return { ok: false, reason: "Phase B fill 必须落在 chat 区" };
  }
  if (d.action === "request_greet_approval") {
    if (!(ctx.jobsCollected && ctx.filterCompleted && ctx.ranked)) return { ok: false, reason: "未完成：岗位未收集/未过滤/未排序" };
  }
  return { ok: true, reason: "" };
}

export function validateSelectedUrls(urls: string[], rankedJobs: Job[], settings: Settings): { valid: string[]; rejected: string[] } {
  const ranked = new Set(rankedJobs.map(j => j.url));
  const excluded = settings.excludeCompanies.split(/\r?\n|[,，]/).map(s => s.trim().toLowerCase()).filter(Boolean);
  const cap = Number(settings.greetCap) || 0;
  const valid: string[] = [];
  const rejected: string[] = [];
  // 先对输入去重（保留首次出现顺序），避免重复 URL 进入 valid 导致同一岗位被二次打招呼。
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const url of urls) {
    if (seen.has(url)) {
      rejected.push(`${url}（重复）`);
    } else {
      seen.add(url);
      deduped.push(url);
    }
  }
  for (const url of deduped) {
    let reason = "";
    try { if (!/(^|\.)zhipin\.com$/i.test(new URL(url).hostname)) reason = "非 zhipin 域"; } catch { reason = "无效 URL"; }
    if (!reason && !ranked.has(url)) reason = "不在本次排序结果";
    if (!reason) {
      const job = rankedJobs.find(j => j.url === url);
      if (job && excluded.some(e => job.company.toLowerCase().includes(e))) reason = "排除公司";
    }
    if (!reason && valid.length >= cap) reason = "超过 greetCap";
    if (reason) rejected.push(`${url}（${reason}）`); else valid.push(url);
  }
  return { valid, rejected };
}

// 用于完成校验：effectiveQuery 是否满足（或无控件）
export function effectiveQuerySatisfied(effective: BossQueryContext, current: BossQueryContext, snapshot: PageSnapshot): { satisfied: boolean; missing: string[] } {
  const dims: Array<[keyof BossQueryContext, RegExp]> = [
    ["location", /城市|地点/], ["salary", /薪资|薪水/], ["jobTypes", /求职类型|工作性质/],
    ["experience", /经验/], ["education", /学历/], ["industries", /行业/], ["companySizes", /规模/]
  ];
  const missing: string[] = [];
  for (const [dim, re] of dims) {
    const desired = effective[dim] as string[];
    if (!desired.length) continue;
    const cur = current[dim] as string[];
    const got = desired.every(v => cur.some(c => c.toLowerCase().includes(v.toLowerCase()) || v.toLowerCase().includes(c.toLowerCase())));
    const hasControl = snapshot.elements.some(e => e.region === "filter" && re.test(e.text));
    if (!got && hasControl) missing.push(String(dim));
  }
  return { satisfied: missing.length === 0, missing };
}
