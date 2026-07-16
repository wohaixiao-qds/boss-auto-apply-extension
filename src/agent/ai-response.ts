export function parseAiResponseBody(body: string, status: number, contentType = ""): unknown {
  const raw = body.trim();
  const type = contentType ? `，Content-Type=${contentType}` : "";
  if (!raw) {
    throw new Error(`AI 接口返回空响应（HTTP ${status}${type}）`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    const preview = raw.replace(/\s+/g, " ").slice(0, 180);
    throw new Error(`AI 接口返回非 JSON（HTTP ${status}${type}）：${preview}`);
  }
}
