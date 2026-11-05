@echo off
cd /d "%~dp0"
echo Second channel setup. You paste the two values from Google (they are saved only in your studio).
echo.
set /p CID=Paste the CLIENT ID and press Enter: 
(<nul set /p="%CID%")| call npx wrangler secret put GOOGLE_CLIENT_ID_2 --name youtube-automation-platform
if errorlevel 1 goto fail
set /p CSEC=Paste the CLIENT SECRET and press Enter: 
(<nul set /p="%CSEC%")| call npx wrangler secret put GOOGLE_CLIENT_SECRET_2 --name youtube-automation-platform
if errorlevel 1 goto fail
echo.
echo SAVED. Tell Claude: saved.
pause
exit /b 0
:fail
echo FAILED - tell Claude
pause
exit /b 1
