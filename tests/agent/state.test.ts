import { describe, it, expect } from "vitest";
import { newAgentState, bumpState } from "../../src/agent/state";

describe("newAgentState", () => {
  it("starts in screen phase, idle, zero counters", () => {
    const s = newAgentState("run1", 7, "2026-07-15T00:00:00Z");
    expect(s.phase).toBe("screen");
    expect(s.step).toBe("idle");
    expect(s.phaseTurns).toBe(0);
    expect(s.greeted).toEqual([]);
    expect(s.greetCap).toBe(10);
    expect(s.approvedForGreet).toEqual([]);
  });

  it("bumpState increments version and updatedAt", () => {
    const s = newAgentState("run1", 7, "2026-07-15T00:00:00Z");
    const b = bumpState(s, "2026-07-15T00:00:01Z");
    expect(b.stateVersion).toBe(2);
    expect(b.updatedAt).toBe("2026-07-15T00:00:01Z");
    expect(b.runId).toBe("run1");
  });
});
