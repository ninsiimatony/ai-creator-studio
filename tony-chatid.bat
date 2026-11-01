@echo off
cd /d "%~dp0"
echo Saving your chat number...
echo 5461281115| call npx wrangler secret put TELEGRAM_CHAT_ID --name youtube-automation-platform
echo.
echo DONE - you can close this window.
pause
