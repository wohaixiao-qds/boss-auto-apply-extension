import { BOSS_OPTIONS } from "./agent/boss-options";

// input 类字段（自由文本）；5 个下拉维度走 checkbox（见 BOSS_OPTIONS），不在 fields 里。
const fields = ["jobKeywords", "targetLocations", "workMode", "companyIndustries", "maxPages", "excludeCompanies", "minMatchScore", "aiBaseUrl", "aiModel", "aiApiKey", "costThresholdYuan", "inputPriceYuanPerMillion", "outputPriceYuanPerMillion", "greetCap", "greetMessage"] as const;
type Field = typeof fields[number];
type CheckField = "jobTypes" | "targetSalary" | "workExperience" | "education" | "companySizes";

function input(id: string): HTMLInputElement | HTMLTextAreaElement {
  return document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
}

// 渲染 checkbox 组并按已存值勾选
function renderCheckGroups(settings: Record<string, any>): void {
  for (const { field, options } of BOSS_OPTIONS) {
    const group = document.getElementById(`${field}Group`);
    if (!group) continue;
    const stored = String(settings[field] || "").split(/\r?\n|[,，、]/).map(s => s.trim()).filter(Boolean);
    group.innerHTML = options.map(opt => `<label><input type="checkbox" value="${opt.replace(/"/g, "&quot;")}" ${stored.includes(opt) ? "checked" : ""}/> ${opt}</label>`).join("");
  }
}

function readCheckFields(): Record<CheckField, string> {
  const out = {} as Record<CheckField, string>;
  for (const { field } of BOSS_OPTIONS) {
    const checked = [...document.querySelectorAll<HTMLInputElement>(`#${field}Group input[type='checkbox']:checked`)].map(el => el.value);
    out[field] = checked.join("、");
  }
  return out;
}

function readSettings(): Record<Field | CheckField | "agentAutoStart" | "aiEnabled", string | boolean> {
  return {
    ...Object.fromEntries(fields.map(id => [id, input(id).value.trim()])),
    ...readCheckFields(),
    agentAutoStart: (document.getElementById("agentAutoStart") as HTMLInputElement).checked,
    aiEnabled: (document.getElementById("aiEnabled") as HTMLInputElement).checked
  } as Record<Field | CheckField | "agentAutoStart" | "aiEnabled", string | boolean>;
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
    fields.forEach(id => { input(id).value = settings[id] || ""; });
    renderCheckGroups(settings);
    (document.getElementById("agentAutoStart") as HTMLInputElement).checked = Boolean(settings.agentAutoStart);
    (document.getElementById("aiEnabled") as HTMLInputElement).checked = Boolean(settings.aiEnabled);
  } catch { document.getElementById("status")!.textContent = "插件刚刚更新，请重新打开设置页"; }
}

document.getElementById("save")?.addEventListener("click", async () => {
  try {
    const settings = readSettings();
    if (settings.aiEnabled) await requestAiOriginPermission();
    await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
    document.getElementById("status")!.textContent = "已保存";
  } catch (error) { document.getElementById("status")!.textContent = error instanceof Error ? error.message : String(error); }
});

document.getElementById("testAi")?.addEventListener("click", async () => {
  const status = document.getElementById("status")!;
  status.textContent = "测试中…";
  try {
    const settings = readSettings();
    await requestAiOriginPermission();
    const result = await chrome.runtime.sendMessage({ type: "TEST_AI_CONNECTION", settings }) as { ok?: boolean; model?: string; error?: string };
    status.textContent = result?.ok ? `连接成功：${result.model}` : `连接失败：${result?.error || "未知错误"}`;
  } catch (error) { status.textContent = `连接失败：${error instanceof Error ? error.message : String(error)}`; }
});

void load();
