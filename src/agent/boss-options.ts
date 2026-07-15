// BOSS 真实筛选下拉的固定选项（采集自真实页面，补了采集遗漏的"本科"、"5-10年"）。
// 用于设置页多选下拉渲染，以及校验用户填的值是否匹配 BOSS 口径。
export const BOSS_OPTIONS: Array<{ field: "jobTypes" | "targetSalary" | "workExperience" | "education" | "companySizes"; label: string; options: string[] }> = [
  { field: "jobTypes", label: "求职类型", options: ["不限", "全职", "兼职"] },
  { field: "targetSalary", label: "薪资", options: ["不限", "3K以下", "3-5K", "5-10K", "10-20K", "20-50K", "50K以上"] },
  { field: "workExperience", label: "经验", options: ["不限", "经验不限", "在校生", "应届生", "1年以内", "1-3年", "3-5年", "5-10年", "10年以上"] },
  { field: "education", label: "学历", options: ["不限", "初中及以下", "中专/中技", "高中", "大专", "本科", "硕士", "博士"] },
  { field: "companySizes", label: "规模", options: ["不限", "0-20人", "20-99人", "100-499人", "500-999人", "1000-9999人", "10000人以上"] }
];
