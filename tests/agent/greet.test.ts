import { describe, it, expect } from "vitest";
import { nextGreetStatus } from "../../src/agent/greet";

describe("nextGreetStatus", () => {
  it("happy path pending->opening->filled->sent->verified", () => {
    expect(nextGreetStatus("pending", "opened")).toBe("opening");
    expect(nextGreetStatus("opening", "filled")).toBe("message_filled");
    expect(nextGreetStatus("message_filled", "send_clicked")).toBe("sent");
    expect(nextGreetStatus("sent", "verify_clear")).toBe("verified");
  });
  it("only send_clicked transitions message_filled->sent (not random click)", () => {
    expect(nextGreetStatus("message_filled", "opened")).toBe("message_filled");
  });
  it("sent -> unknown when verify unclear", () => {
    expect(nextGreetStatus("sent", "verify_unclear")).toBe("unknown");
  });
  it("failed is terminal from anywhere", () => {
    expect(nextGreetStatus("opening", "failed")).toBe("failed");
  });
  it("verified is terminal", () => {
    expect(nextGreetStatus("verified", "send_clicked")).toBe("verified");
  });
});
