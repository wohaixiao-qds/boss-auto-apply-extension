import type { BossQueryContext, PageSnapshot, SnapshotElement, SnapshotRegion } from "../types";

let snapshotSeq = 0;
export function newSnapshotId(): string {
  snapshotSeq += 1;
  return `snap_${Date.now().toString(36)}_${snapshotSeq}`;
}

const CHIP_DIM: Array<[RegExp, keyof BossQueryContext]> = [
  [/薪资|薪水/, "salary"],
  [/经验/, "experience"],
  [/学历/, "education"],
  [/城市|地点/, "location"],
  [/求职类型|工作性质/, "jobTypes"],
  [/公司行业|行业/, "industries"],
  [/公司规模|规模/, "companySizes"]
];

export function classifyChip(text: string): keyof BossQueryContext | null {
  const t = (text || "").trim();
  for (const [re, dim] of CHIP_DIM) if (re.test(t)) return dim;
  return null;
}

export function serializeSnapshotForLLM(snap: PageSnapshot): string {
  const line = (e: SnapshotElement): string => {
    const parts = [`[e${e.id}]`, e.role, `"${e.text}"`];
    if (e.current) parts.push(`cur="${e.current}"`);
    if (e.checked) parts.push("✓");
    if (e.hint) parts.push(`hint="${e.hint}"`);
    parts.push(`@${e.region}`);
    return parts.join(" ");
  };
  return snap.elements.map(line).join("\n");
}

const SNAPSHOT_BUDGET = { search: 40, filter: 40, pager: 10, chat: 20, job: 30, other: 40 };

const snapshotRefs = new Map<string, HTMLElement>();
export function resetSnapshotRefs(): void { snapshotRefs.clear(); }

const isVisibleEl = (el: Element): boolean => {
  // jsdom 不执行布局，getBoundingClientRect 恒为 0、display 可能返回空串；
  // 仅以显式隐藏信号（display:none / visibility:hidden）作为不可见判定，
  // 这样在 jsdom 与真实浏览器下都行为一致。
  const cs = getComputedStyle(el);
  return cs.display !== "none" && cs.visibility !== "hidden";
};
const textOf = (n: Element | null): string => {
  if (!n) return "";
  // jsdom 未实现 innerText（返回 undefined），回退到 textContent。
  const t = n instanceof HTMLElement ? (n.innerText ?? n.textContent) : n.textContent;
  return (t || "").trim();
};
const norm = (v: unknown): string => String(v || "").toLowerCase().replace(/\s+/g, "");

function regionOf(el: HTMLElement): SnapshotRegion {
  const cls = norm(el.className);
  const text = norm(textOf(el));
  if (/search|搜索/.test(`${cls} ${text}`) && el.closest(".search-condition, .search-box, [class*='search']")) return "search";
  if (el.closest(".search-condition, .job-filter, .filter-condition, [class*='filter']")) return "filter";
  if (/pager|next|下一页/.test(`${cls} ${text}`) || el.closest(".pager, [class*='pager'], [class*='next']")) return "pager";
  if (el.closest("[class*='chat'], [class*='message-input'], [class*='communicate']")) return "chat";
  if (el.closest(".job-card-wrapper, .job-primary, [ka='job-card'], li")) return "job";
  return "other";
}

function roleOf(el: HTMLElement): SnapshotElement["role"] {
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return "input";
  if (tag === "SELECT") return "select";
  if (tag === "A") return "link";
  if (tag === "OPTION") return "option";
  if (el.getAttribute("role") === "option") return "option";
  if (el.getAttribute("role") === "menuitem") return "menuitem";
  if (el.getAttribute("role") === "tab") return "tab";
  if (tag === "BUTTON" || el.getAttribute("role") === "button") return "btn";
  return "text";
}

function chipCurrent(el: HTMLElement): string | undefined {
  const dim = classifyChip(textOf(el));
  if (!dim) return undefined;
  const inner = el.querySelector<HTMLElement>(".cur, [class*='current'], [class*='value']");
  const val = inner ? textOf(inner) : textOf(el).replace(/^[^：:]*[：:]/, "").trim();
  if (!val || /不限|全部/.test(val)) return undefined;
  return val;
}

