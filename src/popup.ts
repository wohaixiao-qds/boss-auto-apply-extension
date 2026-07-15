document.getElementById("options")?.addEventListener("click", () => void chrome.runtime.openOptionsPage());
document.getElementById("dashboard")?.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id && /zhipin\.com/.test(tab.url || "")) {
    try {
      // 必须直接在 Popup 的用户点击回调中调用，不能经过异步 background 消息链。
      await chrome.sidePanel.open({ tabId: tab.id });
      await chrome.storage.local.set({ agentSourceTabId: tab.id });
    } catch (error) {
      const status = document.getElementById("status");
      if (status) status.textContent = error instanceof Error ? error.message : "无法打开浏览器侧栏";
      return;
    }
  } else {
    const status = document.getElementById("status");
    if (status) status.textContent = "请先打开 BOSS 页面";
    return;
  }
  window.close();
});
