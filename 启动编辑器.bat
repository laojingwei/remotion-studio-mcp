@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Remotion Studio
echo.
echo   Remotion Studio - 协同动画编辑器
echo   首次启动会构建前端，稍等几秒...
echo.
call npm start
pause
