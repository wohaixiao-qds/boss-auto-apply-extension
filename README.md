# BOSS 自动打招呼侧边栏插件

这是一个基于 Chrome Manifest V3、WXT、React、TypeScript 和 Radix Themes 的本地插件原型。

插件通过 Chrome Side Panel 工作，不会在 BOSS 页面注入浮层或覆盖页面内容。用户在 BOSS 职位列表中完成筛选后，从浏览器右侧打开插件，扫描职位、审核列表，再按顺序执行打招呼。

## 本地运行

要求 Node.js 20 LTS 或更高版本。

```bash
npm install
npm run build
```

生成给他人安装的免费 ZIP 包：

```bash
npm run package
```

ZIP 会生成在 `release/boss-auto-greeting.zip`。对方解压后，在 `chrome://extensions/` 开启开发者模式，选择解压后的、直接包含 `manifest.json` 的文件夹。

然后在 Chrome 中：

1. 打开 `chrome://extensions/`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择项目的 `.output/chrome-mv3` 目录。
5. 打开已登录的 BOSS 直聘职位列表，点击扩展图标打开侧边栏。

开发期间可以使用：

```bash
npm run dev
npm run typecheck
npm test
```

## 当前实现边界

- 只使用本地 Chrome Storage，不接入后端或 AI。
- 打招呼操作复用 BOSS 页面已有的默认话术。
- 发送前需要在侧边栏审核并点击确认。
- 任务按职位列表顺序执行，并使用随机间隔和单批上限。
- 检测到验证码、登录失效或平台频率限制时自动暂停。
- BOSS 页面 DOM 结构变化时，需要更新 `entrypoints/boss.content.ts` 中的识别选择器。
