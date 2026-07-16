import { describe, it, expect } from "vitest";
import { buildLlmPayload } from "../../src/agent/payload";
import { newAgentState } from "../../src/agent/state";
import { serializeSnapshotForLLM } from "../../src/agent/snapshot";
import type { AgentIntent, PageSnapshot } from "../../src/types";

const snap: PageSnapshot = {
  snapshotId: "s1", kind: "jobs", url: "/x", path: "/x",
  currentQuery: { keyword: "", location: [], salary: [], jobTypes: [], workModes: [], experience: [], education: [], industries: [], companySizes: [], source: "unknown" },
  summary: "", elements: []
};
const intent: AgentIntent = { objective: "greet_matching", query: { keyword: "", location: [], salary: [], jobTypes: [], workModes: [], experience: [], education: [], industries: [], companySizes: [], source: "unknown", changed: [], preserved: [] }, excludeCompanies: [], minMatchScore: 0, summary: "x", defined: true, source: "user" };

describe("buildLlmPayload", () => {
  it("includes greetContext only in greet phase", () => {
    const screen = buildLlmPayload({ state: newAgentState("r", null, "t"), intent, snapshot: snap, currentQuery: snap.currentQuery, effectiveQuery: intent.query, greetContext: { message: "您好" } });
    expect(screen).not.toHaveProperty("greetContext");
    const st = newAgentState("r", null, "t"); st.phase = "greet";
    const greet = buildLlmPayload({ state: st, intent, snapshot: snap, currentQuery: snap.currentQuery, effectiveQuery: intent.query, greetContext: { message: "您好" } });
    expect(greet.greetContext).toEqual({ message: "您好" });
  });
  it("page.screen equals serializeSnapshotForLLM", () => {
    const p: any = buildLlmPayload({ state: newAgentState("r", null, "t"), intent, snapshot: snap, currentQuery: snap.currentQuery, effectiveQuery: intent.query });
    expect(p.page.screen).toBe(serializeSnapshotForLLM(snap));
    expect(p.page.snapshotId).toBe("s1");
  });

  it("hides filter and ordinary job refs from the LLM during greet phase", () => {
    const phaseSnap: PageSnapshot = {
      ...snap,
      elements: [
        { id: "e1", role: "text", text: "薪资待遇", region: "filter" },
        { id: "e2", role: "text", text: "AI Agent开发工程师", region: "job" },
        { id: "e3", role: "btn", text: "立即沟通", region: "job" }
      ]
    };
    const st = newAgentState("r", null, "t");
    st.phase = "greet";
    const payload: any = buildLlmPayload({ state: st, intent, snapshot: phaseSnap, currentQuery: snap.currentQuery, effectiveQuery: intent.query });
    expect(payload.page.screen).toContain("立即沟通");
    expect(payload.page.screen).not.toContain("薪资待遇");
    expect(payload.page.screen).not.toContain("AI Agent开发工程师");
    expect(payload.page.snapshotId).toBe("s1");
  });
});
