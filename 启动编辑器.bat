@echo off
rem Keep this file pure ASCII (English only) so it works under ANY console
rem codepage and ANY editor. Do NOT add Chinese here unless you also manage
rem the file encoding (GBK for cmd on zh-CN Windows). CRLF line endings.
title Remotion Studio
cd /d "%~dp0"
echo.
echo   Remotion Studio - collaborative animation editor
echo   First launch builds the frontend, please wait a few seconds...
echo.
where npm >nul 2>nul
if errorlevel 1 (
  echo   [!] npm not found. Please install Node.js first: https://nodejs.org/
  echo       Then double-click this file again.
  pause
  exit /b 1
)
call npm start
pause
