# BOSS 求职 Agent

当前 Agent 支持：

1. 从当前已登录的 BOSS 页面导入可见简历，清理导航、广告、重复和无关文本。
2. 基于清洗后的简历分析求职意向，并筛选当前职位列表，展示公司、职位、匹配分数和理由。
3. 使用可恢复的 Agent 状态机执行“找简历 → 读简历 → 分析 → 找职位 → 提取 → 排序”流程。

源码使用 TypeScript，Chrome 加载的是构建后的 `dist/` 目录。TypeScript 不能直接被 Chrome 执行，运行以下命令后，在 `chrome://extensions/` 中选择 `dist/`：

```bash
npm install
npm run build
```

## 使用

1. 在 `chrome://extensions/` 重新加载插件。
2. 登录 BOSS，刷新 BOSS 页面，点击扩展图标，打开 Chrome 原生右侧 Agent 侧栏。侧栏由浏览器分配空间，不覆盖主页面。
3. 点击“自动导入并分析”。Agent 会尝试进入“我的简历/个人中心”，读取资料，再进入职位列表。页面跳转后会根据保存的步骤继续执行。
4. 在职位列表页点击“筛选当前岗位”，查看匹配结果。

## 模型

设置中填写 API Base URL、模型名称和 API Key。中转地址需要兼容 OpenAI Chat Completions，例如填写到 `/v1`，插件请求 `/chat/completions`。

当前版本不包含自动投递、聊天发送和默认回复模板；高风险动作后续仍应保留用户确认。
