@echo off
rem ============================================================================
rem  Uni-Fab Post-Mortem  -  double-click this file to start the app.
rem  First run: installs what it needs (needs internet once), creates the database,
rem  starts the server and opens your browser. Leave this window open while using
rem  the app. Close it (or press Ctrl+C) to stop.
rem ============================================================================
setlocal
cd /d "%~dp0"
title Uni-Fab Post-Mortem

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js was not found on this PC.
  echo  Install the "LTS" version from https://nodejs.org  then double-click start.bat again.
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODEMAJOR=%%v
if %NODEMAJOR% LSS 22 (
  echo.
  echo  This app needs Node.js version 22 or newer. You have version %NODEMAJOR%.
  echo  Install the current "LTS" version from https://nodejs.org  then try again.
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  echo  No .env file yet: creating one from .env.example in DEMO mode with fake data.
  echo  To use real Epicor data later, edit .env yourself ^(see README.md^).
  copy /y ".env.example" ".env" >nul
)

echo  Checking installed packages...
call npm install --omit=dev --prefer-offline --no-audit --no-fund >nul 2>&1
if errorlevel 1 (
  if not exist "node_modules\fastify" (
    echo.
    echo  Installing the packages failed. Are you connected to the internet?
    echo  Run "npm install" in this folder to see the error.
    echo.
    pause
    exit /b 1
  )
  echo  ^(Could not check for updates, using the packages already installed.^)
)

echo  Preparing the database...
call npm run migrate --silent
if errorlevel 1 (
  echo.
  echo  The database could not be prepared. See the message above.
  pause
  exit /b 1
)

for /f "delims=" %%p in ('node --env-file-if-exists^=.env -p "process.env.PORT||8080"') do set APP_PORT=%%p

echo  Starting the app on port %APP_PORT%...
rem Open the browser a few seconds from now, once the server is up.
start "" /min cmd /c "timeout /t 4 /nobreak >nul & start "" http://localhost:%APP_PORT%"

call npm start --silent
echo.
echo  The app has stopped.
pause
