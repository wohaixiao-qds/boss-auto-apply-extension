import type { BossQueryContext, PageSnapshot, SnapshotElement, SnapshotRegion } from "../types";
import { parseBossJobsUrl } from "./boss-url";

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

// ref 必须绑定 snapshotId。控制页会定时读取页面上下文并生成观察快照，
// 如果所有快照共用一个数字 ref 表，控制页的读取就会覆盖 LLM 正在使用的 ref。
// 只保留最近若干批，避免旧 DOM 引用无限占用内存；动作执行使用 decision.snapshotId 精确取回。
const snapshotRefsById = new Map<string, Map<string, HTMLElement>>();
let activeSnapshotId = "";
// 覆盖 LLM 30 秒请求超时 + 控制页约 1.5 秒一次的观察轮询。
const MAX_SNAPSHOT_REF_BATCHES = 32;
export function resetSnapshotRefs(): void {
  snapshotRefsById.clear();
  activeSnapshotId = "";
}

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
  // BOSS 列表页的右侧详情与筛选栏处于同一 SPA 页面，不能只按祖先 class 判断。
  // 真实 DOM 中详情操作区是 .job-detail-*，沟通按钮是 .op-btn-chat/ka=cpc_job_list_chat_*；
  // 这些语义信号优先于可能误包含 filter 关键词的外层容器。
  if (el.matches(".op-btn-chat, [ka^='cpc_job_list_chat_']")
    || el.closest(".job-detail-op, .job-detail-header, .job-detail-box, .job-detail-container, [class*='job-detail']")) return "job";
  if (el.closest(".search-condition, .job-filter, .filter-condition, [class*='filter']")) return "filter";
  if (/pager|next|下一页/.test(`${cls} ${text}`) || el.closest(".pager, [class*='pager'], [class*='next']")) return "pager";
  // chat：排除 not-chat-router 这类含 "chat" 子串但语义为"非聊天路由"的顶部容器，避免导航被误判 chat。
  if (el.closest("[class*='chat']:not([class*='not-chat']), [class*='message-input'], [class*='communicate'], [class*='chat-input']")) return "chat";
  // job：用真实卡片 class（.job-card-wrap/.job-card-box），不再用裸 li（会把导航 li 误归 job）。
  if (el.closest(".job-card-wrap, .job-card-box, .job-card-wrapper, .job-primary, [ka='job-card'], [class*='job-card'], .job-list-container, .rec-job-list")) return "job";
  return "other";
}

function roleOf(el: HTMLElement): SnapshotElement["role"] {
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || el.getAttribute("contenteditable") === "true") return "input";
  if (tag === "SELECT") return "select";
  if (tag === "A") return "link";
  if (tag === "OPTION") return "option";
  if (el.getAttribute("role") === "option") return "option";
  if (el.getAttribute("role") === "menuitem") return "menuitem";
  if (el.getAttribute("role") === "tab") return "tab";
  if (tag === "BUTTON" || el.getAttribute("role") === "button") return "btn";
  return "text";
}

// 真实 BOSS 的筛选 chip 未选中时文本就是标签本身（如"薪资待遇"），没有独立值子元素。
// 标签词黑名单：取到的"值"若等于维度标签词，视为未选中，不污染 currentQuery。
const CHIP_LABEL_WORDS = /^(薪资待遇|薪资|薪水|求职类型|工作性质|工作经验|经验|学历要求|学历|公司行业|行业|公司规模|规模|城市|地点|工作方式|薪资范围|经验要求)$/;

function chipCurrent(el: HTMLElement): string | undefined {
  const dim = classifyChip(textOf(el));
  if (!dim) return undefined;
  const inner = el.querySelector<HTMLElement>(".cur, [class*='current'], [class*='value'], .filter-title-value, .filter-value");
  const full = textOf(el);
  const val = inner ? textOf(inner) : full.replace(/^[^：:]*[：:]/, "").trim();
  if (!val || /不限|全部/.test(val)) return undefined;
  if (val === full || CHIP_LABEL_WORDS.test(val)) return undefined; // 值=整个文本或=标签词 → 未选中
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
  const fromUrl = parseBossJobsUrl(location.href);
  const q: BossQueryContext = { ...fromUrl, location: [...fromUrl.location], salary: [...fromUrl.salary], jobTypes: [...fromUrl.jobTypes], workModes: [...fromUrl.workModes], experience: [...fromUrl.experience], education: [...fromUrl.education], industries: [...fromUrl.industries], companySizes: [...fromUrl.companySizes] };
  const search = document.querySelector<HTMLInputElement>("input[type='search'], input.search-input, [class*='search'] input");
  q.keyword = search?.value.trim() || fromUrl.keyword;
  for (const e of elements) {
    if (e.region !== "filter" || !e.text) continue;
    const dim = classifyChip(e.text);
    if (dim && e.current && Array.isArray(q[dim])) (q[dim] as string[]).push(e.current);
  }
  for (const key of ["location", "salary", "jobTypes", "workModes", "experience", "education", "industries", "companySizes"] as const) {
    q[key] = [...new Set(q[key])];
  }
  q.source = q.keyword || Object.values(q).some(v => Array.isArray(v) && v.length) ? "search" : "recommend";
  return q;
}

