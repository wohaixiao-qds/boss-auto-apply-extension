import type { AgentAction, AgentDecision, ApprovalRequest, Job, JobIntent, ProfileAnalysisResult, Settings } from "./types";

const DEFAULT_INTENT: JobIntent = { targetTitles: [], skills: [], locations: [], salary: "", workModes: [], summary: "" };
const DEFAULTS: Settings = {
  jobKeywords: "",
  excludeCompanies: "",
  targetLocations: "",
  targetSalary: "",
  workMode: "",
  jobTypes: "",
  workExperience: "",
  education: "",
  companyIndustries: "",
  companySizes: "",
  maxPages: "5",
  minMatchScore: "50",
  candidateProfileClean: "",
  jobIntent: DEFAULT_INTENT,
  profileSyncedAt: "",
  aiEnabled: true,
  agentAutoStart: true,
  aiBaseUrl: "https://api.openai.com/v1",
  aiModel: "gpt-4o-mini",
  aiApiKey: ""
};
const STORAGE_VERSION = 2;
const EMPTY_BOOTSTRAP_STATUS = { ok: true, message: "" };

async function ensureDefaults(): Promise<void> {
  const current = await chrome.storage.local.get({ ...DEFAULTS, storageVersion: STORAGE_VERSION });
  await chrome.storage.local.set({ ...DEFAULTS, ...current, storageVersion: STORAGE_VERSION });
}

void ensureDefaults();
chrome.runtime.onInstalled.addListener(() => void ensureDefaults());

chrome.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
  const respond = (promise: Promise<unknown>): true => {
    promise.then(sendResponse).catch((error: unknown) => sendResponse({ ok: false, error: sanitizeError(error instanceof Error ? error.message : String(error)) }));
    return true;
  };

  switch (message?.type) {
    case "GET_SETTINGS":
      return respond(chrome.storage.local.get(DEFAULTS));
    case "GET_BOOTSTRAP_STATUS":
      return respond(chrome.storage.local.get({ bootstrapStatus: EMPTY_BOOTSTRAP_STATUS }).then(({ bootstrapStatus }) => bootstrapStatus));
    case "GET_APPROVAL":
      return respond(chrome.storage.local.get({ pendingApproval: null, lastApproval: null }));
    case "REQUEST_APPROVAL": {
      const input = message.request || {};
      const approval: ApprovalRequest = {
        id: crypto.randomUUID(),
        action: String(input.action || "unknown"),
        title: String(input.title || "需要人工确认"),
        description: String(input.description || "Agent 请求执行一个需要用户确认的动作。"),
        createdAt: new Date().toISOString(),
        status: "pending"
      };
      return respond(chrome.storage.local.set({ pendingApproval: approval }).then(() => ({ ok: true, approval })));
    }
    case "RESOLVE_APPROVAL": {
      const status = message.status === "approved" ? "approved" : "rejected";
      return respond(chrome.storage.local.get({ pendingApproval: null }).then(({ pendingApproval }) => {
        if (!pendingApproval || pendingApproval.id !== message.id) throw new Error("确认请求已失效");
        const resolved = { ...pendingApproval, status } satisfies ApprovalRequest;
        return chrome.storage.local.set({ pendingApproval: null, lastApproval: resolved }).then(() => ({ ok: true, approval: resolved }));
      }));
    }
    case "SET_BOOTSTRAP_STATUS":
      return respond(chrome.storage.local.set({ bootstrapStatus: message.status || EMPTY_BOOTSTRAP_STATUS, agentState: message.status?.state || null }).then(() => ({ ok: true })));
    case "SAVE_SETTINGS":
      return respond(chrome.storage.local.set(message.settings).then(() => ({ ok: true })));
    case "CLEAR_IMPORTED_DATA":
      return respond(chrome.storage.local.set({
        candidateProfileClean: "",
        jobIntent: DEFAULT_INTENT,
        profileSyncedAt: "",
        lastScanResults: [],
        lastScanAt: "",
        bootstrapStatus: EMPTY_BOOTSTRAP_STATUS,
        agentState: null,
        pendingApproval: null,
        lastApproval: null
      }).then(() => ({ ok: true })));
    case "ANALYZE_PROFILE":
      return respond(analyzeAndStoreProfile(String(message.text || "")));
    case "PLAN_AGENT_ACTION":
      return respond(planAgentAction(message.context));
    case "RANK_JOBS":
      return respond(rankJobsWithAI(Array.isArray(message.jobs) ? message.jobs : []));
    case "SAVE_SCAN_RESULTS":
      return respond(chrome.storage.local.set({ lastScanResults: message.jobs || [], lastScanAt: new Date().toISOString() }).then(() => ({ ok: true })));
    case "GET_SCAN_RESULTS":
      return respond(chrome.storage.local.get({ lastScanResults: [], lastScanAt: "" }));
    case "TEST_AI_CONNECTION":
      return respond(testAiConnection(message.settings));
    case "NAVIGATE_SOURCE_TAB": {
      const tabId = sender.tab?.id;
      const target = String(message.url || "");
      let parsed: URL;
      try { parsed = new URL(target); } catch { sendResponse({ ok: false, error: "无效的导航地址" }); return false; }
      if (!tabId || !/(^|\.)zhipin\.com$/i.test(parsed.hostname)) {
        sendResponse({ ok: false, error: "只允许在 BOSS 页面内导航" });
        return false;
      }
      return respond(chrome.tabs.update(tabId, { url: parsed.href }).then(() => ({ ok: true, url: parsed.href })));
    }
    case "SET_AGENT_SOURCE_TAB": {
      const tabId = sender.tab?.id || null;
      return respond(chrome.storage.local.set({ agentSourceTabId: tabId }).then(() => ({ ok: Boolean(tabId) })));
    }
    case "OPEN_SIDE_PANEL": {
      const tabId = Number(message.tabId || sender.tab?.id);
      if (!tabId) {
        sendResponse({ ok: false, error: "没有找到当前 BOSS 标签页" });
        return false;
      }
      return respond(chrome.storage.local.set({ agentSourceTabId: tabId })
        .then(() => chrome.sidePanel.open({ tabId }))
        .then(() => ({ ok: true })));
    }
    default:
      return false;
  }
});

