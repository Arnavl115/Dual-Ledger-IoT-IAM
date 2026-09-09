#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
state_dir="$root/ops/state"
target="${1:-$(cat "$state_dir/previous-version" 2>/dev/null || true)}"
[[ -n "$target" ]] || { echo "No previous version recorded; pass an IMAGE_TAG explicitly." >&2; exit 1; }

current="$(cat "$state_dir/current-version" 2>/dev/null || true)"
compose=(docker compose --env-file "$root/.env" -f "$root/ops/compose.production.yml")
IMAGE_TAG="$target" "${compose[@]}" config --quiet
IMAGE_TAG="$target" "${compose[@]}" up -d --no-build --wait gateway frontend edge

[[ -z "$current" ]] || printf '%s\n' "$current" > "$state_dir/previous-version"
printf '%s\n' "$target" > "$state_dir/current-version"
echo "Rolled back to $target"
