import { BOSS_OPTIONS } from "./agent/boss-options";

const fields = ["maxPages", "aiBaseUrl", "aiModel", "aiApiKey", "costThresholdYuan", "inputPriceYuanPerMillion", "outputPriceYuanPerMillion", "greetCap", "greetMessage"] as const;
type Field = typeof fields[number];
type FilterField = "jobKeywords" | "targetLocations" | "targetSalary" | "jobTypes" | "workMode" | "workExperience" | "education" | "companyIndustries" | "companySizes" | "excludeCompanies";

const filterFields: FilterField[] = [
  "jobKeywords", "targetLocations", "targetSalary", "jobTypes", "workMode",
  "workExperience", "education", "companyIndustries", "companySizes", "excludeCompanies"
];

const filterLabels: Record<FilterField, string> = {
  jobKeywords: "岗位关键词",
  targetLocations: "目标城市",
  targetSalary: "期望薪资",
  jobTypes: "求职类型",
  workMode: "工作方式",
  workExperience: "工作经验",
  education: "学历要求",
  companyIndustries: "公司行业",
  companySizes: "公司规模",
  excludeCompanies: "排除公司"
};

const fallbackOptions: Record<FilterField, string[]> = {
  jobKeywords: ["前端", "后端", "全栈", "Java", "Python", "TypeScript", "AI 应用"],
  targetLocations: ["北京", "上海", "广州", "深圳", "杭州", "成都", "南京", "武汉", "苏州", "西安"],
  targetSalary: [],
  jobTypes: [],
  workMode: ["现场办公", "混合办公", "远程"],
  workExperience: [],
  education: [],
  companyIndustries: ["互联网", "软件", "人工智能", "金融", "教育", "医疗", "制造", "电商"],
  companySizes: [],
  excludeCompanies: []
};

const collectedKeyByField: Partial<Record<FilterField, string>> = {
  targetLocations: "location",
  targetSalary: "salary",
  jobTypes: "jobTypes",
  workExperience: "experience",
  education: "education",
  companyIndustries: "industries",
  companySizes: "companySizes"
};

type CollectedOption = { text?: string } | string;
type CollectedOptions = Record<string, CollectedOption[]>;

const selectedValues = new Map<FilterField, Set<string>>();
const optionValues = new Map<FilterField, string[]>();

function input(id: string): HTMLInputElement | HTMLTextAreaElement {
  return document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
}

