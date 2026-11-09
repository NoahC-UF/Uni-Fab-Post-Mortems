@echo off
rem ============================================================================
rem  Lets other computers on your network open the app.     NOT run automatically.
rem  Right-click this file -> "Run as administrator".
rem    allow_network.bat          opens the app's port in Windows Firewall (private networks only)
rem    allow_network.bat remove   closes it again
rem  You must ALSO set HOST=0.0.0.0 in .env, then restart the app. See README.md.
rem ============================================================================
setlocal
cd /d "%~dp0"

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo  This needs Administrator rights.
  echo  Right-click allow_network.bat and choose "Run as administrator".
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%p in ('node --env-file-if-exists^=.env -p "process.env.PORT||8080"') do set APP_PORT=%%p

if /i "%~1"=="remove" (
  netsh advfirewall firewall delete rule name="Uni-Fab Post-Mortem" >nul
  echo  Firewall rule removed. Other computers can no longer connect.
  pause
  exit /b 0
)

netsh advfirewall firewall delete rule name="Uni-Fab Post-Mortem" >nul 2>&1
netsh advfirewall firewall add rule name="Uni-Fab Post-Mortem" dir=in action=allow protocol=TCP localport=%APP_PORT% profile=private
echo.
echo  Done: TCP port %APP_PORT% is open on PRIVATE networks only.
echo.
echo  Next:
echo    1. Open .env and set  HOST=0.0.0.0
echo    2. Close and restart the app (start.bat)
echo    3. Others open  http://%COMPUTERNAME%:%APP_PORT%
echo.
pause
