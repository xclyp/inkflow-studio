@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22.13 或更新版本。
  pause
  exit /b 1
)
echo 墨舟 AI 正在启动；请保持窗口打开。
echo 默认访问 http://127.0.0.1:5181
node server.mjs
pause
