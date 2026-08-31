@echo off
setlocal

rem Start from repository root. Keep this file ASCII-only for cmd.exe compatibility.
pushd "%~dp0..\.." || exit /b 1

set "DEEPSEEK_BASE_URL=http://192.168.10.61:3000/v1"
set "QABOT_PORT=3100"
set "QABOT_HOST=0.0.0.0"
set "QABOT_SYNC_INTERVAL_MINUTES=30"

rem bootstrap.ts loads current secrets from the root .env before model SDK initialization.
node --import tsx/esm apps/qabot/src/bootstrap.ts serve

set "EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %EXIT_CODE%
