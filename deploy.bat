@echo off
chcp 65001 >nul
echo.
echo   ╔══════════════════════════════════════╗
echo   ║   🧠 Evan OS 部署脚本 (旧笔记本)    ║
echo   ╚══════════════════════════════════════╝
echo.

:: 检查 Node.js
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo   ❌ 未找到 Node.js，请先安装: https://nodejs.org
    pause
    exit /b 1
)

echo   ✅ Node.js 已安装: 
node -v
echo.

:: 检查端口
netstat -ano | findstr ":3456" >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo   ⚠️  端口 3456 已被占用，正在停止旧服务...
    for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3456"') do taskkill /PID %%p /F >nul 2>&1
    timeout /t 2 >nul
)

:: 设置开机自启（可选）
echo.
echo   是否设置开机自启动？(y/n)
set /p AUTO_START="   > "

if /i "%AUTO_START%"=="y" (
    echo   正在创建启动任务...
    schtasks /create /tn "EvanOS-SyncServer" /tr "node %~dp0server.cjs" /sc onstart /ru %USERNAME% /f >nul 2>&1
    if %ERRORLEVEL% equ 0 (
        echo   ✅ 已设置开机自启动
    ) else (
        echo   ⚠️  开机自启设置失败（可能需要管理员权限）
    )
)

echo.
echo   🚀 正在启动 Evan OS Sync Server...
echo.
start "EvanOS-Server" /min cmd /c "node %~dp0server.cjs"
timeout /t 2 >nul

echo   ✅ 服务器已启动！
echo.
echo   ╔══════════════════════════════════════╗
echo   ║  访问地址:                          ║
echo   ║  本机:  http://localhost:3456       ║
echo   ║  局域网: http://${IP}:3456          ║
echo   ║  Tailscale: http://100.76.140.95:3456 ║
echo   ║                                    ║
echo   ║  同步 API:                          ║
echo   ║  POST /api/sync/push  推送数据      ║
echo   ║  GET  /api/sync/pull  拉取数据      ║
echo   ║  GET  /api/sync/status 同步状态     ║
echo   ╚══════════════════════════════════════╝
echo.
pause