import { describe, it, expect } from "vitest";
import { mergeRecovery } from "../../src/agent/recovery";
import { newAgentState } from "../../src/agent/state";

describe("mergeRecovery", () => {
  it("prefers higher stateVersion for same run", () => {
    const a = newAgentState("r1", 1, "t0");
    const b = newAgentState("r1", 1, "t0"); b.stateVersion = 5;
    expect(mergeRecovery(a, b)).toBe(b);
  });
  it("different runId: prefers remote if not older than local start", () => {
    const local = newAgentState("r1", 1, "2026-07-15T00:00:00Z");
    const remote = newAgentState("r2", 1, "2026-07-15T00:00:05Z");
    expect(mergeRecovery(local, remote)).toBe(remote);
  });
  it("ignores stale remote run older than local start", () => {
    const local = newAgentState("r1", 1, "2026-07-15T05:00:00Z");
    const remote = newAgentState("r2", 1, "2026-07-15T00:00:00Z");
    expect(mergeRecovery(local, remote)).toBe(local);
  });
});
