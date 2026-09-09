#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${DATABASE_URL:?DATABASE_URL must be a PostgreSQL connection string}"
PGDATABASE="$DATABASE_URL"
export PGDATABASE
unset DATABASE_URL
BACKUP_DIR="${BACKUP_DIR:-/var/backups/iot-gateway}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

command -v pg_dump >/dev/null || { echo "pg_dump is required" >&2; exit 1; }
command -v pg_restore >/dev/null || { echo "pg_restore is required" >&2; exit 1; }
command -v sha256sum >/dev/null || { echo "sha256sum is required" >&2; exit 1; }
mkdir -p "$BACKUP_DIR"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
partial="$BACKUP_DIR/iot-gateway-$timestamp.dump.partial"
backup="${partial%.partial}"
trap 'rm -f "$partial"' EXIT

pg_dump \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  --schema=public \
  --file="$partial"

pg_restore --list "$partial" >/dev/null
mv "$partial" "$backup"
sha256sum "$backup" > "$backup.sha256"
find "$BACKUP_DIR" -type f \( -name 'iot-gateway-*.dump' -o -name 'iot-gateway-*.dump.sha256' \) -mtime "+$RETENTION_DAYS" -delete
echo "$backup"
