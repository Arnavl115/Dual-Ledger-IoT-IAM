#!/usr/bin/env bash
# Publish IOTA Notarization Move package to testnet and capture package ID
# Requires: git, Node.js, pinned IOTA CLI, funded testnet address
# Outputs: IOTA_NOTARIZATION_PKG_ID to be set in .env
set -euo pipefail

ROOTDIR=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=dependency-versions.env
. "$ROOTDIR/scripts/dependency-versions.env"
NODE_URL=${IOTA_NODE_URL:-https://api.testnet.iota.cafe}
ENV_ALIAS=iot-gateway-testnet

echo "========================================="
echo " IOTA Notarization Package Publish"
echo "========================================="

if ! command -v iota &>/dev/null; then
  echo "ERROR: IOTA CLI $IOTA_CLI_VERSION is required. Run scripts/install-iota-cli.sh." >&2
  exit 1
fi
CLI_OUTPUT=$(iota --version 2>&1)
CLI_VERSION=$(printf '%s\n' "$CLI_OUTPUT" | sed -n 's/^iota \([0-9][0-9.]*\).*/\1/p')
if [ "$CLI_VERSION" != "$IOTA_CLI_VERSION" ]; then
  echo "ERROR: IOTA CLI $IOTA_CLI_VERSION is required; found: $CLI_OUTPUT" >&2
  echo "Install the verified release with scripts/install-iota-cli.sh." >&2
  exit 1
fi

echo "[1/5] IOTA CLI: $CLI_OUTPUT"
echo "      Node: $NODE_URL"

# 2. Ensure the dedicated environment alias points at the configured node.
ENVS_JSON=$(iota client envs --json)
ENV_STATE=$(printf '%s' "$ENVS_JSON" | node -e '
let value = ""; process.stdin.on("data", chunk => value += chunk).on("end", () => {
  const parsed = JSON.parse(value); const envs = Array.isArray(parsed[0]) ? parsed[0] : parsed;
  const env = envs.find(item => item && item.alias === process.argv[1]);
  if (!env) return process.stdout.write("missing");
  const rpc = String(env.rpc || env.rpcUrl || env.url || "").replace(/\/$/, "");
  process.stdout.write(rpc === process.argv[2].replace(/\/$/, "") ? "match" : "mismatch");
});' "$ENV_ALIAS" "$NODE_URL")
if [ "$ENV_STATE" = "missing" ]; then
  echo "[2/5] Creating verified testnet environment..."
  iota client new-env --alias "$ENV_ALIAS" --rpc "$NODE_URL"
elif [ "$ENV_STATE" != "match" ]; then
  echo "ERROR: IOTA environment $ENV_ALIAS does not point to $NODE_URL; remove or correct it before publishing." >&2
  exit 1
fi
iota client switch --env "$ENV_ALIAS"

if ! iota client active-address --json >/dev/null 2>&1; then
  echo "[2/5] Creating new Ed25519 address..."
  iota client new-address ed25519
fi

ADDR=$(iota client active-address --json | node -e '
let value = ""; process.stdin.on("data", chunk => value += chunk).on("end", () => {
  const address = JSON.parse(value);
  if (typeof address !== "string" || !/^0x[0-9a-f]{64}$/.test(address)) process.exit(1);
  process.stdout.write(address);
});')
echo "      Active address: $ADDR"

# 3. Confirm the selected address and let publish report insufficient gas.
echo "[3/5] Selecting active address..."
iota client switch --address "$ADDR"

# 4. Fetch the exact source revision used to publish @iota/notarization@0.1.14.
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT
SOURCE_DIR="$WORK_DIR/notarization"
PUBLISH_JSON="$WORK_DIR/publish.json"
echo "[4/5] Fetching pinned notarization source $IOTA_NOTARIZATION_COMMIT..."
git clone --filter=blob:none --no-checkout https://github.com/iotaledger/notarization.git "$SOURCE_DIR"
git -C "$SOURCE_DIR" checkout --detach "$IOTA_NOTARIZATION_COMMIT"
[ "$(git -C "$SOURCE_DIR" rev-parse HEAD)" = "$IOTA_NOTARIZATION_COMMIT" ] || {
  echo "ERROR: notarization source revision verification failed" >&2
  exit 1
}

cd "$SOURCE_DIR/notarization-move"
echo "      Publishing Move package (this may take 1-2 minutes)..."
iota client publish --with-unpublished-dependencies --silence-warnings --json --gas-budget 500000000 . | tee "$PUBLISH_JSON"
PKG_ID=$(node -e '
const fs = require("node:fs"); const response = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const ids = (response.objectChanges || []).filter(change => change.type === "published").map(change => change.packageId);
if (ids.length !== 1 || !/^0x[0-9a-f]{64}$/.test(ids[0])) process.exit(1);
process.stdout.write(ids[0]);
' "$PUBLISH_JSON")

if [ -z "$PKG_ID" ]; then
  echo "ERROR: publish response did not contain exactly one valid package ID" >&2
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
echo " The structured publish response was validated before displaying this ID."
