@echo off
chcp 65001 > nul
title Tenant Billing System
cd /d "%~dp0"
if not exist "server\index.js" ( echo [ERROR] server/index.js missing! & pause & exit )
echo Starting server...
start "" npm start
timeout /t 4 /nobreak > nul
start http://localhost:5000
exit