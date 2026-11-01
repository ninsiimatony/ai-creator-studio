@echo off
cd /d "%~dp0"
for /f %%i in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString('N')+[guid]::NewGuid().ToString('N')"') do set AUTO=%%i
echo Saving secret in your studio...
(<nul set /p="%AUTO%")| call npx wrangler secret put AUTOMATION_SECRET --name youtube-automation-platform
if errorlevel 1 goto fail
(<nul set /p="%AUTO%")| clip
start "" "https://github.com/ninsiimatony/ai-creator-studio/settings/secrets/actions/new"
echo.
echo SECRET COPIED. On the GitHub page:
echo   Name   = AUTOMATION_SECRET
echo   Secret = press Ctrl+V
echo   Click the green Add secret button.
pause
exit /b 0
:fail
echo FAILED - tell Claude
pause
