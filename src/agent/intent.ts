import { mergeBossQueryWithUser } from "./query-plan";
import type { AgentIntent, BossQueryContext, Settings } from "../types";

const lines = (v: string): string[] => v.split(/\r?\n|[,，/|]/).map(s => s.trim()).filter(Boolean);
const constraints = (v: string): string[] => lines(v).filter(value => value !== "不限");

export function buildAgentIntent(settings: Settings, current: BossQueryContext): AgentIntent {
  const query = mergeBossQueryWithUser(current, settings);
  const userVals = [
    [settings.jobKeywords, settings.excludeCompanies],
    [settings.targetLocations, settings.targetSalary, settings.workMode, settings.jobTypes,
      settings.workExperience, settings.education, settings.companyIndustries, settings.companySizes]
  ].some((group, index) => group.some(value => (index === 0 ? lines(value || "") : constraints(value || "")).length > 0));
  const pageVals = [
    current.keyword, ...current.location, ...current.salary, ...current.jobTypes,
    ...current.experience, ...current.education, ...current.industries, ...current.companySizes
  ].some(Boolean);
  const excludeCompanies = lines(settings.excludeCompanies);
  // 匹配分只用于排序展示，不再作为岗位是否保留的筛选条件。
  // 保留字段是为了兼容旧的存储数据和 AgentIntent 类型。
  const minMatchScore = 0;
  const parts = [
    query.keyword && `职位：${query.keyword}`,
    query.location.length && `城市：${query.location.join("、")}`,
    query.salary.length && `薪资：${query.salary.join("、")}`,
    query.jobTypes.length && `类型：${query.jobTypes.join("、")}`,
    query.experience.length && `经验：${query.experience.join("、")}`,
    query.education.length && `学历：${query.education.join("、")}`,
    query.industries.length && `行业：${query.industries.join("、")}`,
    query.companySizes.length && `规模：${query.companySizes.join("、")}`,
    excludeCompanies.length && `排除：${excludeCompanies.join("、")}`
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
