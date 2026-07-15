import { describe, it, expect } from "vitest";
import { validateDecision, validateSelectedUrls } from "../../src/agent/validate";
import type { AgentDecision, PageSnapshot, Settings, Job } from "../../src/types";

const snap = (ids: string[]): PageSnapshot => ({
  snapshotId: "snap_x", kind: "jobs", url: "/x", path: "/x",
  currentQuery: { keyword: "", location: [], salary: [], jobTypes: [], workModes: [], experience: [], education: [], industries: [], companySizes: [], source: "unknown" },
  summary: "",
  elements: ids.map(id => ({ id, role: "btn", text: id, region: "other" as const }))
});
const dec = (over: Partial<AgentDecision>): AgentDecision => ({ snapshotId: "snap_x", action: "pause", reason: "", expected: "", ...over });
const ctxBase = { phase: "screen" as const, greetMessage: "您好", jobsCollected: true, filterCompleted: true, ranked: true };

describe("validateDecision", () => {
  it("rejects snapshotId mismatch", () => {
    const r = validateDecision(dec({ snapshotId: "other", action: "click", ref: "0" }), { ...ctxBase, snapshot: snap(["0"]) });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/snapshot/);
  });
  it("rejects click without ref", () => {
    const r = validateDecision(dec({ action: "click" }), { ...ctxBase, snapshot: snap(["0"]) });
    expect(r.ok).toBe(false);
  });
  it("rejects ref not in snapshot", () => {
    const r = validateDecision(dec({ action: "click", ref: "99" }), { ...ctxBase, snapshot: snap(["0"]) });
    expect(r.ok).toBe(false);
  });
  it("Phase A forbids chat-region click", () => {
    const s = snap(["0"]); s.elements[0].region = "chat"; s.elements[0].text = "立即沟通";
    const r = validateDecision(dec({ action: "click", ref: "0" }), { ...ctxBase, snapshot: s });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/沟通|chat|Phase A/);
  });
  it("Phase B forbids filter-region click", () => {
    const s = snap(["0"]); s.elements[0].region = "filter";
    const r = validateDecision(dec({ action: "click", ref: "0" }), { ...ctxBase, phase: "greet", snapshot: s });
    expect(r.ok).toBe(false);
  });
  it("Phase B fill must target chat region", () => {
    const s = snap(["0"]); s.elements[0].region = "other";
    const r = validateDecision(dec({ action: "fill", ref: "0", value: "x" }), { ...ctxBase, phase: "greet", snapshot: s });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/chat/);
  });
  it("Phase B fill targeting chat is ok (value will be overwritten elsewhere)", () => {
    const s = snap(["0"]); s.elements[0].region = "chat"; s.elements[0].role = "input";
    const r = validateDecision(dec({ action: "fill", ref: "0", value: "x" }), { ...ctxBase, phase: "greet", snapshot: s });
    expect(r.ok).toBe(true);
  });
  it("request_greet_approval rejected when not ranked", () => {
    const r = validateDecision(dec({ action: "request_greet_approval" }), { ...ctxBase, ranked: false, snapshot: snap([]) });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/未完成|rank/);
  });
  it("next_page ref must be pager region", () => {
    const s = snap(["0"]); s.elements[0].region = "job";
    const r = validateDecision(dec({ action: "next_page", ref: "0" }), { ...ctxBase, snapshot: s });
    expect(r.ok).toBe(false);
  });
  it("pause always ok", () => {
    const r = validateDecision(dec({ action: "pause" }), { ...ctxBase, snapshot: snap([]) });
    expect(r.ok).toBe(true);
  });
});

describe("validateSelectedUrls", () => {
  const jobs: Job[] = [
    { title: "a", company: "A", salary: "", location: "", description: "", url: "https://www.zhipin.com/job_detail/1", score: 80, matchedKeywords: [] },
    { title: "b", company: "Bad", salary: "", location: "", description: "", url: "https://www.zhipin.com/job_detail/2", score: 70, matchedKeywords: [] }
  ];
  const settings: Settings = {
    jobKeywords: "", excludeCompanies: "Bad", targetLocations: "", targetSalary: "", workMode: "", jobTypes: "",
    workExperience: "", education: "", companyIndustries: "", companySizes: "", maxPages: "5", minMatchScore: "50",
    candidateProfileClean: "", jobIntent: { targetTitles: [], skills: [], locations: [], salary: "", workModes: [], summary: "" },
    profileSyncedAt: "", aiEnabled: true, agentAutoStart: true, aiBaseUrl: "", aiModel: "", aiApiKey: "",
    costThresholdYuan: "0.5", inputPriceYuanPerMillion: "0.6", outputPriceYuanPerMillion: "2.4", greetCap: "10", greetMessage: ""
  };
  it("rejects non-zhipin, non-ranked, excluded, over-cap", () => {
    const urls = [
      "https://www.zhipin.com/job_detail/1",   // ok
      "https://evil.com/x",                      // non-zhipin
      "https://www.zhipin.com/job_detail/2",     // excluded company "Bad"
      "https://www.zhipin.com/job_detail/99"     // not in ranked
    ];
    const r = validateSelectedUrls(urls, jobs, settings);
    expect(r.valid).toEqual(["https://www.zhipin.com/job_detail/1"]);
    expect(r.rejected.length).toBe(3);
  });
});
