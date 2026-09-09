#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
state_dir="$root/ops/state"
version="${1:-$(git -C "$root" rev-parse --short=12 HEAD)}"
compose=(docker compose --env-file "$root/.env" -f "$root/ops/compose.production.yml")

[[ "$version" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { echo "Invalid image tag: $version" >&2; exit 2; }
if [ "${ALLOW_DIRTY_DEPLOY:-false}" != "true" ] \
  && [ -n "$(git -C "$root" status --porcelain --untracked-files=normal)" ]; then
  echo "Refusing to deploy an uncommitted worktree; commit it or set ALLOW_DIRTY_DEPLOY=true with a unique tag." >&2
  exit 2
fi
if docker image inspect "iot-gateway:$version" >/dev/null 2>&1 \
  || docker image inspect "iot-frontend:$version" >/dev/null 2>&1; then
  echo "Refusing to overwrite existing immutable image tag: $version" >&2
  exit 2
fi

mkdir -p "$state_dir"
mkdir -p "$root/runtime"
previous="$(cat "$state_dir/current-version" 2>/dev/null || true)"
IMAGE_TAG="$version" "${compose[@]}" config --quiet
IMAGE_TAG="$version" "${compose[@]}" build --pull gateway frontend
IMAGE_TAG="$version" "${compose[@]}" up -d --remove-orphans --wait

if [[ -n "$previous" && "$previous" != "$version" ]]; then
  printf '%s\n' "$previous" > "$state_dir/previous-version"
fi
printf '%s\n' "$version" > "$state_dir/current-version"
echo "Deployed $version"
