# 真实 BOSS DOM Fixture 采集说明

> 背景：`tests/fixtures/boss-*.html` 目前是**合成**的 BOSS-like HTML 片段，仅用于回归 `snapshotPage` 的分区/分类/保留逻辑。真实 BOSS DOM 的 class 名、嵌套层级、chip 取值结构可能与合成版本有偏差，需要采集真实片段替换，才能让 fixture 测试反映真实页面。
>
> 难点：**BOSS 直聘有反调试——直接 F12 打开 DevTools 会触发页面闪退/调试器中断**，因此不能用常规「F12 → Elements → Copy outerHTML」方式采集。本指南给出一条绕开 DevTools 的采集路径。

---

## 为什么不能直接 F12
- 打开 DevTools 面板后，BOSS 的反调试脚本会检测到 debugger / devtools-API，几秒内自动跳转或关闭页面，甚至标记账号风险。
- 因此：**整个采集过程不要打开 Chrome DevTools 面板**。

## 采集路径：扩展侧栏临时按钮

利用扩展自身的 content script（已在页面上下文运行，不受反调试面板检测影响）调用 `snapshotPage()`，把结果写回 `chrome.storage`，再在 dashboard 显示并复制。

### Step 1 — 加一个临时「导出筛选栏 HTML」按钮（仅开发构建）
在 dashboard 侧栏临时加入一个按钮（**采集完成后必须删除，不要进发版**），点击时向当前 BOSS tab 发消息触发 content script：

```ts
// dashboard 侧（临时代码，采集后删除）
document.getElementById("dump-fixture")?.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.tabs.sendMessage(tab.id!, { type: "DUMP_FIXTURE" });
  const dump = await chrome.storage.local.get("fixtureDump");
  await navigator.clipboard.writeText(dump.fixtureDump || "");
  console.log("fixture 已复制到剪贴板");
});
```

content script 收到消息后调用 `snapshotPage` 并把目标区域 `outerHTML` + 快照摘要写入 storage：

```ts
// content script（临时代码，采集后删除）
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "DUMP_FIXTURE") return;
  const snap = snapshotPage(); // 复用扩展内实现
  const filterEl = document.querySelector(".search-condition, .job-filter, .filter-condition");
  const jobEl = document.querySelector(".job-list, .job-box");
  const chatEl = document.querySelector("[class*='chat'], [class*='message-input']");
  const dump = {
    url: location.href,
    capturedAt: new Date().toISOString(),
    summary: snap.summary,
    filterBarHtml: filterEl?.outerHTML ?? null,
    jobListHtml: jobEl?.outerHTML ?? null,
    chatHtml: chatEl?.outerHTML ?? null,
  };
  chrome.storage.local.set({ fixtureDump: JSON.stringify(dump, null, 2) });
  sendResponse({ ok: true });
});
```

> 说明：`snapshotPage()` 调用不依赖 DevTools，因此不会触发反调试闪退。只读取 DOM，不点击、不发送，对账号无风险。

### Step 2 — 在登录态采集三类片段
登录 BOSS 后，依次到以下页面，每页点一次「导出」按钮：

1. **筛选栏 fixture**：职位推荐页 `/web/common/job-recommend` 或搜索结果页——确保筛选栏含已选薪资/经验/学历 chip（有 `.cur` 当前值）。
2. **岗位列表 fixture**：同一页向下滚到岗位卡区域——确保 `.job-list` 内有 ≥3 个 `.job-card-wrapper`，且分页器可见。
3. **沟通弹窗 fixture**：点开任意一个岗位的「立即沟通」弹出聊天窗——确保 textarea + 发送按钮可见，textarea 内可事先输入一句话以验证非空捕获。

### Step 3 — 替换合成 fixture
- 从 `chrome.storage.local.fixtureDump` 复制出 JSON，取出对应 `*Html` 字段。
- 用真实 `outerHTML` 分别替换 `tests/fixtures/boss-filter-bar.html`、`boss-job-list.html`、`boss-chat.html` 的主体（保留顶部合成标注注释，或改为「已替换为真实样本，采集于 YYYY-MM-DD」）。
- 如真实 DOM 中包含账号/姓名/公司等敏感信息，先做脱敏（替换为占位文本）。

### Step 4 — 重跑测试并校准
```bash
npx vitest run tests/integration/boss-fixture.test.ts
```
- 绿：真实 DOM 与 `snapshotPage` 选择器假设吻合，校准完成。
- 红：真实 class/结构与 `regionOf`/`chipCurrent` 选择器有偏差 → **不要擅自改测试断言去硬凑**，先记录偏差到 task 报告，再决定是更新选择器（改 src）还是更新 fixture 断言。优先让选择器更贴近真实 DOM。

### Step 5 — 删除临时按钮（重要）
采集完成后，**移除 dashboard 与 content script 里 Step 1 加入的临时按钮和 `DUMP_FIXTURE` 处理代码**，避免进入发版构建（会向用户暴露调试入口并写入 storage）。删除后重跑 `npm run build` 确认。

---

## 采集不到时的降级
若因账号风险或反调试升级无法采集真实样本：
- 合成 fixture 仍提供 `snapshotPage` 逻辑回归（分区/分类/保留/去重）。
- 但「真实 BOSS 下的选择器命中率」「chip 取值规则」「已发送信号识别」必须靠 `manual-checklist.md` 的人工核验兜底，不能视为已被自动化覆盖。
