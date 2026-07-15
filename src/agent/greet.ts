import type { GreetStatus, PageSnapshot } from "../types";

export type GreetEvent = "opened" | "filled" | "send_clicked" | "verify_clear" | "verify_unclear" | "failed";

export function nextGreetStatus(cur: GreetStatus, ev: GreetEvent): GreetStatus {
  if (ev === "failed") return "failed";
  switch (cur) {
    case "pending": return ev === "opened" ? "opening" : cur;
    case "opening": return ev === "filled" ? "message_filled" : cur;
    case "message_filled": return ev === "send_clicked" ? "sent" : cur;
    case "sent":
      if (ev === "verify_clear") return "verified";
      if (ev === "verify_unclear") return "unknown";
      return cur;
    default: return cur; // verified/unknown/failed 终态
  }
}

export function greetVerify(snapshot: PageSnapshot): "verified" | "unknown" | "failed" {
  // BOSS 真实"已发送"信号待 Task 11 确认；首版：出现会话消息/成功提示→verified，否则 unknown。
  const chatText = snapshot.elements.filter(e => e.region === "chat").map(e => e.text).join("");
  if (/已发送|发送成功|消息已发出/.test(chatText)) return "verified";
  if (snapshot.elements.some(e => e.region === "chat" && /发送失败|网络/.test(e.text))) return "failed";
  return "unknown";
}
