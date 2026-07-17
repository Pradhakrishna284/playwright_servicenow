@echo off
REM ============================================================
REM start-trigger-branch-verifier.bat
REM Place this file in: playwright_servicenow\tests\
REM   (same folder as verify_trigger_branches.html)
REM
REM Double-click this instead of verify_trigger_branches.html.
REM It syncs the CONFIG block from
REM   validate_trigger_branch\config_github.yaml
REM then opens verify_trigger_branches.html in your browser.
REM ============================================================

cd /d "%~dp0"

echo Syncing config from validate_trigger_branch\config_github.yaml...
python validate_trigger_branch\sync_config.py --yaml validate_trigger_branch\config_github.yaml --html verify_trigger_branches.html
if errorlevel 1 (
    echo.
    echo Sync failed - see error above. Opening the page anyway with the last-known config.
    pause
)

start "" "verify_trigger_branches.html"