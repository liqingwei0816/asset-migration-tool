@echo off
rem 素材库跨通道迁移工作台 启动脚本 (Windows)
rem 本文件为 GBK(ANSI) 编码 + CRLF 换行，请勿以 UTF-8 重新保存
cd /d "%~dp0"
title Asset Migration Workbench

echo ==============================================
echo   素材库跨通道迁移工作台 (Windows)
echo ==============================================

rem 优先使用项目内置运行时 runtime\node.exe（免安装模式）；不存在则回退系统 Node
set "NODE_EXE=node"
if exist "runtime\node.exe" (
  set "NODE_EXE=runtime\node.exe"
  echo [信息] 使用内置运行时: runtime\node.exe
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo [错误] 未检测到 Node.js，且不存在内置运行时 runtime\node.exe。
    echo        解决方式二选一:
    echo        1. 在装有 Node 的机器上双击 install-runtime.bat 生成内置运行时，
    echo           然后把整个目录拷贝到目标机器;
    echo        2. 在目标机器安装 Node.js 18+: https://nodejs.org/zh-cn/download
    pause
    exit /b 1
  )
  for /f "tokens=*" %%v in ('node -v') do echo [信息] 使用系统 Node.js: %%v
)

"%NODE_EXE%" -e "const v=+process.versions.node.split('.')[0]; if(v<18){console.error('[Error] Node.js 18+ required, current: '+process.versions.node); process.exit(1)}"
if errorlevel 1 (
  echo [错误] 需要 Node.js 18 或更高版本，请升级: https://nodejs.org/zh-cn/download
  pause
  exit /b 1
)

if not exist package.json (
  echo [错误] 未找到 package.json，请在 asset-migration-tool 目录内运行本脚本。
  pause
  exit /b 1
)
"%NODE_EXE%" -e "require.resolve('express')" >nul 2>nul
if errorlevel 1 (
  echo [信息] 缺少依赖 express 等，正在安装: npm install ...
  call npm install
  if errorlevel 1 (
    echo [错误] 依赖安装失败。请检查网络后重试，或手动执行: npm install
    pause
    exit /b 1
  )
)

if "%PORT%"=="" set PORT=8787
set "OPEN_BROWSER=1"
echo [信息] 启动服务: http://localhost:%PORT%   (Ctrl+C 停止，启动后将自动打开浏览器)
echo [信息] 配置与任务数据保存在 data\ 目录
"%NODE_EXE%" src/server.js
echo.
echo [信息] 服务已退出。
pause
