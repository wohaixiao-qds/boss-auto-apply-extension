import type { JobItem, ScanResponse } from "../shared/types";

export function scanJobs(): ScanResponse {
  const cards = findJobCards();
  const seen = new Set<string>();
  const jobs: JobItem[] = [];

  for (const card of cards) {
    const link = card.querySelector<HTMLAnchorElement>('a[href*="/job_detail/"], a[href*="/job/"]') ?? card.querySelector<HTMLAnchorElement>("a[href]");
    const url = link?.href ?? "";
    const jobId = getJobId(card, url);
    if (!jobId || seen.has(jobId)) continue;
    const text = normalize(card.textContent ?? "");
    const positionName = pickText(card, [".job-name", ".job-title", "h3", "h2", '[class*="job-name"]', '[class*="job-title"]']) || link?.textContent?.trim() || "";
    if (!isRealJobTitle(positionName) || isMoreInfoEntry(card, positionName)) continue;
    seen.add(jobId);
    jobs.push({
      jobId,
      companyName: findCompanyName(card) || "未识别公司",
      positionName,
      salary: findSalary(card),
      city: pickText(card, [".job-area", ".job-location", ".location", '[class*="location"]', '[class*="city"]']) || "",
      url,
      sourceText: text,
      status: isBossJobMarkedSent(card) ? "sent" : "pending",
    });
  }

  return { jobs, warning: jobs.length ? undefined : "未读取到带职位 ID 的职位卡片，请确认当前页面是 BOSS 职位列表。" };
}

function findCompanyName(card: HTMLElement): string {
  // 优先使用公司主页链接，避免把 BOSS 卡片里的地点节点误当成公司名。
  const companyLink = [...card.querySelectorAll<HTMLAnchorElement>("a[href]")].find((link) => {
    const href = link.getAttribute("href") || "";
    const text = normalize(link.innerText || link.textContent || "");
    return /\/gongsi\/|\/company\//i.test(href) && text && !isNonCompanyText(text);
  });
  if (companyLink) return normalize(companyLink.innerText || companyLink.textContent || "");

  const candidates = [
    ".company-name",
    ".company-text",
    ".company",
    ".company-info",
    ".brand-name",
    '[class*="company"]',
    '[class*="brand"]',
  ];
  for (const selector of candidates) {
    const value = pickText(card, [selector]);
    if (value && !isNonCompanyText(value)) return value;
  }
  return "";
}

function findSalary(card: HTMLElement): string {
  const salaryPattern = /\d+(?:\.\d+)?\s*(?:(?:[-~至–—－]\s*)?\d+(?:\.\d+)?\s*)?K(?:\s*[·•.]\s*\d+\s*薪)?/i;
  const selectors = [
    ".salary",
    ".job-salary",
    ".job-limit",
    ".job-limit-name",
    ".job-limit-item",
    '[class*="salary"]',
    '[class*="job-limit"]',
    '[data-salary]',
    '[ka*="salary"]',
  ];
  const direct = pickText(card, selectors);
  const directMatch = direct.match(salaryPattern);
  if (directMatch) return normalizeSalary(directMatch[0]);

  // BOSS 不同列表版本的 class 经常变化，遍历卡片内短文本作为兜底。
  const candidates = [
    ...[...card.querySelectorAll<HTMLElement>("span, em, strong, p, a, div")].map((node) => normalize(node.innerText || node.textContent || "")),
    normalize(card.innerText || card.textContent || ""),
  ];
  for (const candidate of candidates) {
    const match = candidate.match(salaryPattern);
    if (match) return normalizeSalary(match[0]);
  }
  return "";
}

function normalizeSalary(value: string): string {
  return value.replace(/\s+/g, "").replace(/[–—－]/g, "-");
}

function isNonCompanyText(value: string): boolean {
  const text = normalize(value);
  if (!text || /查看更多信息|查看详情|更多信息|职位详情/.test(text)) return true;
  // 过滤“北京”“北京·海淀区·苏州桥”这类地点节点，避免再次把地点当公司名。
  return /^(?:北京|上海|天津|重庆|广州|深圳|杭州|南京|苏州|成都|武汉|西安|郑州|济南|青岛|合肥|厦门|福州|长沙|东莞|宁波)(?:$|[·•].*(?:区|县|街道|镇|路|桥)?$)/.test(text);
}

export function isBossJobMarkedSent(card: HTMLElement): boolean {
  const controls = [...card.querySelectorAll<HTMLElement>("button, a, [role='button'], [class*='btn'], [aria-label]")];
  const markerText = controls
    .flatMap((element) => [element.innerText || element.textContent || "", element.getAttribute("aria-label") || "", element.getAttribute("title") || ""])
    .map(normalize)
    .join(" ");
  return /已沟通|已发送|已打招呼|继续沟通/.test(markerText);
}

function isRealJobTitle(value: string): boolean {
  const title = normalize(value);
  return title.length >= 2 && !/查看更多信息|查看详情|更多信息|职位详情/.test(title);
}

function isMoreInfoEntry(card: HTMLElement, positionName: string): boolean {
  if (/查看更多信息|查看详情|更多信息/.test(normalize(positionName))) return true;
  const linkTexts = [...card.querySelectorAll<HTMLAnchorElement>("a")].map((link) => normalize(link.textContent || ""));
  return linkTexts.length > 0 && linkTexts.every((text) => /查看更多信息|查看详情|更多信息/.test(text));
}

export function findJobCards(): HTMLElement[] {
  const selectors = [
    ".job-card-wrap",
    ".job-card-box",
    ".job-primary",
    "li.job-card-wrapper",
    ".job-card",
    ".job-list li",
    "li[ka='job-card']",
    '[data-jobid]',
    '[class*="job-card"]',
    'a[href*="/job_detail/"]',
    'a[href*="/job/"]',
  ];
  const found = new Set<HTMLElement>();
  for (const selector of selectors) {
    document.querySelectorAll<HTMLElement>(selector).forEach((element) => {
      const card = element.matches('a[href*="/job_detail/"], a[href*="/job/"]')
        ? (element.closest(".job-card-wrap, .job-card-box, .job-card-wrapper, .job-primary, li, article, .job-card") as HTMLElement | null) ?? element
        : element;
      found.add(card);
    });
  }
  return [...found].filter((element) => normalize(element.textContent ?? "").length > 5);
}

export function pickText(root: Element, selectors: string[]): string {
  for (const selector of selectors) {
    const value = root.querySelector(selector)?.textContent;
    if (value?.trim()) return normalize(value);
  }
  return "";
}

export function extractId(url: string): string {
  return url.match(/(?:job_detail|job)\/([^/?#]+)/)?.[1]?.replace(/\.html$/i, "") ?? "";
}

export function getJobId(card: HTMLElement, url: string): string {
  // BOSS 列表卡片的 data-jobid 可能是列表内部短 ID；详情 URL 中的 ID
  // 才是打开详情页后可稳定复用的职位主键。
  const urlId = extractId(url);
  if (urlId) return urlId;

  const direct = ["data-jobid", "data-job-id", "data-lid", "data-id"]
    .map((attribute) => card.getAttribute(attribute) || "")
    .find(Boolean);
  if (direct) return direct;
  const ka = card.getAttribute("ka") || card.querySelector<HTMLElement>("[ka]")?.getAttribute("ka") || "";
  const fromKa = ka.match(/(?:job|detail|chat)[_-](\d{4,})/i)?.[1] || ka.match(/(\d{6,})/)?.[1];
  return fromKa || extractId(url);
}

export function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
