const fields = ["jobKeywords", "targetLocations", "targetSalary", "workMode", "jobTypes", "workExperience", "education", "companyIndustries", "companySizes", "maxPages", "excludeCompanies", "minMatchScore", "aiBaseUrl", "aiModel", "aiApiKey"] as const;
type Field = typeof fields[number];

function input(id: string): HTMLInputElement | HTMLTextAreaElement {
  return document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
}

function readSettings(): Record<Field | "agentAutoStart" | "aiEnabled", string | boolean> {
  return {
    ...Object.fromEntries(fields.map(id => [id, input(id).value.trim()])),
    agentAutoStart: (document.getElementById("agentAutoStart") as HTMLInputElement).checked,
    aiEnabled: (document.getElementById("aiEnabled") as HTMLInputElement).checked
  } as Record<Field | "agentAutoStart" | "aiEnabled", string | boolean>;
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
