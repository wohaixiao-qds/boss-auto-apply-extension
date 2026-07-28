export function detectBlockingReason(value: string): string | undefined {
  const text = value.replace(/\s+/g, " ").trim();

  if (/验证码|安全验证|滑动验证|行为异常/.test(text)) return "检测到验证码或安全验证，任务已暂停。";
  if (/登录|请先登录/.test(text) && !/职位|公司/.test(text)) return "BOSS 登录状态已失效，任务已暂停。";
  if (/操作频繁|访问过于频繁|稍后再试/.test(text)) return "检测到平台频率限制，任务已暂停。";

  // Only stop on definitive exhaustion wording. A message such as
  // "今日打招呼次数还剩 30 次" means sending is still available.
  if (/达到沟通上限|沟通次数已达上限|打招呼次数已达上限|打招呼次数已用完|今日打招呼次数还剩\s*0(?:\s*次)?|明天再来吧|明日再来/.test(text)) {
    return "BOSS 提示今日沟通已达上限，任务已暂停，请明天再继续。";
  }
  return undefined;
}
