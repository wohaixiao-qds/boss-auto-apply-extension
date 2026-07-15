import type { BossQueryContext, EffectiveQuery, Settings } from "../types";

const lines = (value: string): string[] => value.split(/\r?\n|[,，/|]/).map(item => item.trim()).filter(Boolean);

function prefer(userValue: string, currentValue: string[]): string[] {
  const user = lines(userValue);
  return user.length ? user : currentValue;
}

export function mergeBossQueryWithUser(current: BossQueryContext, settings: Settings): EffectiveQuery {
  const userKeywords = lines(settings.jobKeywords || settings.jobIntent.targetTitles.join("\n"));
  const userLocations = lines(settings.targetLocations || settings.jobIntent.locations.join("\n"));
  const userSalary = lines(settings.targetSalary || settings.jobIntent.salary);
  const userWorkModes = lines(settings.workMode || settings.jobIntent.workModes.join("\n"));
  const query: EffectiveQuery = {
    keyword: userKeywords.length ? userKeywords.slice(0, 3).join(" ") : current.keyword,
    location: prefer(settings.targetLocations || settings.jobIntent.locations.join("\n"), current.location),
    salary: prefer(settings.targetSalary || settings.jobIntent.salary, current.salary),
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
    jobTypes: lines(settings.jobTypes).length > 0,
    workModes: userWorkModes.length > 0,
    experience: lines(settings.workExperience).length > 0,
    education: lines(settings.education).length > 0,
    industries: lines(settings.companyIndustries).length > 0,
    companySizes: lines(settings.companySizes).length > 0
  };
  for (const [key, label] of dimensions) {
    const userProvided = key === "keyword" ? userKeywords.length > 0 : Boolean(userProvidedMap[key]);
    (userProvided ? query.changed : query.preserved).push(label);
  }
  return query;
}
