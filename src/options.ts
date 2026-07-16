import { BOSS_OPTIONS } from "./agent/boss-options";

const directFields = ["jobKeywords", "maxPages", "aiBaseUrl", "aiModel", "aiApiKey", "costThresholdYuan", "inputPriceYuanPerMillion", "outputPriceYuanPerMillion", "greetCap", "greetMessage"] as const;
type DirectField = typeof directFields[number];
type FilterField = "targetLocations" | "targetSalary" | "jobTypes" | "workExperience" | "education" | "companyIndustries" | "companySizes";
const filterFields: FilterField[] = ["targetLocations", "targetSalary", "jobTypes", "workExperience", "education", "companyIndustries", "companySizes"];

const filterLabels: Record<FilterField, string> = {
  targetLocations: "目标城市", targetSalary: "期望薪资", jobTypes: "求职类型", workExperience: "工作经验",
  education: "学历要求", companyIndustries: "公司行业", companySizes: "公司规模"
};

const fallbackOptions: Record<FilterField, string[]> = {
  targetLocations: ["北京", "上海", "广州", "深圳", "杭州", "成都", "南京", "武汉", "苏州", "西安"],
  targetSalary: [], jobTypes: [], workExperience: [], education: [],
  companyIndustries: ["互联网", "软件", "人工智能", "金融", "教育", "医疗", "制造", "电商"],
  companySizes: []
};

const selectedValues = new Map<FilterField, Set<string>>();
const optionValues = new Map<FilterField, string[]>();

function input(id: string): HTMLInputElement | HTMLTextAreaElement {
  return document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
}

