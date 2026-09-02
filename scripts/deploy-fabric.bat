@echo off
REM Production Fabric Deploy — Windows (Git Bash + Docker Desktop)
REM Requires: Docker Desktop running, Git Bash installed, fabric-samples/bin on PATH
REM Run from repository root: scripts\deploy-fabric.bat

echo =========================================
echo  Fabric Production Deploy (Windows)
echo =========================================

REM Enable WSL2 integration in Docker Desktop -> Settings -> Resources -> WSL Integration -> Ubuntu
REM If you see "mkdir C:\Program Files\Git\var: Access is denied", run via WSL2 Ubuntu instead.

set FABRIC_VERSION=2.5.16
set CA_VERSION=1.5.17

echo [1/4] Checking Docker...
docker --version >nul 2>&1
if errorlevel 1 (
  echo ERROR: Docker not found. Install Docker Desktop and enable WSL2 integration.
  exit /b 1
)
docker ps >nul 2>&1
if errorlevel 1 (
  echo ERROR: Docker daemon not running. Start Docker Desktop.
  exit /b 1
)

echo [2/4] Bringing up Fabric test-network (mychannel, CA)...
pushd fabric-samples\test-network
REM Use Git Bash with path conversion disabled for docker, but enabled for fabric-ca
set MSYS_NO_PATHCONV=0
set COMPOSE_CONVERT_WINDOWS_PATHS=1
"C:\Program Files\Git\bin\bash.exe" -c "./network.sh down"
if errorlevel 1 echo Warning: network down failed, continuing...
REM For Windows, prefer WSL2: wsl bash -c "cd /mnt/c/Users/arnav/se_project/fabric-samples/test-network && ./network.sh up createChannel -c mychannel -ca"
REM Attempt Git Bash up; if it fails due to path conversion, follow manual WSL2 steps in README
"C:\Program Files\Git\bin\bash.exe" -c "./network.sh up createChannel -c mychannel -ca"
if errorlevel 1 (
  echo.
  echo =========================================
  echo  FABRIC UP FAILED on Windows Git Bash (path conversion)
  echo  Manual WSL2 steps:
  echo   1. Enable WSL2 integration in Docker Desktop
  echo   2. Open Ubuntu WSL2: wsl
  echo   3. cd /mnt/c/Users/arnav/se_project/fabric-samples/test-network
  echo   4. ./network.sh up createChannel -c mychannel -ca
  echo   5. ./network.sh deployCC -ccn deviceregistry -ccp ../../chaincode/device-registry -ccl javascript -c mychannel
  echo  Or use: wsl bash -c "cd /mnt/c/Users/arnav/se_project/fabric-samples/test-network && ./network.sh up createChannel -c mychannel -ca && ./network.sh deployCC -ccn deviceregistry -ccp ../../chaincode/device-registry -ccl javascript -c mychannel"
  echo =========================================
  popd
  exit /b 1
)

echo [3/4] Deploying chaincode device-registry...
"C:\Program Files\Git\bin\bash.exe" -c "./network.sh deployCC -ccn deviceregistry -ccp ../../chaincode/device-registry -ccl javascript -c mychannel"
if errorlevel 1 (
  echo ERROR: Chaincode deploy failed. Check logs above.
  popd
  exit /b 1
)

popd

echo [4/4] Verifying...
docker ps | findstr "peer0.org1"
if errorlevel 1 (
  echo ERROR: peer0.org1 not running
  exit /b 1
)

echo.
echo =========================================
echo  Fabric READY: peer0.org1:7051, channel mychannel, chaincode deviceregistry
echo  Set FABRIC_ENABLED=true in .env and restart gateway: node gateway.js
echo  Test: node -e "require('dotenv').config(); require('./fabric-client').getAllDevices().then(d=>console.log(d)).catch(e=>console.log(e.message))"
echo =========================================
