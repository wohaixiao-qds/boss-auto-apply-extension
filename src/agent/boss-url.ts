import type { BossQueryContext, Settings } from "../types";

export interface CollectedUrlOption {
  text?: string;
  code?: string;
  sourceKey?: string;
}

export type CollectedUrlOptions = Record<string, CollectedUrlOption[]>;

export interface BossUrlBuildResult {
  url: string;
  applied: string[];
  missing: string[];
  unsupported: string[];
}

const STATIC_CODES: Record<string, Record<string, string>> = {
  jobTypes: { "不限": "0", "全职": "1901", "兼职": "1903" },
  salary: { "不限": "0", "3K以下": "402", "3-5K": "403", "5-10K": "404", "10-20K": "405", "20-50K": "406", "50K以上": "407" },
  experience: { "不限": "0", "在校生": "108", "应届生": "102", "经验不限": "101", "1年以内": "103", "1-3年": "104", "3-5年": "105", "5-10年": "106", "10年以上": "107" },
  education: { "不限": "0", "初中及以下": "209", "中专/中技": "208", "高中": "206", "大专": "202", "本科": "203", "硕士": "204", "博士": "205" },
  companySizes: { "不限": "0", "0-20人": "301", "20-99人": "302", "100-499人": "303", "500-999人": "304", "1000-9999人": "305", "10000人以上": "306" }
};

const CITY_CODES: Record<string, string> = {
  北京: "101010100", 上海: "101020100", 天津: "101030100", 重庆: "101040100",
  西安: "101110100", 杭州: "101210100", 南京: "101190100", 武汉: "101200100",
  成都: "101270100", 广州: "101280100", 深圳: "101280600", 郑州: "101180100",
  苏州: "101190400", 厦门: "101230200", 长沙: "101250100"
};

const CITY_NAMES = Object.fromEntries(Object.entries(CITY_CODES).map(([name, code]) => [code, name]));

const splitValues = (value: string): string[] => value
  .split(/\r?\n|[,，、/|]/)
  .map(item => item.trim())
  .filter(Boolean);

const normalized = (value: string): string => value.toLowerCase().replace(/\s+/g, "");

function collectedCode(field: string, value: string, collected: CollectedUrlOptions): string | null {
  const found = (collected[field] || []).find(option => normalized(String(option.text || "")) === normalized(value) && option.code);
  return found?.code ? String(found.code) : null;
}

function resolveCodes(field: string, values: string[], collected: CollectedUrlOptions): { codes: string[]; missing: string[] } {
  const codes: string[] = [];
  const missing: string[] = [];
  for (const value of values.filter(item => item !== "不限")) {
    const code = STATIC_CODES[field]?.[value] || collectedCode(field, value, collected);
    if (code) codes.push(code); else missing.push(value);
  }
  return { codes: [...new Set(codes)], missing };
}

export function buildBossJobsUrl(currentUrl: string, settings: Settings, collected: CollectedUrlOptions = {}): BossUrlBuildResult {
  const url = new URL(currentUrl);
  url.pathname = "/web/geek/jobs";
  url.hash = "";
  const applied: string[] = [];
  const missing: string[] = [];
  const unsupported: string[] = [];

  const setSingle = (param: string, field: string, values: string[], label: string): void => {
    if (!values.length) return;
    const { codes, missing: unresolved } = resolveCodes(field, values, collected);
    if (unresolved.length) {
      missing.push(`${label}：${unresolved.join("、")}`);
      return;
    }
    url.searchParams.delete(param);
    if (codes.length) url.searchParams.set(param, codes.join(","));
    applied.push(label);
  };

  const keywords = splitValues(settings.jobKeywords);
  if (keywords.length) {
    url.searchParams.set("query", keywords.slice(0, 3).join(" "));
    applied.push("关键词");
  }

  const locations = splitValues(settings.targetLocations);
  if (locations.length) {
    const cityCodes = locations.map(city => CITY_CODES[city] || collectedCode("location", city, collected));
    const first = cityCodes.find(Boolean);
    const unresolved = locations.filter((_, index) => !cityCodes[index]);
    if (unresolved.length) missing.push(`城市：${unresolved.join("、")}`);
    if (first) {
      url.searchParams.set("city", first);
      applied.push("城市");
      if (cityCodes.filter(Boolean).length > 1) unsupported.push("BOSS URL 当前只使用第一个城市");
    }
  }

  setSingle("jobType", "jobTypes", splitValues(settings.jobTypes), "求职类型");
  setSingle("salary", "salary", splitValues(settings.targetSalary), "薪资");
  setSingle("experience", "experience", splitValues(settings.workExperience), "经验");
  setSingle("degree", "education", splitValues(settings.education), "学历");
  setSingle("scale", "companySizes", splitValues(settings.companySizes), "公司规模");
  setSingle("industry", "industries", splitValues(settings.companyIndustries), "行业");

  if (splitValues(settings.workMode).length) unsupported.push("工作方式暂不支持 URL 参数，将保留给页面/本地过滤");
  return { url: url.toString(), applied, missing, unsupported };
}

function decodeParam(field: string, raw: string | null): string[] {
  if (!raw) return [];
  const reverse = Object.fromEntries(Object.entries(STATIC_CODES[field] || {}).map(([text, code]) => [code, text]));
  return raw.split(",").map(value => reverse[value] || value).filter(Boolean);
}

/** 从 BOSS jobs URL 回读页面当前筛选条件，供快照验证使用。 */
export function parseBossJobsUrl(currentUrl: string): BossQueryContext {
  const url = new URL(currentUrl);
  const city = url.searchParams.get("city") || "";
  const query: BossQueryContext = {
    keyword: url.searchParams.get("query") || "",
    location: city ? [CITY_NAMES[city] || city] : [],
    salary: decodeParam("salary", url.searchParams.get("salary")),
    jobTypes: decodeParam("jobTypes", url.searchParams.get("jobType")),
    workModes: [],
    experience: decodeParam("experience", url.searchParams.get("experience")),
    education: decodeParam("education", url.searchParams.get("degree")),
    industries: decodeParam("industries", url.searchParams.get("industry")),
    companySizes: decodeParam("companySizes", url.searchParams.get("scale")),
    source: "search"
  };
  return query;
}
