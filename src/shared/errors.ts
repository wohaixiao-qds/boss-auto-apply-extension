export function toChineseError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : "";
  // 浏览器扩展 API 的英文底层错误不直接展示给用户。
  return message && /[\u4e00-\u9fff]/.test(message) ? message : fallback;
}
