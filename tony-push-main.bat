@echo off
cd /d "%~dp0"
> push-log.txt echo START
git checkout --theirs scripts/video-bot/topics.json >> push-log.txt 2>&1
git add scripts/video-bot/topics.json >> push-log.txt 2>&1
git commit -m "Merge feature: love and heartbreak stories" >> push-log.txt 2>&1
git push origin main >> push-log.txt 2>&1
git checkout feature/phase1-d1-backend >> push-log.txt 2>&1
echo DONE >> push-log.txt
type push-log.txt
pause
