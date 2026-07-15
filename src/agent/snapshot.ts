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
  // 真实浏览器下，BOSS 常用 max-height:0/height:0 折叠下拉面板（而非 display:none），
  // 必须用 width/height>0 的几何门槛排除这些隐藏元素，避免污染快照预算与向 LLM 暴露幽灵 ref。
  const r = el.getBoundingClientRect();
  return Boolean(r && r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden");
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
    .filter(el => {
      // input/textarea/select 即使文本为空也保留（空打招呼框、空搜索框需要被 LLM 选中 fill），
      // 它们以 placeholder/aria-label 作为可读名；其它元素仍要求非空且 <=40 字。
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      const t = textOf(el);
      return t.length > 0 && t.length <= 40;
    });

  // 去重 + 分区计数 + 强制保留 filter/pager/chat
  // 去重 key: input 类元素可能多个都 text=""（如多个空输入框），单纯按 text 去重会互相吞并。
  // 对这类元素并入 hint(placeholder/aria-label)/region/tag，保证不同空输入框各自保留。
  const seenText = new Set<string>();
  const buckets: Record<SnapshotRegion, SnapshotElement[]> = { search: [], filter: [], pager: [], chat: [], job: [], other: [] };
  let id = 0;
  for (const el of raw) {
    const text = textOf(el);
    const tag = el.tagName;
    const isInputLike = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    const hint = (el as HTMLInputElement).placeholder || el.getAttribute("aria-label") || undefined;
    const region = regionOf(el);
    // P1-005：普通元素不能只按 text 去重——多个“确定/发送/沟通”或相同岗位标题会被合并。
    // 并入 region/tag/hint/父级 class 片段，让不同上下文的同名控件各自保留。
    const parentCls = (el.parentElement?.className?.toString() || "").slice(0, 24);
    const dedupeKey = `${text}|${region}|${tag}|${hint || ""}|${parentCls}`;
    if (seenText.has(dedupeKey)) continue;
    seenText.add(dedupeKey);
    const bucket = buckets[region];
    // P2-001：所有 region 都按各自预算截断（filter/pager/chat 不再无限保留，避免 payload 膨胀）。
    // filter/pager/chat 的预算已设得较宽松（见 SNAPSHOT_BUDGET），优先级靠排序前的强制保留保证。
    if (bucket.length >= SNAPSHOT_BUDGET[region]) continue;
    const sid = String(id++);
    snapshotRefs.set(sid, el);
    bucket.push({ id: sid, role: roleOf(el), text: text.slice(0, 40), current: chipCurrent(el), checked: el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-checked") === "true" || (el as HTMLInputElement).checked === true, hint, region });
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
