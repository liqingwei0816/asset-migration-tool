/**
 * 安装内置 Node 运行时：把当前 Node 的 node.exe 复制到 runtime/node.exe。
 *
 * 之后 start.bat / start.sh 会优先使用 runtime 内的 Node（不依赖系统安装），
 * 整个项目目录拷贝到其他 Windows 机器即可直接运行（绿色便携模式）。
 *
 * 用法：node install-runtime.cjs   （或双击 install-runtime.bat）
 */
const fs = require("fs");
const path = require("path");

if (process.platform !== "win32") {
  console.log("[提示] 本脚本仅用于 Windows 便携部署；Linux/macOS 直接使用系统 Node 即可（npm start）。");
  process.exit(0);
}

const runtimeDir = path.join(__dirname, "runtime");
fs.mkdirSync(runtimeDir, { recursive: true });
const dest = path.join(runtimeDir, "node.exe");
fs.copyFileSync(process.execPath, dest);

const ver = require("node:child_process").execSync(`"${dest}" -v`, { stdio: "pipe" }).toString().trim();
console.log(`[完成] 内置运行时已安装: runtime\\node.exe (${ver})`);
console.log("[说明] 现在整个项目目录（含 runtime/ 与 node_modules/）拷贝到其他 Windows 机器，");
console.log("       双击 start.bat 即可直接运行，目标机器无需安装 Node.js。");
