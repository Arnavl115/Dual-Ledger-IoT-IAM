@echo off
title IoT IAM - Start All Services
echo =========================================
echo   IoT IAM Gateway  +  Frontend Launcher
echo =========================================
echo.

REM -- Start the backend gateway in its own window
echo [1/3] Starting API Gateway on port 3000 ...
start "IoT Gateway (port 3000)" cmd /k "cd /d %~dp0 && node gateway.js"

REM -- Start the frontend dev server in its own window
echo [2/3] Starting Frontend (Vite) on port 5173 ...
start "IoT Frontend (port 5173)" cmd /k "cd /d %~dp0frontend && npm run dev"

REM -- Wait for the servers to boot, then open the browser
echo [3/3] Waiting for services to boot ...
timeout /t 8 /nobreak >nul
start http://127.0.0.1:5173

echo.
echo All services started. Gateway: http://localhost:3000 | Frontend: http://127.0.0.1:5173
echo Close the two service windows to stop everything.