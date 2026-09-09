#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "--yes" || -z "${2:-}" ]]; then
  echo "Usage: DATABASE_URL=... $0 --yes /path/to/iot-gateway-TIMESTAMP.dump" >&2
  echo "This replaces the devices and access_logs tables in the target database." >&2
  exit 2
fi
: "${DATABASE_URL:?DATABASE_URL must identify the restore target}"
PGDATABASE="$DATABASE_URL"
export PGDATABASE
unset DATABASE_URL
backup="$2"
[[ -f "$backup" ]] || { echo "Backup not found: $backup" >&2; exit 1; }
command -v pg_restore >/dev/null || { echo "pg_restore is required" >&2; exit 1; }
command -v sha256sum >/dev/null || { echo "sha256sum is required" >&2; exit 1; }

if [[ -f "$backup.sha256" ]]; then
  (cd "$(dirname "$backup")" && sha256sum --check "$(basename "$backup").sha256")
else
  echo "Refusing an unverified backup; expected $backup.sha256" >&2
  exit 1
fi

pg_restore \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --single-transaction \
  "$backup"

echo "Restore complete. Run the readiness and record-count checks in OPERATIONS.md before starting traffic."