function aiEndpoint(settings: Settings): string {
  const base = (settings.aiBaseUrl || DEFAULTS.aiBaseUrl).replace(/\/+$/, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

async function callAi(settings: Settings, payload: Record<string, unknown>): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(aiEndpoint(settings), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.aiApiKey}` },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || `AI 请求失败（${response.status}）`);
    return data;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("AI 请求超时");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeError(message: string): string {
  return String(message || "请求失败").replace(/sk-[A-Za-z0-9_-]+/g, "sk-***");
}

function parseJson<T>(text: unknown): T {
  const raw = String(text || "{}").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try {
    return JSON.parse(raw) as T;
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1)) as T;
    throw new Error("AI 返回的不是有效 JSON");
  }
}

function localProfileAnalysis(text: string): ProfileAnalysisResult {
  const lines = [...new Set(text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length >= 2))];
  const valueAfter = (labels: string[]): string => {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const label = labels.find(item => line.includes(item));
      if (!label) continue;
      const inline = line.split(/[：:]/).slice(1).join(":").trim();
      if (inline) return inline;
      if (lines[index + 1]) return lines[index + 1];
    }
    return "";
  };
  const titles = valueAfter(["期望职位", "目标职位", "求职职位"]);
  const locations = valueAfter(["期望城市", "工作城市", "意向城市"]);
  const salary = valueAfter(["期望薪资", "薪资要求"]);
  const split = (value: string) => value.split(/[、,，/|]/).map(item => item.trim()).filter(Boolean);
  const skills = lines.filter(line => /React|Vue|Angular|Next|Nuxt|TypeScript|JavaScript|Python|FastAPI|LangGraph|RAG|LLM|Node/i.test(line)).slice(0, 30);
  return {
    cleanProfile: lines.slice(0, 160).join("\n"),
    summary: lines.slice(0, 8).join("；"),
    intent: { targetTitles: split(titles), skills, locations: split(locations), salary, workModes: [], summary: [titles, locations, salary].filter(Boolean).join(" · ") }
  };
}

function validProfileResult(value: unknown, fallback: ProfileAnalysisResult): ProfileAnalysisResult {
  const result = value as Partial<ProfileAnalysisResult> | null;
  const intent = result?.intent as Partial<JobIntent> | undefined;
  return {
    cleanProfile: typeof result?.cleanProfile === "string" ? result.cleanProfile : fallback.cleanProfile,
    summary: typeof result?.summary === "string" ? result.summary : fallback.summary,
    intent: {
      targetTitles: Array.isArray(intent?.targetTitles) ? intent.targetTitles.filter(item => typeof item === "string") : fallback.intent.targetTitles,
      skills: Array.isArray(intent?.skills) ? intent.skills.filter(item => typeof item === "string") : fallback.intent.skills,
      locations: Array.isArray(intent?.locations) ? intent.locations.filter(item => typeof item === "string") : fallback.intent.locations,
      salary: typeof intent?.salary === "string" ? intent.salary : fallback.intent.salary,
      workModes: Array.isArray(intent?.workModes) ? intent.workModes.filter(item => typeof item === "string") : fallback.intent.workModes,
      summary: typeof intent?.summary === "string" ? intent.summary : fallback.intent.summary
    }
  };
}

async function analyzeAndStoreProfile(text: string): Promise<{ ok: boolean; profile: string; summary: string; intent: JobIntent; usedFallback?: boolean }> {
  const local = localProfileAnalysis(text);
  const settings = await chrome.storage.local.get(DEFAULTS) as Settings;
  let result = local;
  let usedFallback = false;
  if (settings.aiEnabled && settings.aiApiKey) {
    try {
      const data = await callAi(settings, {
        model: settings.aiModel || DEFAULTS.aiModel,
        temperature: 0.1,
        messages: [
          { role: "system", content: "你是求职资料分析器。清理网页噪声，只保留候选人的真实简历信息，并分析求职意向。只返回 JSON：{\"cleanProfile\":\"\",\"summary\":\"\",\"intent\":{\"targetTitles\":[],\"skills\":[],\"locations\":[],\"salary\":\"\",\"workModes\":[],\"summary\":\"\"}}。不要虚构资料。" },
          { role: "user", content: text.slice(0, 12000) }
        ]
      });
      result = validProfileResult(parseJson(data?.choices?.[0]?.message?.content), local);
    } catch {
      usedFallback = true;
    }
  }
  const intent = result.intent || local.intent;
  await chrome.storage.local.set({
    candidateProfileClean: result.cleanProfile || local.cleanProfile,
    jobIntent: intent,
    profileSyncedAt: new Date().toISOString()
  });
  return { ok: true, profile: result.cleanProfile || local.cleanProfile, summary: result.summary || local.summary, intent, usedFallback };
}

async function rankJobsWithAI(jobs: Job[]): Promise<{ ok: boolean; ranking?: Array<{ url: string; score: number; reason: string }>; reason?: string }> {
  const settings = await chrome.storage.local.get(DEFAULTS) as Settings;
  if (!jobs.length || !settings.aiEnabled || !settings.aiApiKey) return { ok: false, reason: "AI 未配置，使用规则筛选" };
  try {
    const data = await callAi(settings, {
      model: settings.aiModel || DEFAULTS.aiModel,
      temperature: 0.2,
      messages: [
        { role: "system", content: "你是求职岗位筛选器。基于候选人简历、求职意向和用户筛选条件给岗位打分。用户筛选条件是硬约束，岗位明显不符合时应降低分数或过滤。只返回 JSON：{\"ranking\":[{\"url\":\"原 URL\",\"score\":0,\"reason\":\"不超过40字理由\"}]}，覆盖每个输入岗位，不得虚构。" },
        { role: "user", content: JSON.stringify({ profile: settings.candidateProfileClean, intent: settings.jobIntent, filters: { jobKeywords: settings.jobKeywords, targetLocations: settings.targetLocations, targetSalary: settings.targetSalary, jobTypes: settings.jobTypes, workExperience: settings.workExperience, education: settings.education, companyIndustries: settings.companyIndustries, companySizes: settings.companySizes, workMode: settings.workMode, excludeCompanies: settings.excludeCompanies }, jobs: jobs.slice(0, 40).map(({ title, company, salary, location, description, url }) => ({ title, company, salary, location, description, url })) }) }
      ]
    });
    const parsed = parseJson<{ ranking?: Array<{ url: string; score: number; reason: string }> }>(data?.choices?.[0]?.message?.content);
    const urls = new Set(jobs.map(job => job.url));
    const ranking = Array.isArray(parsed.ranking)
      ? parsed.ranking.filter(item => urls.has(item.url) && Number.isFinite(item.score)).map(item => ({ ...item, score: Math.max(0, Math.min(100, Math.round(item.score))) }))
      : [];
    return { ok: true, ranking };
  } catch (error) {
    return { ok: false, reason: sanitizeError(error instanceof Error ? error.message : String(error)) };
  }
}

const AGENT_ACTIONS: AgentAction[] = [
  "click", "fill", "select", "scroll", "next_page", "open_jobs", "apply_filters",
  "collect_jobs", "filter_jobs", "rank_jobs", "finish", "pause"
];

function validAgentDecision(value: unknown): AgentDecision {
  const raw = value as Partial<AgentDecision> | null;
  const action = AGENT_ACTIONS.includes(raw?.action as AgentAction) ? raw?.action as AgentAction : "pause";
  const confidence = Number(raw?.confidence);
  return {
    action,
    reason: typeof raw?.reason === "string" ? raw.reason.slice(0, 240) : "LLM 没有给出动作理由",
    expected: typeof raw?.expected === "string" ? raw.expected.slice(0, 240) : "重新观察页面",
    target: typeof raw?.target === "string" ? raw.target.slice(0, 120) : undefined,
    value: typeof raw?.value === "string" ? raw.value.slice(0, 500) : undefined,
    direction: raw?.direction === "up" || raw?.direction === "down" ? raw.direction : undefined,
    amount: Number.isFinite(Number(raw?.amount)) ? Math.max(100, Math.min(1200, Number(raw?.amount))) : undefined,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : undefined
  };
}

async function planAgentAction(input: unknown): Promise<{ ok: boolean; decision?: AgentDecision; reason?: string }> {
  const settings = await chrome.storage.local.get(DEFAULTS) as Settings;
  if (!settings.aiEnabled || !settings.aiApiKey) return { ok: false, reason: "Agent 需要先配置可用的 LLM API" };
  try {
    const data = await callAi(settings, {
      model: settings.aiModel || DEFAULTS.aiModel,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: `你是运行在 Chrome 扩展中的浏览器 Agent。你的任务是根据用户目标和当前页面观察结果，判断下一步最合理的动作。不要假设固定流程，不要编造页面上不存在的元素；每次只选择一个动作，执行后会重新观察页面。

可用动作：
${AGENT_ACTIONS.map(action => `- ${action}`).join("\n")}

动作规则：
- click：点击页面上与 target 描述匹配的可见控件
- fill：向 target 描述的输入框填写 value
- select：打开 target 描述的筛选控件并选择 value
- scroll：向 direction 滚动 amount 像素
- next_page：点击下一页并等待页面变化
- open_jobs：从当前页面寻找职位列表入口
- apply_filters：当需要一次性应用多个已知条件时使用；优先使用 fill/select 逐个操作
- collect_jobs：读取当前页面和后续页面中的岗位
- filter_jobs：按照用户硬约束过滤已收集岗位
- rank_jobs：对剩余岗位进行匹配排序
- finish：目标已经完成
- pause：需要登录、缺少目标、页面不确定或需要人工确认

只返回 JSON，不要 Markdown：{"action":"...","target":"...","value":"...","direction":"down","amount":500,"reason":"...","expected":"...","confidence":0.0}`
        },
        { role: "user", content: JSON.stringify(input) }
      ]
    });
    const decision = validAgentDecision(parseJson(data?.choices?.[0]?.message?.content));
    return { ok: true, decision };
  } catch (error) {
    return { ok: false, reason: sanitizeError(error instanceof Error ? error.message : String(error)) };
  }
}

async function testAiConnection(inputSettings?: Settings): Promise<{ ok: boolean; model?: string; endpoint?: string; reply?: string; error?: string }> {
  const settings = inputSettings || await chrome.storage.local.get(DEFAULTS) as Settings;
  if (!settings.aiApiKey) return { ok: false, error: "未填写 API Key" };
  const data = await callAi(settings, { model: settings.aiModel || DEFAULTS.aiModel, temperature: 0, max_tokens: 12, messages: [{ role: "user", content: "只回复：连接成功" }] });
  return { ok: true, model: settings.aiModel, endpoint: aiEndpoint(settings), reply: data?.choices?.[0]?.message?.content || "" };
}
