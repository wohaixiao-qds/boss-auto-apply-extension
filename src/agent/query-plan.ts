import type { BossQueryContext, EffectiveQuery, Settings } from "../types";

const lines = (value: string): string[] => value.split(/\r?\n|[,，/|]/).map(item => item.trim()).filter(Boolean);
const constraints = (value: string): string[] => lines(value).filter(item => item !== "不限");

function prefer(userValue: string, currentValue: string[]): string[] {
  const user = constraints(userValue);
  return user.length ? user : currentValue;
}

export function mergeBossQueryWithUser(current: BossQueryContext, settings: Settings): EffectiveQuery {
  const userKeywords = lines(settings.jobKeywords);
  const userLocations = constraints(settings.targetLocations);
  const userSalary = constraints(settings.targetSalary);
  const userWorkModes = constraints(settings.workMode);
  const query: EffectiveQuery = {
    keyword: userKeywords.length ? userKeywords.slice(0, 3).join(" ") : current.keyword,
    location: prefer(settings.targetLocations, current.location),
    salary: prefer(settings.targetSalary, current.salary),
    jobTypes: prefer(settings.jobTypes, current.jobTypes),
    workModes: userWorkModes.length ? userWorkModes : current.workModes,
    experience: prefer(settings.workExperience, current.experience),
    education: prefer(settings.education, current.education),
    industries: prefer(settings.companyIndustries, current.industries),
    companySizes: prefer(settings.companySizes, current.companySizes),
    source: current.source,
    changed: [],
    preserved: []
  };

  const dimensions: Array<[keyof EffectiveQuery, string]> = [
    ["keyword", "关键词"], ["location", "城市"], ["salary", "薪资"], ["jobTypes", "求职类型"],
    ["workModes", "工作方式"], ["experience", "工作经验"], ["education", "学历"],
    ["industries", "公司行业"], ["companySizes", "公司规模"]
  ];
  const userProvidedMap: Record<string, boolean> = {
    location: userLocations.length > 0,
    salary: userSalary.length > 0,
    jobTypes: constraints(settings.jobTypes).length > 0,
    workModes: userWorkModes.length > 0,
    experience: constraints(settings.workExperience).length > 0,
    education: constraints(settings.education).length > 0,
    industries: constraints(settings.companyIndustries).length > 0,
    companySizes: constraints(settings.companySizes).length > 0
  };
  for (const [key, label] of dimensions) {
    const userProvided = key === "keyword" ? userKeywords.length > 0 : Boolean(userProvidedMap[key]);
    (userProvided ? query.changed : query.preserved).push(label);
  }
  return query;
}
