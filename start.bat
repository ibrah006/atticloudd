@echo off
title Attic
cd /d "%~dp0"
set "NODE=node"
where node >nul 2>nul || set "NODE=%ProgramFiles%\nodejs\node.exe"
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8420"
"%NODE%" server.js
pause
