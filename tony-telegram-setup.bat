@echo off
cd /d "%~dp0"
set NAME=youtube-automation-platform
set URL=https://youtube-automation-platform.ninsiimatony.workers.dev
echo.
echo ==== TELEGRAM VIDEO BOT SETUP ====
echo Do NOT take photos of this screen while pasting tokens.
echo.
set /p BOT=1. Paste your Telegram bot token, then press Enter: 
set /p GH=2. Paste your GitHub token, then press Enter: 
for /f %%i in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString('N')+[guid]::NewGuid().ToString('N')"') do set WH=%%i
for /f %%i in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString('N')+[guid]::NewGuid().ToString('N')"') do set AUTO=%%i
echo.
echo Saving secrets in your studio...
(<nul set /p="%BOT%")| call npx wrangler secret put TELEGRAM_BOT_TOKEN --name %NAME%
if errorlevel 1 goto fail
(<nul set /p="%GH%")| call npx wrangler secret put GITHUB_TOKEN --name %NAME%
if errorlevel 1 goto fail
(<nul set /p="%WH%")| call npx wrangler secret put TELEGRAM_WEBHOOK_SECRET --name %NAME%
if errorlevel 1 goto fail
(<nul set /p="%AUTO%")| call npx wrangler secret put AUTOMATION_SECRET --name %NAME%
if errorlevel 1 goto fail
echo.
echo Connecting Telegram to your studio...
curl -s "https://api.telegram.org/bot%BOT%/setWebhook?url=%URL%/api/telegram&secret_token=%WH%"
echo.
echo.
echo 3. Now open Telegram, find your bot and send: hi
echo    The bot will reply with a number (your chat number).
set /p CID=   Type that number here and press Enter: 
(<nul set /p="%CID%")| call npx wrangler secret put TELEGRAM_CHAT_ID --name %NAME%
if errorlevel 1 goto fail
echo.
echo 4. LAST STEP: the secret code below is now copied. Paste it into GitHub.
(<nul set /p="%AUTO%")| clip
start "" "https://github.com/ninsiimatony/ai-creator-studio/settings/secrets/actions/new"
echo    On the GitHub page that opens:
echo      Name   = AUTOMATION_SECRET
echo      Secret = (paste with Ctrl+V)
echo      Press the green "Add secret" button.
echo.
echo DONE. Then send your bot a message like: make a 10 minute video about robots
pause
exit /b 0
:fail
echo.
echo FAILED - tell Claude
pause
exit /b 1
