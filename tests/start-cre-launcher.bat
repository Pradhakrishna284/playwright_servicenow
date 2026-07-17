@echo off
title CRE Launcher Server
color 0E

echo.
echo  =============================================
echo   CRE Change Request Launcher
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

echo  Server starting at http://localhost:3131
echo  Opening browser...
echo.
echo  Keep this window open while using the launcher.
echo  Press Ctrl+C to stop the server.
echo.

start "" "http://localhost:3131"

node launcher-server.js

pause