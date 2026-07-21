import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "BOSS 自动打招呼",
    description: "在 Chrome 侧边栏中审核并按顺序发送 BOSS 打招呼消息。",
    permissions: ["storage", "tabs", "activeTab", "sidePanel", "notifications"],
    host_permissions: ["https://www.zhipin.com/*", "https://zhipin.com/*"],
    action: {
      default_title: "打开 BOSS 自动打招呼侧边栏",
    },
    side_panel: {
      default_path: "sidepanel.html",
    },
  },
});