function parseValues(value: unknown): string[] {
  return String(value || "").split(/\r?\n|[,，、]/).map(item => item.trim()).filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function optionsFor(field: FilterField, settings: Record<string, any>): string[] {
  const fixed = BOSS_OPTIONS.find(item => item.field === field)?.options || [];
  return unique([...fallbackOptions[field], ...fixed, ...parseValues(settings[field])]);
}

function closeAll(except?: HTMLElement): void {
  document.querySelectorAll<HTMLElement>(".multi-select.open").forEach(root => {
    if (root === except) return;
    root.classList.remove("open");
    const panel = root.querySelector<HTMLElement>(".multi-select-panel");
    if (panel) panel.hidden = true;
  });
}

function renderField(field: FilterField): void {
  const root = document.getElementById(`${field}Select`);
  if (!root) return;
  const selected = selectedValues.get(field) || new Set<string>();
  const triggerText = root.querySelector<HTMLElement>(".selection-text");
  const values = [...selected];
  if (triggerText) {
    triggerText.textContent = values.length <= 2 ? values.join("、") || `请选择${filterLabels[field]}` : `${values.slice(0, 2).join("、")} 等 ${values.length} 项`;
    triggerText.classList.toggle("empty", values.length === 0);
  }
  const search = root.querySelector<HTMLInputElement>(".multi-select-search");
  const query = (search?.value || "").trim().toLowerCase();
  const options = (optionValues.get(field) || []).filter(option => !query || option.toLowerCase().includes(query));
  const list = root.querySelector<HTMLElement>(".multi-select-options");
  if (list) list.innerHTML = options.length
    ? options.map(option => `<label class="multi-select-option"><input type="checkbox" value="${escapeHtml(option)}" ${selected.has(option) ? "checked" : ""} /> <span>${escapeHtml(option)}</span></label>`).join("")
    : `<p class="multi-select-empty">没有匹配项</p>`;
}

function renderMultiSelects(settings: Record<string, any>): void {
  for (const field of filterFields) {
    const root = document.getElementById(`${field}Select`);
    if (!root) continue;
    optionValues.set(field, optionsFor(field, settings));
    selectedValues.set(field, new Set(parseValues(settings[field])));
    root.innerHTML = `<button type="button" class="multi-select-trigger" aria-haspopup="listbox" aria-expanded="false"><span class="selection-text empty">请选择${filterLabels[field]}</span><span class="chevron" aria-hidden="true">⌄</span></button><div class="multi-select-panel" hidden><input class="multi-select-search" type="search" placeholder="搜索${filterLabels[field]}" autocomplete="off" /><div class="multi-select-options" role="listbox" aria-multiselectable="true"></div></div>`;
    const trigger = root.querySelector<HTMLButtonElement>(".multi-select-trigger")!;
    const panel = root.querySelector<HTMLElement>(".multi-select-panel")!;
    const search = root.querySelector<HTMLInputElement>(".multi-select-search")!;
    const list = root.querySelector<HTMLElement>(".multi-select-options")!;
    trigger.addEventListener("click", () => {
      const open = !root.classList.contains("open");
      closeAll(root); root.classList.toggle("open", open); panel.hidden = !open; trigger.setAttribute("aria-expanded", String(open));
      if (open) window.setTimeout(() => search.focus(), 0);
    });
    search.addEventListener("input", () => renderField(field));
    list.addEventListener("change", event => {
      const checkbox = event.target as HTMLInputElement;
      if (checkbox.type !== "checkbox") return;
      const selected = selectedValues.get(field) || new Set<string>();
      if (checkbox.checked) selected.add(checkbox.value); else selected.delete(checkbox.value);
      selectedValues.set(field, selected); renderField(field);
    });
    renderField(field);
  }
}

function readSettings(): Record<DirectField | FilterField | "agentAutoStart" | "aiEnabled", string | boolean> {
  return {
    ...Object.fromEntries(directFields.map(id => [id, input(id).value.trim()])),
    ...Object.fromEntries(filterFields.map(field => [field, [...(selectedValues.get(field) || [])].join("、")])),
    agentAutoStart: (document.getElementById("agentAutoStart") as HTMLInputElement).checked,
    aiEnabled: (document.getElementById("aiEnabled") as HTMLInputElement).checked
  } as Record<DirectField | FilterField | "agentAutoStart" | "aiEnabled", string | boolean>;
}

async function requestAiOriginPermission(): Promise<void> {
  const value = input("aiBaseUrl").value.trim();
  if (!value) return;
  const url = new URL(value);
  const granted = await chrome.permissions.request({ origins: [`${url.protocol}//${url.host}/*`] });
  if (!granted) throw new Error("未获得中转地址访问权限");
}

async function load(): Promise<void> {
  try {
    const settings = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" }) as Record<string, any>;
    directFields.forEach(id => { input(id).value = settings[id] || ""; });
    renderMultiSelects(settings);
    (document.getElementById("agentAutoStart") as HTMLInputElement).checked = Boolean(settings.agentAutoStart);
    (document.getElementById("aiEnabled") as HTMLInputElement).checked = Boolean(settings.aiEnabled);
  } catch { document.getElementById("status")!.textContent = "插件刚刚更新，请重新打开设置页"; }
}

document.addEventListener("click", event => { if (!(event.target as HTMLElement).closest(".multi-select")) closeAll(); });

document.getElementById("save")?.addEventListener("click", async () => {
  try {
    const settings = readSettings();
    if (settings.aiEnabled) await requestAiOriginPermission();
    await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
    document.getElementById("status")!.textContent = "已保存岗位筛选设置";
  } catch (error) { document.getElementById("status")!.textContent = error instanceof Error ? error.message : String(error); }
});

document.getElementById("testAi")?.addEventListener("click", async () => {
  const el = document.getElementById("testAiStatus")!; el.textContent = "测试中…"; el.className = "test-status";
  try {
    const settings = readSettings(); await requestAiOriginPermission();
    const result = await chrome.runtime.sendMessage({ type: "TEST_AI_CONNECTION", settings }) as { ok?: boolean; model?: string; error?: string };
    el.textContent = result?.ok ? `✓ 连接成功：${result.model}` : `✗ 连接失败：${result?.error || "未知错误"}`; el.className = `test-status ${result?.ok ? "ok" : "err"}`;
  } catch (error) { el.textContent = `✗ 连接失败：${error instanceof Error ? error.message : String(error)}`; el.className = "test-status err"; }
});

void load();
