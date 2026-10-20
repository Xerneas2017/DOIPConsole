@echo off
setlocal enabledelayedexpansion
rem ============================================================
rem  DoIP 诊断控制台 — Windows 一键启动（单进程、单端口）
rem
rem  用法：
rem    scripts\start.bat              构建前端 + 启动（推荐）
rem    scripts\start.bat --no-build   跳过构建，直接用已有 web\dist
rem
rem  等价于 macOS/Linux 的 scripts/start.sh
rem ============================================================
chcp 65001 >nul 2>&1
title DoIP 诊断控制台

cd /d "%~dp0.."

set "BUILD=1"
if "%~1"=="--no-build" set "BUILD=0"
if "%~1"=="-h" goto :help
if "%~1"=="--help" goto :help

rem ---------- 1. Node 检查 ----------
where node >nul 2>&1
if errorlevel 1 (
  echo [X] 找不到 node，请先安装 Node.js 20 或更高版本：https://nodejs.org/
  echo     安装完成后重新打开命令行窗口再运行本脚本
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do set "NODE_VER=%%v"
echo Node: !NODE_VER!

rem ---------- 2. 依赖 ----------
if not exist "node_modules" (
  echo [1/3] 首次运行，安装依赖（约 1-2 分钟）...
  call npm install
  if errorlevel 1 (
    echo [X] npm install 失败：检查网络或代理设置后重试
    pause
    exit /b 1
  )
)

rem ---------- 3. 构建前端 ----------
if "%BUILD%"=="1" (
  echo [2/3] 构建前端...
  call npm run build
  if errorlevel 1 (
    echo [X] 前端构建失败：删除 node_modules 后重跑 npm install 再试
    pause
    exit /b 1
  )
)

if not exist "web\dist\index.html" (
  echo [X] 找不到 web\dist\index.html；请去掉 --no-build 重新运行
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   启动后浏览器自动打开：http://127.0.0.1:8787
echo   （端口被占用会自动顺延，以终端里的实际地址为准）
echo   关闭本窗口或按 Ctrl-C 退出
echo ============================================================
echo.

rem ---------- 4. 3 秒后自动开浏览器（后台子进程，不阻塞启动） ----------
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start "" http://127.0.0.1:8787"

rem ---------- 5. 前台运行后端（Ctrl-C 即退出） ----------
echo [3/3] 启动后端...
call node --import tsx server\src\index.ts
endlocal
exit /b 0

:help
echo 用法：scripts\start.bat [--no-build]
echo   （默认）构建前端 + 启动后端
echo   --no-build   跳过构建，直接用已有 web\dist
exit /b 0
