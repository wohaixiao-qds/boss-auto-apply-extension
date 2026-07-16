import { describe, it, expect } from "vitest";
import { parseAiResponseBody } from "../../src/agent/ai-response";

describe("parseAiResponseBody", () => {
  it("reports an empty AI response with HTTP context", () => {
    expect(() => parseAiResponseBody("", 502, "application/json")).toThrow("AI 接口返回空响应（HTTP 502，Content-Type=application/json）");
  });

  it("reports non-JSON proxy responses without throwing Response.json errors", () => {
    expect(() => parseAiResponseBody("<html>gateway timeout</html>", 504, "text/html")).toThrow(/AI 接口返回非 JSON.*504.*gateway timeout/);
  });

  it("parses a normal JSON completion response", () => {
    expect(parseAiResponseBody('{"choices":[]}', 200, "application/json")).toEqual({ choices: [] });
  });
});
