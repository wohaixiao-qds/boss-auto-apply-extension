import { mergeBossQueryWithUser } from "./query-plan";
import type { AgentIntent, BossQueryContext, Settings } from "../types";

const lines = (value: string): string[] => value
  .split(/\r?\n|[,，/|]/)
  .map(item => item.trim())
  .filter(Boolean);

export function buildAgentIntent(settings: Settings, current: BossQueryContext): AgentIntent {
  const query = mergeBossQueryWithUser(current, settings);
  const explicitValues = [
    settings.jobKeywords,
    settings.excludeCompanies,
    settings.targetLocations,
    settings.targetSalary,
    settings.workMode,
    settings.jobTypes,
    settings.workExperience,
    settings.education,
    settings.companyIndustries,
    settings.companySizes
  ].some(value => lines(value || "").length > 0);
  const profileValues = [
    settings.jobIntent.targetTitles.join(" "),
    settings.jobIntent.skills.join(" "),
    settings.jobIntent.locations.join(" "),
    settings.jobIntent.salary,
    settings.jobIntent.workModes.join(" ")
  ].some(Boolean);
  const pageValues = [
    current.keyword,
    ...current.location,
    ...current.salary,
    ...current.jobTypes,
    ...current.experience,
    ...current.education,
    ...current.industries,
    ...current.companySizes
  ].some(Boolean);
  const excludeCompanies = lines(settings.excludeCompanies);
  const minMatchScore = Number.isFinite(Number(settings.minMatchScore)) ? Number(settings.minMatchScore) : 0;
  const parts = [
    query.keyword && `职位：${query.keyword}`,
    query.location.length && `城市：${query.location.join("、")}`,
    query.salary.length && `薪资：${query.salary.join("、")}`,
    query.jobTypes.length && `类型：${query.jobTypes.join("、")}`,
    query.workModes.length && `方式：${query.workModes.join("、")}`,
    query.experience.length && `经验：${query.experience.join("、")}`,
    query.education.length && `学历：${query.education.join("、")}`,
    query.industries.length && `行业：${query.industries.join("、")}`,
    query.companySizes.length && `规模：${query.companySizes.join("、")}`,
    excludeCompanies.length && `排除：${excludeCompanies.join("、")}`,
    minMatchScore > 0 && `最低匹配：${minMatchScore}分`
  ].filter(Boolean) as string[];

  return {
    objective: "screen_jobs",
    query,
    excludeCompanies,
    minMatchScore,
    summary: parts.join("；") || settings.jobIntent.summary || "暂未形成明确岗位目标",
    defined: explicitValues || profileValues || pageValues,
    source: explicitValues && profileValues ? "mixed" : explicitValues ? "user" : profileValues ? "profile" : "page"
  };
}