export function snapshotPage(): PageSnapshot {
  const snapshotId = newSnapshotId();
  const snapshotRefs = new Map<string, HTMLElement>();
  const roots = ".search-condition, .job-filter, .filter-condition, .search-box, [class*='filter'], .job-box, .job-list-container, [class*='job-list'], [class*='chat']:not([class*='not-chat']), .pager, [class*='pager']";
  // 收集所有匹配的根节点（querySelector 只返回首个，会漏掉与 .job-list 同级的但落在后面的 .pager）。
  const scopes = Array.from(document.querySelectorAll<HTMLElement>(roots));
  // BOSS 页面 class 经常变化：保留专用区域，同时始终扫描 body，避免筛选已生效但快照没有任何 ref。
  const scopeEls = scopes.length ? [...scopes, document.body] : [document.body];
  const candidate = "a, button, [role='button'], [role='option'], [role='menuitem'], [role='tab'], input, textarea, select, [contenteditable='true'], li, span, div";
  const raw = scopeEls.flatMap(scope => [...scope.querySelectorAll<HTMLElement>(candidate)])
    .filter(isVisibleEl)
    .filter(el => el.children.length === 0 || /INPUT|TEXTAREA|SELECT|BUTTON|A/.test(el.tagName) || el.getAttribute("role") || el.getAttribute("contenteditable") === "true")
    .filter(el => {
      // input/textarea/select 即使文本为空也保留（空打招呼框、空搜索框需要被 LLM 选中 fill），
      // 它们以 placeholder/aria-label 作为可读名；其它元素仍要求非空且 <=40 字。
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.getAttribute("contenteditable") === "true") return true;
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
    // BOSS 的右侧“立即沟通”可能被 regionOf 归入 job（它位于岗位详情容器内），
    // 而左侧岗位卡片会先消耗完 job 预算。这个控件是打招呼阶段的唯一入口，
    // 即使超出 job 预算也必须保留，否则 Runtime 的 DOM 校验通过后，下一轮快照
    // 又会看不到按钮并反复重新选择同一个岗位。
    const priorityGreetControl = /立即沟通|打招呼/.test(text);
    if (bucket.length >= SNAPSHOT_BUDGET[region] && !priorityGreetControl) continue;
    const sid = String(id++);
    snapshotRefs.set(sid, el);
    bucket.push({ id: sid, role: roleOf(el), text: text.slice(0, 40), current: chipCurrent(el), checked: el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-checked") === "true" || (el as HTMLInputElement).checked === true, hint, region });
  }
  const elements = [...buckets.filter, ...buckets.pager, ...buckets.chat, ...buckets.search, ...buckets.job, ...buckets.other];
  const currentQuery = deriveCurrentQuery(elements);
  snapshotRefsById.set(snapshotId, snapshotRefs);
  activeSnapshotId = snapshotId;
  while (snapshotRefsById.size > MAX_SNAPSHOT_REF_BATCHES) {
    const oldest = snapshotRefsById.keys().next().value;
    if (typeof oldest !== "string") break;
    snapshotRefsById.delete(oldest);
  }
  return {
    snapshotId,
    kind: pageKind(),
    url: location.href,
    path: location.pathname,
    currentQuery,
    summary: `${pageKind()} | 岗位×${buckets.job.length} | ${Object.entries(currentQuery).filter(([, v]) => Array.isArray(v) && v.length).map(([k, v]) => `${k}=${(v as string[]).join("/")}`).join(", ")}`,
    elements
  };
}

// id 体系容错：序列化给 LLM 看的是 [e0]，LLM 会回 ref="e0"；
// 但 snapshotRefs 的 key 是纯数字 "0"。这里统一去掉前缀，两种写法都能命中。
const refKey = (ref: string): string => String(ref).trim().replace(/^e/i, "");

export function resolveRef(ref: string, snapshotId?: string): HTMLElement | null {
  const refs = (snapshotId && snapshotRefsById.get(snapshotId))
    || snapshotRefsById.get(activeSnapshotId);
  const el = refs?.get(refKey(ref));
  if (!el || !document.contains(el)) return null;
  return el;
}
