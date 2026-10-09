@echo off
cd /d "%~dp0"
echo Installing bundled Node runtime to runtime\node.exe ...
node install-runtime.cjs
pause