function parseValues(value: unknown): string[] {
  return String(value || "")
    .split(/\r?\n|[,，、]/)
    .map(item => item.trim())
    .filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function collectedValues(field: FilterField, collected: CollectedOptions): string[] {
  const key = collectedKeyByField[field];
  if (!key) return [];
  return (Array.isArray(collected[key]) ? collected[key] : [])
    .map(option => typeof option === "string" ? option : option?.text || "")
    .filter(Boolean) as string[];
}

function optionsFor(field: FilterField, settings: Record<string, any>, collected: CollectedOptions): string[] {
  const fixed = BOSS_OPTIONS.find(item => item.field === field)?.options || [];
  return unique([
    ...fallbackOptions[field],
    ...fixed,
    ...collectedValues(field, collected),
    ...parseValues(settings[field])
  ]);
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
  const selected = selectedValues.get(field) || new Set<string>();
  const options = optionValues.get(field) || [];
  if (!root) return;

  const triggerText = root.querySelector<HTMLElement>(".selection-text");
  const selectedList = [...selected];
  if (triggerText) {
    triggerText.textContent = selectedList.length
      ? selectedList.length <= 2 ? selectedList.join("、") : `${selectedList.slice(0, 2).join("、")} 等 ${selectedList.length} 项`
      : `请选择${filterLabels[field]}`;
    triggerText.classList.toggle("empty", selectedList.length === 0);
  }

  const search = root.querySelector<HTMLInputElement>(".multi-select-search");
  const query = (search?.value || "").trim().toLowerCase();
  const visibleOptions = options.filter(option => !query || option.toLowerCase().includes(query));
  const optionList = root.querySelector<HTMLElement>(".multi-select-options");
  if (optionList) {
    optionList.innerHTML = visibleOptions.length
      ? visibleOptions.map(option => `<label class="multi-select-option"><input type="checkbox" value="${escapeHtml(option)}" ${selected.has(option) ? "checked" : ""} /> <span>${escapeHtml(option)}</span></label>`).join("")
      : `<p class="multi-select-empty">没有匹配项，可以添加自定义内容</p>`;
  }

  const addButton = root.querySelector<HTMLButtonElement>(".multi-select-add");
  const canAdd = Boolean(query && !options.some(option => option.toLowerCase() === query));
  if (addButton) {
    addButton.classList.toggle("visible", canAdd);
    addButton.textContent = canAdd ? `添加“${search?.value.trim() || query}”` : "";
  }
}

function renderMultiSelects(settings: Record<string, any>, collected: CollectedOptions): void {
  for (const field of filterFields) {
    const root = document.getElementById(`${field}Select`);
    if (!root) continue;
    const options = optionsFor(field, settings, collected);
    optionValues.set(field, options);
    selectedValues.set(field, new Set(parseValues(settings[field])));
    root.innerHTML = `
      <button type="button" class="multi-select-trigger" aria-haspopup="listbox" aria-expanded="false">
        <span class="selection-text empty">请选择${filterLabels[field]}</span><span class="chevron" aria-hidden="true">⌄</span>
      </button>
      <div class="multi-select-panel" hidden>
        <input class="multi-select-search" type="search" placeholder="搜索或添加${filterLabels[field]}" autocomplete="off" />
        <div class="multi-select-options" role="listbox" aria-multiselectable="true"></div>
        <button type="button" class="multi-select-add">添加自定义内容</button>
      </div>`;

    const trigger = root.querySelector<HTMLButtonElement>(".multi-select-trigger")!;
    const panel = root.querySelector<HTMLElement>(".multi-select-panel")!;
    const search = root.querySelector<HTMLInputElement>(".multi-select-search")!;
    const optionList = root.querySelector<HTMLElement>(".multi-select-options")!;
    const addButton = root.querySelector<HTMLButtonElement>(".multi-select-add")!;

    trigger.addEventListener("click", () => {
      const open = !root.classList.contains("open");
      closeAll(root);
      root.classList.toggle("open", open);
      panel.hidden = !open;
      trigger.setAttribute("aria-expanded", String(open));
      if (open) window.setTimeout(() => search.focus(), 0);
    });
    search.addEventListener("input", () => renderField(field));
    optionList.addEventListener("change", event => {
      const checkbox = event.target as HTMLInputElement;
      if (checkbox.type !== "checkbox") return;
      const selected = selectedValues.get(field) || new Set<string>();
      if (checkbox.checked) selected.add(checkbox.value); else selected.delete(checkbox.value);
      selectedValues.set(field, selected);
      renderField(field);
    });
    addButton.addEventListener("click", () => {
      const value = search.value.trim();
      if (!value) return;
      const optionsForField = optionValues.get(field) || [];
      if (!optionsForField.includes(value)) optionsForField.push(value);
      optionValues.set(field, optionsForField);
      const selected = selectedValues.get(field) || new Set<string>();
      selected.add(value);
      selectedValues.set(field, selected);
      search.value = "";
      renderField(field);
      search.focus();
    });
    renderField(field);
  }
}

function readMultiSelects(): Record<FilterField, string> {
  return Object.fromEntries(filterFields.map(field => [field, [...(selectedValues.get(field) || [])].join("、")])) as Record<FilterField, string>;
}

function readSettings(): Record<Field | FilterField | "agentAutoStart" | "aiEnabled", string | boolean> {
  return {
    ...Object.fromEntries(fields.map(id => [id, input(id).value.trim()])),
    ...readMultiSelects(),
    agentAutoStart: (document.getElementById("agentAutoStart") as HTMLInputElement).checked,
    aiEnabled: (document.getElementById("aiEnabled") as HTMLInputElement).checked
  } as Record<Field | FilterField | "agentAutoStart" | "aiEnabled", string | boolean>;
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
    const [settings, stored] = await Promise.all([
      chrome.runtime.sendMessage({ type: "GET_SETTINGS" }) as Promise<Record<string, any>>,
      chrome.storage.local.get({ filterOptions: {} }) as Promise<{ filterOptions?: CollectedOptions }>
    ]);
    fields.forEach(id => { input(id).value = settings[id] || ""; });
    renderMultiSelects(settings, stored.filterOptions || {});
    (document.getElementById("agentAutoStart") as HTMLInputElement).checked = Boolean(settings.agentAutoStart);
    (document.getElementById("aiEnabled") as HTMLInputElement).checked = Boolean(settings.aiEnabled);
  } catch { document.getElementById("status")!.textContent = "插件刚刚更新，请重新打开设置页"; }
}

document.addEventListener("click", event => {
  const target = event.target as HTMLElement;
  if (!target.closest(".multi-select")) closeAll();
});

document.getElementById("save")?.addEventListener("click", async () => {
  try {
    const settings = readSettings();
    if (settings.aiEnabled) await requestAiOriginPermission();
    await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
    document.getElementById("status")!.textContent = "已保存岗位筛选设置";
  } catch (error) { document.getElementById("status")!.textContent = error instanceof Error ? error.message : String(error); }
});

document.getElementById("testAi")?.addEventListener("click", async () => {
  const el = document.getElementById("testAiStatus")!;
  el.textContent = "测试中…"; el.className = "test-status";
  try {
    const settings = readSettings();
    await requestAiOriginPermission();
    const result = await chrome.runtime.sendMessage({ type: "TEST_AI_CONNECTION", settings }) as { ok?: boolean; model?: string; error?: string };
    el.textContent = result?.ok ? `✓ 连接成功：${result.model}` : `✗ 连接失败：${result?.error || "未知错误"}`;
    el.className = `test-status ${result?.ok ? "ok" : "err"}`;
  } catch (error) { el.textContent = `✗ 连接失败：${error instanceof Error ? error.message : String(error)}`; el.className = "test-status err"; }
});

void load();
