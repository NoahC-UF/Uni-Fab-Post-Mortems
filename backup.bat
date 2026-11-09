@echo off
rem Saves a dated copy of the database into the "backups" folder (keeps the newest 30).
rem Safe to run while the app is running.
setlocal
cd /d "%~dp0"
call npm run backup --silent
echo.
pause
