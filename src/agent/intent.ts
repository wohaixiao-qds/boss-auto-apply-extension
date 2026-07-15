import { mergeBossQueryWithUser } from "./query-plan";
import type { AgentIntent, BossQueryContext, Settings } from "../types";

const lines = (v: string): string[] => v.split(/\r?\n|[,，/|]/).map(s => s.trim()).filter(Boolean);

export function buildAgentIntent(settings: Settings, current: BossQueryContext): AgentIntent {
  const query = mergeBossQueryWithUser(current, settings);
  const userVals = [
    settings.jobKeywords, settings.excludeCompanies, settings.targetLocations,
    settings.targetSalary, settings.workMode, settings.jobTypes,
    settings.workExperience, settings.education, settings.companyIndustries, settings.companySizes
  ].some(v => lines(v || "").length > 0);
  const pageVals = [
    current.keyword, ...current.location, ...current.salary, ...current.jobTypes,
    ...current.experience, ...current.education, ...current.industries, ...current.companySizes
  ].some(Boolean);
  const excludeCompanies = lines(settings.excludeCompanies);
  const minMatchScore = Number.isFinite(Number(settings.minMatchScore)) ? Number(settings.minMatchScore) : 0;
  const parts = [
    query.keyword && `职位：${query.keyword}`,
    query.location.length && `城市：${query.location.join("、")}`,
    query.salary.length && `薪资：${query.salary.join("、")}`,
    query.jobTypes.length && `类型：${query.jobTypes.join("、")}`,
    query.experience.length && `经验：${query.experience.join("、")}`,
    query.education.length && `学历：${query.education.join("、")}`,
    query.industries.length && `行业：${query.industries.join("、")}`,
    query.companySizes.length && `规模：${query.companySizes.join("、")}`,
    excludeCompanies.length && `排除：${excludeCompanies.join("、")}`,
    minMatchScore > 0 && `最低匹配：${minMatchScore}分`
  ].filter(Boolean) as string[];
  return {
    objective: "greet_matching",
    query,
    excludeCompanies,
    minMatchScore,
    summary: parts.join("；") || "暂未形成明确岗位目标",
    defined: userVals || pageVals,
    source: userVals ? "user" : "page"
  };
}
