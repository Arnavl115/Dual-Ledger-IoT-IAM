#!/usr/bin/env bash
# Production Fabric Deploy — Linux / WSL2 Ubuntu
# Requires: Docker, docker compose, Go, Node 20+, fabric-samples binaries
# Run from repo root: bash scripts/deploy-fabric.sh
set -e
FABRIC_VERSION=2.5.16
CA_VERSION=1.5.17
ROOTDIR=$(cd "$(dirname "$0")/.." && pwd)
NETWORK_DIR="$ROOTDIR/fabric-samples/test-network"

echo "========================================="
echo " Fabric Production Deploy (Linux/WSL2)"
echo "========================================="

# 1. Check Docker
if ! command -v docker &>/dev/null; then
  echo "ERROR: docker not found. Install Docker Engine."
  exit 1
fi
if ! docker ps &>/dev/null; then
  echo "ERROR: docker daemon not running or no permission. Try: sudo usermod -aG docker $USER && newgrp docker"
  exit 1
fi

# 2. Ensure Fabric binaries (Linux) are present
if [ ! -f "$ROOTDIR/fabric-samples/bin/peer" ]; then
  echo "[1/4] Downloading Fabric binaries (Linux)..."
  curl -sSL https://bit.ly/2ysbOFE | bash -s -- $FABRIC_VERSION $CA_VERSION
  # Move binaries to expected location if needed
  if [ -d "$ROOTDIR/bin" ]; then
    mkdir -p "$ROOTDIR/fabric-samples/bin"
    cp "$ROOTDIR/bin/"* "$ROOTDIR/fabric-samples/bin/" 2>/dev/null || true
  fi
else
  echo "[1/4] Fabric binaries present: $ROOTDIR/fabric-samples/bin/peer"
fi

# 3. Bring up network
echo "[2/4] Bringing up Fabric test-network (mychannel, CA)..."
cd "$NETWORK_DIR"
./network.sh down || true
./network.sh up createChannel -c mychannel -ca
if [ $? -ne 0 ]; then
  echo "ERROR: network up failed"
  exit 1
fi

# 4. Deploy chaincode
echo "[3/4] Deploying chaincode device-registry..."
./network.sh deployCC -ccn deviceregistry -ccp ../../chaincode/device-registry -ccl javascript -c mychannel
if [ $? -ne 0 ]; then
  echo "ERROR: chaincode deploy failed"
  exit 1
fi

# 5. Verify
echo "[4/4] Verifying..."
docker ps | grep -q peer0.org1 || { echo "ERROR: peer not running"; exit 1; }
echo ""
echo "========================================="
echo " Fabric READY: peer0.org1:7051, channel mychannel, chaincode deviceregistry"
echo " Set FABRIC_ENABLED=true in .env and restart gateway: node gateway.js"
echo " Test: node -e \"require('dotenv').config(); require('./fabric-client').getAllDevices().then(d=>console.log(d))\""
echo "========================================="
