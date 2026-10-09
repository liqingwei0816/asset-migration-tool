#!/usr/bin/env bash
# 素材库跨通道迁移工作台 启动脚本 (Linux / macOS)
cd "$(dirname "$0")" || exit 1

echo "=============================================="
echo "  素材库跨通道迁移工作台 启动脚本 (Linux/macOS)"
echo "=============================================="

# ── 1. 确定 Node：优先使用项目内置运行时 runtime/node（免安装模式）──
if [ -x "runtime/node" ]; then
  NODE_EXE="runtime/node"
  echo "[信息] 使用内置运行时: runtime/node"
else
  if ! command -v node >/dev/null 2>&1; then
    echo "[错误] 未检测到 Node.js，且不存在内置运行时 runtime/node。"
    echo "       解决方式二选一:"
    echo "       1. 在装有 Node 的机器上执行 node install-runtime.cjs 生成内置运行时，"
    echo "          然后把整个目录拷贝到目标机器;"
    echo "       2. 在目标机器安装 Node.js 18+: https://nodejs.org/zh-cn/download"
    exit 1
  fi
  NODE_EXE="node"
  echo "[信息] 使用系统 Node.js: $(node -v)"
fi

if ! "$NODE_EXE" -e 'const v=+process.versions.node.split(".")[0]; if(v<18){console.error("[错误] 需要 Node.js 18 或更高版本，当前为 "+process.versions.node+"，请升级：https://nodejs.org/zh-cn/download"); process.exit(1)}'; then
  exit 1
fi

# ── 2. 检查项目文件与依赖 ──
if [ ! -f package.json ]; then
  echo "[错误] 未找到 package.json，请在 asset-migration-tool 目录内运行本脚本。"
  exit 1
fi
if ! "$NODE_EXE" -e "require.resolve('express')" >/dev/null 2>&1; then
  echo "[信息] 缺少依赖（express 等），尝试 npm install …"
  if command -v npm >/dev/null 2>&1; then
    if ! npm install; then
      echo "[错误] 依赖安装失败。请检查网络/镜像源后重试，或手动执行：npm install"
      exit 1
    fi
  else
    echo "[错误] 缺少 node_modules 依赖目录，且系统无 npm。"
    echo "       请重新获取完整项目目录（应包含 node_modules），或在开发机执行 npm install 后整体拷贝。"
    exit 1
  fi
fi

# ── 3. 启动 ──
PORT="${PORT:-8787}"
export OPEN_BROWSER=1
echo "[信息] 启动服务：http://localhost:${PORT}   （Ctrl+C 停止，启动后将自动打开浏览器）"
echo "[信息] 配置与任务数据保存在 data/ 目录"
exec "$NODE_EXE" src/server.js