function pageKind(): PageSnapshot["kind"] {
  const path = location.pathname.toLowerCase();
  const body = textOf(document.body);
  if (/请登录|登录后|手机号登录/.test(body)) return "login";
  if (/\/job_detail\//.test(path)) return "job_detail";
  if (document.querySelector(".job-card-wrapper, .job-primary, [ka='job-card']") || /\/jobs?(?:\.html|\/|$)|\/search|\/recommend/.test(path)) return "jobs";
  return "unknown";
}

function deriveCurrentQuery(elements: SnapshotElement[]): BossQueryContext {
  const q: BossQueryContext = { keyword: "", location: [], salary: [], jobTypes: [], workModes: [], experience: [], education: [], industries: [], companySizes: [], source: "unknown" };
  const search = document.querySelector<HTMLInputElement>("input[type='search'], input.search-input, [class*='search'] input");
  q.keyword = search?.value.trim() || "";
  for (const e of elements) {
    if (e.region !== "filter" || !e.text) continue;
    const dim = classifyChip(e.text);
    if (dim && e.current && Array.isArray(q[dim])) (q[dim] as string[]).push(e.current);
  }
  q.source = q.keyword || Object.values(q).some(v => Array.isArray(v) && v.length) ? "search" : "recommend";
  return q;
}

export function snapshotPage(): PageSnapshot {
  resetSnapshotRefs();
  const roots = ".search-condition, .job-filter, .filter-condition, .search-box, [class*='filter'], .job-box, [class*='chat'], .job-list, .pager, [class*='pager']";
  // 收集所有匹配的根节点（querySelector 只返回首个，会漏掉与 .job-list 同级的但落在后面的 .pager）。
  const scopes = Array.from(document.querySelectorAll<HTMLElement>(roots));
  const scopeEls = scopes.length ? scopes : [document.body];
  const candidate = "a, button, [role='button'], [role='option'], [role='menuitem'], [role='tab'], input, textarea, select, li, span, div";
  const raw = scopeEls.flatMap(scope => [...scope.querySelectorAll<HTMLElement>(candidate)])
    .filter(isVisibleEl)
    .filter(el => el.children.length === 0 || /INPUT|TEXTAREA|SELECT|BUTTON|A/.test(el.tagName) || el.getAttribute("role"))
    .filter(el => textOf(el).length > 0 && textOf(el).length <= 40);

  // 去重 + 分区计数 + 强制保留 filter/pager/chat
  const seenText = new Set<string>();
  const buckets: Record<SnapshotRegion, SnapshotElement[]> = { search: [], filter: [], pager: [], chat: [], job: [], other: [] };
  let id = 0;
  for (const el of raw) {
    const text = textOf(el);
    if (seenText.has(text)) continue;
    seenText.add(text);
    const region = regionOf(el);
    const bucket = buckets[region];
    if (region !== "filter" && region !== "pager" && region !== "chat" && bucket.length >= SNAPSHOT_BUDGET[region]) continue;
    const sid = String(id++);
    snapshotRefs.set(sid, el);
    bucket.push({ id: sid, role: roleOf(el), text: text.slice(0, 40), current: chipCurrent(el), checked: el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-checked") === "true" || (el as HTMLInputElement).checked === true, hint: (el as HTMLInputElement).placeholder || el.getAttribute("aria-label") || undefined, region });
  }
  const elements = [...buckets.filter, ...buckets.pager, ...buckets.chat, ...buckets.search, ...buckets.job, ...buckets.other];
  const currentQuery = deriveCurrentQuery(elements);
  return {
    snapshotId: newSnapshotId(),
    kind: pageKind(),
    url: location.href,
    path: location.pathname,
    currentQuery,
    summary: `${pageKind()} | 岗位×${buckets.job.length} | ${Object.entries(currentQuery).filter(([, v]) => Array.isArray(v) && v.length).map(([k, v]) => `${k}=${(v as string[]).join("/")}`).join(", ")}`,
    elements
  };
}

export function resolveRef(ref: string): HTMLElement | null {
  const el = snapshotRefs.get(ref);
  if (!el || !document.contains(el)) return null;
  return el;
}
