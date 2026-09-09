#!/usr/bin/env bash
# Fabric deployment entry point. Local sample-network and production operations
# are intentionally separate; this script never tears down a network.
set -euo pipefail
ROOTDIR=$(cd "$(dirname "$0")/.." && pwd)
NETWORK_DIR="$ROOTDIR/fabric-samples/test-network"
MODE=${1:-}
# shellcheck source=dependency-versions.env
. "$ROOTDIR/scripts/dependency-versions.env"

echo "========================================="
echo " Fabric Deploy"
echo "========================================="

if [ "$MODE" = "production" ]; then
  DEPLOY_SCRIPT=${FABRIC_PRODUCTION_DEPLOY_SCRIPT:-}
  [ -n "$DEPLOY_SCRIPT" ] || {
    echo "ERROR: production deployment is topology-specific." >&2
    echo "Set FABRIC_PRODUCTION_DEPLOY_SCRIPT to a reviewed executable that uses your production connection profile, MSP, endorsement policy, and change process." >&2
    exit 2
  }
  [ -x "$DEPLOY_SCRIPT" ] || { echo "ERROR: production deploy script is not executable: $DEPLOY_SCRIPT" >&2; exit 2; }
  case "$(cd "$(dirname "$DEPLOY_SCRIPT")" && pwd)/$(basename "$DEPLOY_SCRIPT")" in
    "$NETWORK_DIR"/*) echo "ERROR: fabric-samples/test-network helpers are not production deployment tools" >&2; exit 2 ;;
  esac
  exec "$DEPLOY_SCRIPT" "${@:2}"
fi

if [ "$MODE" != "local" ]; then
  echo "Usage: $0 local" >&2
  echo "       FABRIC_PRODUCTION_DEPLOY_SCRIPT=/absolute/reviewed/script $0 production [args...]" >&2
  exit 2
fi

# 1. Check Docker
if ! command -v docker &>/dev/null; then
  echo "ERROR: docker not found. Install Docker Engine."
  exit 1
fi
if ! docker ps &>/dev/null; then
  echo "ERROR: docker daemon not running or no permission. Try: sudo usermod -aG docker $USER && newgrp docker"
  exit 1
fi

# 2. Ensure verified Fabric binaries are present
if [ ! -f "$ROOTDIR/fabric-samples/bin/peer" ]; then
  echo "[1/4] Installing pinned, verified Fabric binaries..."
  (cd "$ROOTDIR" && bash ./install-fabric.sh binary)
else
  MANIFEST="$ROOTDIR/fabric-samples/bin/.verified-install"
  [ -f "$MANIFEST" ] || {
    echo "ERROR: Fabric binary has no verified-install manifest; remove fabric-samples/bin and reinstall." >&2
    exit 1
  }
  INSTALLED_FABRIC_VERSION=$("$ROOTDIR/fabric-samples/bin/peer" version 2>/dev/null | sed -n 's/^ Version: //p' | head -n 1)
  [ "$INSTALLED_FABRIC_VERSION" = "$FABRIC_VERSION" ] || {
    echo "ERROR: expected Fabric $FABRIC_VERSION, found ${INSTALLED_FABRIC_VERSION:-unknown}." >&2
    exit 1
  }
  EXPECTED_PEER_SHA=$(sed -n 's/^PEER_SHA256=\([0-9a-f]\{64\}\)$/\1/p' "$MANIFEST")
  if command -v sha256sum >/dev/null; then
    ACTUAL_PEER_SHA=$(sha256sum "$ROOTDIR/fabric-samples/bin/peer" | awk '{print $1}')
  elif command -v shasum >/dev/null; then
    ACTUAL_PEER_SHA=$(shasum -a 256 "$ROOTDIR/fabric-samples/bin/peer" | awk '{print $1}')
  else
    echo "ERROR: sha256sum or shasum is required" >&2
    exit 1
  fi
  [ -n "$EXPECTED_PEER_SHA" ] && [ "$ACTUAL_PEER_SHA" = "$EXPECTED_PEER_SHA" ] || {
    echo "ERROR: Fabric peer checksum does not match its verified-install manifest." >&2
    exit 1
  }
  echo "[1/4] Verified Fabric binary version and checksum: $INSTALLED_FABRIC_VERSION"
fi

# 3. Bring up the disposable local network only when it is not already running.
echo "[2/4] Ensuring the local Fabric test-network is running (mychannel, CA)..."
cd "$NETWORK_DIR"
if ! docker ps --format '{{.Names}}' | grep -q '^peer0.org1.example.com$'; then
  ./network.sh up createChannel -c mychannel -ca
else
  echo "      Existing local test-network retained; no destructive reset performed."
fi

# 4. Deploy chaincode
echo "[3/4] Deploying chaincode device-registry..."
./network.sh deployCC -ccn deviceregistry -ccp ../../chaincode/device-registry -ccl javascript -c mychannel

# 5. Verify
echo "[4/4] Verifying..."
docker ps | grep -q peer0.org1 || { echo "ERROR: peer not running"; exit 1; }
echo ""
echo "========================================="
echo " Fabric READY: peer0.org1:7051, channel mychannel, chaincode deviceregistry"
echo " Set FABRIC_ENABLED=true in .env and restart gateway: node gateway.js"
echo " Test: node -e \"require('dotenv').config(); require('./fabric-client').getAllDevices().then(d=>console.log(d))\""
echo "========================================="
