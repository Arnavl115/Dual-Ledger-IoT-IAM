#!/usr/bin/env bash
# Install the pinned IOTA CLI release after verifying its published SHA-256 digest.
set -euo pipefail

ROOTDIR=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=dependency-versions.env
. "$ROOTDIR/scripts/dependency-versions.env"
INSTALL_DIR=${IOTA_INSTALL_DIR:-"$HOME/.local/bin"}

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) ASSET="iota-v${IOTA_CLI_VERSION}-linux-x86_64.tgz"; SHA256=196d60784d90bb0fe7aee02a6e07db6e29d0397cc69bb576ab5894d2a9924976 ;;
  Linux-aarch64|Linux-arm64) ASSET="iota-v${IOTA_CLI_VERSION}-linux-arm64.tgz"; SHA256=a270ba2642b063f79766fd30ced7dd4a4e7080b2d7647670b3073bf77fd1beec ;;
  Darwin-arm64) ASSET="iota-v${IOTA_CLI_VERSION}-macos-arm64.tgz"; SHA256=0fbb1e1e408db2784116fadc9958cb583303a40878b2e9159da5316b234c863e ;;
  MINGW*|MSYS*|CYGWIN*) ASSET="iota-v${IOTA_CLI_VERSION}-windows-x86_64.tgz"; SHA256=8d9a08f372ef5a7c93ae1192fd771b5516e3500c6aa5cca69974d2dd1883c591 ;;
  *) echo "ERROR: no verified IOTA CLI archive for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

command -v curl >/dev/null || { echo "ERROR: curl is required" >&2; exit 1; }
if command -v sha256sum >/dev/null; then
  verify_sha256() { printf '%s  %s\n' "$1" "$2" | sha256sum --check --status; }
elif command -v shasum >/dev/null; then
  verify_sha256() { [ "$(shasum -a 256 "$2" | awk '{print $1}')" = "$1" ]; }
else
  echo "ERROR: sha256sum or shasum is required" >&2
  exit 1
fi

TMPDIR_IOTA=$(mktemp -d)
trap 'rm -rf "$TMPDIR_IOTA"' EXIT
URL="https://github.com/iotaledger/iota/releases/download/v${IOTA_CLI_VERSION}/${ASSET}"
echo "Downloading pinned IOTA CLI ${IOTA_CLI_VERSION}..."
curl --fail --location --retry 5 --output "$TMPDIR_IOTA/$ASSET" "$URL"
verify_sha256 "$SHA256" "$TMPDIR_IOTA/$ASSET" || {
  echo "ERROR: SHA-256 verification failed for $ASSET" >&2
  exit 1
}
mkdir -p "$INSTALL_DIR"
tar -xzf "$TMPDIR_IOTA/$ASSET" -C "$TMPDIR_IOTA"
CLI_PATH=$(find "$TMPDIR_IOTA" -type f \( -name iota -o -name iota.exe \) -print -quit)
[ -n "$CLI_PATH" ] || { echo "ERROR: archive did not contain the IOTA CLI" >&2; exit 1; }
install -m 0755 "$CLI_PATH" "$INSTALL_DIR/$(basename "$CLI_PATH")"
echo "Installed verified IOTA CLI at $INSTALL_DIR/$(basename "$CLI_PATH")"
