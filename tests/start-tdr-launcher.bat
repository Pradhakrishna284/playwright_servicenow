@echo off
title TDR Launcher Server
color 0B

echo.
echo  =============================================
echo   TDR Change Request Launcher
echo   Tax Data Repository ^| ServiceNow automation
echo   Starting local server...
echo  =============================================
echo.

cd /d "%~dp0"

where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
  echo  ERROR: Node.js is not installed or not on PATH.
  echo  Please install Node.js from https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo  Server starting at http://localhost:3131/tdr
echo  Opening browser...
echo.
echo  Keep this window open while using the launcher.
echo  Press Ctrl+C to stop the server.
echo.

start "" "http://localhost:3131/tdr"

node launcher-server.js

pause