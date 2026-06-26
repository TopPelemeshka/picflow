@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

set "CONFIG=picflow.settings.json"
set "LOG=%~dp0picflow-launch.log"
set "HOST=0.0.0.0"
set "PORT=8765"
if /I "%~1"=="test" set "CONFIG=picflow.test.settings.json"
if /I "%~1"=="prod" set "CONFIG=picflow.settings.json"
if not "%~2"=="" set "CONFIG=%~2"
if not "%~3"=="" set "HOST=%~3"
if not "%~4"=="" set "PORT=%~4"

echo Starting PicFlow with config: %CONFIG% on %HOST%:%PORT%
start "" powershell -WindowStyle Hidden -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:%PORT%'"
echo [%date% %time%] Starting PicFlow with config: %CONFIG% on %HOST%:%PORT%>"%LOG%"
python -m picflow --config "%CONFIG%" runserver --host "%HOST%" --port %PORT% >>"%LOG%" 2>&1
if errorlevel 1 (
  echo.
  echo PicFlow failed to start. See log: "%LOG%"
  echo.
  type "%LOG%"
  echo.
  pause
  exit /b 1
)
