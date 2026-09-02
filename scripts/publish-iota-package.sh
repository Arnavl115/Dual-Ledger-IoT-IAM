#!/usr/bin/env bash
# Publish IOTA Notarization Move package to testnet and capture package ID
# Requires: Rust toolchain, cargo, IOTA CLI 1.14.0, funded testnet address
# Outputs: IOTA_NOTARIZATION_PKG_ID to be set in .env
set -e

NODE_URL=${IOTA_NODE_URL:-https://api.testnet.iota.cafe}
FAUCET_URL=${IOTA_FAUCET_URL:-https://faucet.testnet.iota.cafe}

echo "========================================="
echo " IOTA Notarization Package Publish"
echo "========================================="

if ! command -v iota &>/dev/null; then
  echo "[1/5] Installing IOTA CLI 1.14.0 (requires Rust)..."
  cargo install iota --version 1.14.0 --locked
fi

echo "[1/5] IOTA CLI: $(iota --version 2>&1 | head -1)"
echo "      Node: $NODE_URL"

# 2. Ensure testnet env and address
if ! iota client envs 2>&1 | grep -q testnet; then
  echo "[2/5] Creating testnet env..."
  iota client new-env --alias testnet --rpc "$NODE_URL"
fi
iota client switch --env testnet || true

if ! iota client addresses 2>&1 | grep -q "0x"; then
  echo "[2/5] Creating new Ed25519 address..."
  iota client new-address ed25519
fi

ADDR=$(iota client addresses 2>&1 | grep -o "0x[0-9a-f]*" | head -1)
echo "      Active address: $ADDR"

# 3. Fund from faucet if empty
echo "[3/5] Checking balance..."
BALANCE=$(iota client balance --address "$ADDR" 2>&1 | grep -o "[0-9]*" | head -1 || echo "0")
if [ "$BALANCE" = "0" ] || [ -z "$BALANCE" ]; then
  echo "      Requesting faucet funds for $ADDR ..."
  curl -c /tmp/iota-cookie.txt -s "$FAUCET_URL" > /dev/null || true
  # Use IOTA faucet API
  iota client faucet --address "$ADDR" 2>&1 | head -20 || echo "      Try manual faucet: https://faucet.testnet.iota.cafe -> paste $ADDR"
  echo "      Waiting 5s for funds..."
  sleep 5
fi
iota client switch --address "$ADDR" || true

# 4. Clone and publish Notarization Move package
if [ ! -d "/tmp/notarization" ]; then
  echo "[4/5] Cloning iotaledger/notarization..."
  git clone https://github.com/iotaledger/notarization.git /tmp/notarization
else
  echo "[4/5] Updating /tmp/notarization..."
  (cd /tmp/notarization && git pull --ff-only || true)
fi

cd /tmp/notarization/notarization-move
echo "      Publishing Move package (this may take 1-2 minutes)..."
./scripts/publish_package.sh 2>&1 | tee /tmp/iota-publish.log
PKG_ID=$(grep -o "0x[0-9a-f]\{64\}" /tmp/iota-publish.log | head -1 || grep -o "0x[0-9a-f]*" /tmp/iota-publish.log | head -1)

if [ -z "$PKG_ID" ]; then
  echo "ERROR: Could not extract package ID. Check /tmp/iota-publish.log"
  cat /tmp/iota-publish.log
  exit 1
fi

echo ""
echo "========================================="
echo " Publish SUCCESS"
echo " Package ID: $PKG_ID"
echo " Explorer: https://explorer.rebased.iota.cafe/object/$PKG_ID"
echo ""
echo " Next steps:"
echo "  1. Set in .env: IOTA_NOTARIZATION_PKG_ID=$PKG_ID"
echo "  2. Set IOTA_ENABLED=true"
echo "  3. Restart gateway: node gateway.js"
echo "  4. Verify: node -e \"require('dotenv').config(); require('./iota-client').getAllDevices().then(console.log)\""
echo "========================================="
echo " Full log: /tmp/iota-publish.log"
