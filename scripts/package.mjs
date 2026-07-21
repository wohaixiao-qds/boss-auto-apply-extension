import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const buildDir = resolve(projectRoot, ".output", "chrome-mv3");
const releaseDir = resolve(projectRoot, "release");
const archivePath = resolve(releaseDir, "boss-auto-greeting.zip");

console.log("正在构建 Chrome 扩展…");
execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
  cwd: projectRoot,
  stdio: "inherit",
});

if (!existsSync(resolve(buildDir, "manifest.json"))) {
  throw new Error("构建失败：未找到 .output/chrome-mv3/manifest.json");
}

if (process.platform === "win32") {
  throw new Error("当前打包脚本需要 zip 命令。Windows 请安装 Git Bash 后重新执行 npm run package。");
}

mkdirSync(releaseDir, { recursive: true });
rmSync(archivePath, { force: true });

console.log("正在生成 ZIP…");
execFileSync("zip", ["-qr", archivePath, "."], {
  cwd: buildDir,
  stdio: "inherit",
});

console.log(`打包完成：${archivePath}`);
console.log("解压后选择包含 manifest.json 的文件夹，即可在 Chrome 中加载。");
