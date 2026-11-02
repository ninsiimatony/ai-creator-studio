@echo off
cd /d "%~dp0"
> push-log.txt echo START
git checkout main >> push-log.txt 2>&1
git checkout feature/phase1-d1-backend -- .github/workflows/video-bot.yml >> push-log.txt 2>&1
git commit -m "Remove GitHub timer; Cloudflare runs the 3 daily videos" >> push-log.txt 2>&1
git push origin main >> push-log.txt 2>&1
git checkout feature/phase1-d1-backend >> push-log.txt 2>&1
echo DONE >> push-log.txt
type push-log.txt
pause
