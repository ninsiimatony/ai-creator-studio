@echo off
cd /d "%~dp0"
echo Running checks, build and deploy... (log: deploy-log.txt)
> deploy-log.txt echo === START %date% %time%
if exist .git\index.lock del /f .git\index.lock
echo === BUILD >> deploy-log.txt
call npm run build >> deploy-log.txt 2>&1
if errorlevel 1 goto fail
echo === TSC >> deploy-log.txt
call npx tsc --noEmit >> deploy-log.txt 2>&1
rem tsc result ignored
echo === COMMIT >> deploy-log.txt
git add -A >> deploy-log.txt 2>&1
git reset -q -- tony-deploy.bat deploy-log.txt >> deploy-log.txt 2>&1
git commit -m "Add Telegram video bot and GitHub video job" >> deploy-log.txt 2>&1
echo === DEPLOY >> deploy-log.txt
call npx wrangler deploy --config .output/server/wrangler.json >> deploy-log.txt 2>&1
if errorlevel 1 goto fail
echo === PUSH >> deploy-log.txt
git push origin HEAD >> deploy-log.txt 2>&1
echo === DONE OK >> deploy-log.txt
echo DONE OK
pause
exit /b 0
:fail
echo === FAILED >> deploy-log.txt
echo FAILED - tell Claude
pause
exit /b 1
