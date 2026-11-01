@echo off
cd /d "%~dp0"
> merge-log.txt echo === START %date% %time%
if exist .git\index.lock del /f .git\index.lock
git checkout main >> merge-log.txt 2>&1
if errorlevel 1 goto fail
git pull origin main >> merge-log.txt 2>&1
git merge --no-edit feature/phase1-d1-backend >> merge-log.txt 2>&1
if errorlevel 1 goto fail
git push origin main >> merge-log.txt 2>&1
if errorlevel 1 goto fail
git checkout feature/phase1-d1-backend >> merge-log.txt 2>&1
echo === DONE OK >> merge-log.txt
echo DONE OK
pause
exit /b 0
:fail
git checkout feature/phase1-d1-backend >> merge-log.txt 2>&1
echo === FAILED >> merge-log.txt
echo FAILED - tell Claude
pause
exit /b 1
