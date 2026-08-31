@echo off
setlocal

rem Keep the Qabot worker available after an unexpected process exit.
pushd "%~dp0..\.." || exit /b 1

:restart
call apps\qabot\start-qabot.bat
echo [%date% %time%] Qabot exited with code %ERRORLEVEL%; restarting in 5 seconds.
timeout /t 5 /nobreak >nul
goto restart
