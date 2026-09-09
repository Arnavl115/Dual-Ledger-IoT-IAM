# Production Operations

This runbook operates the deployable stack in `ops/compose.production.yml`: the Node gateway, static frontend, HTTPS edge proxy, Prometheus, black-box probes, and host metrics. Docker Compose applies restart supervision and blocks the edge proxy until the gateway and frontend are live.

## Host preparation

Use a supported Linux host with Docker Engine/Compose, `curl`, and PostgreSQL client tools. Create a non-root deployment user, clone to `/opt/iot-gateway`, and keep that directory on persistent storage.

1. Copy `ops/.env.production.example` to the repository-root `.env`, replace every placeholder, set `GATEWAY_UID`/`GATEWAY_GID` to the deployment user's numeric IDs, and set permissions to `0600`.
2. Put the certificate chain in `ops/tls/fullchain.pem` and private key in `ops/tls/privkey.pem`; set the key to `0600`. The certificate SAN must match the public hostname.
3. Point DNS at the host and allow inbound TCP 80/443. Port 9090 binds only to loopback; use an SSH tunnel for Prometheus.
4. If Fabric is enabled, set `FABRIC_CRYPTO_HOST_PATH` to the host organization directory and all Fabric paths to their `/fabric/organizations/...` container locations. Ensure the peer is reachable from the Compose network.
5. Do not run production with both ledgers disabled unless PostgreSQL is intentionally the authoritative backend. `/readyz` rejects in-memory persistence in production.

Validate and deploy an immutable release tag:

```bash
chmod +x ops/*.sh
./ops/deploy.sh "$(git rev-parse --short=12 HEAD)"
docker compose --env-file .env -f ops/compose.production.yml ps
curl --fail --silent https://iot.example.com/health
curl --fail --silent https://iot.example.com/readyz
```

`/health` is liveness only and does not contact dependencies. `/readyz` requires usable authentication keys, durable PostgreSQL, and every enabled Fabric/IOTA backend. It returns 503 without exposing dependency error details. Compose gates deployment and edge startup on this readiness check.

## Routine operations

Use Compose rather than starting Node directly:

```bash
docker compose --env-file .env -f ops/compose.production.yml ps
docker compose --env-file .env -f ops/compose.production.yml logs --since=30m gateway edge
docker compose --env-file .env -f ops/compose.production.yml restart gateway
docker compose --env-file .env -f ops/compose.production.yml up -d --wait
```

Container logs rotate at 10 MiB with five files. Docker supervises application processes with `unless-stopped`; `init: true` forwards signals and reaps children. Planned shutdown allows the gateway 30 seconds.

Prometheus is available at `http://127.0.0.1:9090`. It probes internal readiness and external HTTPS liveness every 15 seconds and alerts on two-minute endpoint failure, missing probes, low disk, and low memory. Connect these alert rules to the site's existing Alertmanager by adding `alerting.alertmanagers` to `ops/monitoring/prometheus.yml`; this repository cannot supply organization-specific notification credentials.

## Certificate rotation

Obtain/renew certificates with the site's ACME client outside the container, atomically replace the two files under `ops/tls`, then validate and reload:

```bash
docker compose --env-file .env -f ops/compose.production.yml exec edge nginx -t
docker compose --env-file .env -f ops/compose.production.yml exec edge nginx -s reload
openssl s_client -connect iot.example.com:443 -servername iot.example.com </dev/null 2>/dev/null | openssl x509 -noout -dates -issuer
```

## Backups

The application uses remote Supabase PostgreSQL plus two local IOTA state files. Fabric ledger backup belongs to the Fabric network operator and must cover peer/orderer ledger data and MSP material; copying Fabric container files while running is not a valid backup.

PostgreSQL backup requires the direct database connection string, not the REST URL:

```bash
sudo install -d -m 0700 -o iot-gateway -g iot-gateway /var/backups/iot-gateway
sudo install -d -m 0750 /etc/iot-gateway
sudo sh -c 'printf "%s\n" "DATABASE_URL=postgresql://..." "BACKUP_DIR=/var/backups/iot-gateway" "RETENTION_DAYS=14" > /etc/iot-gateway/backup.env'
sudo chmod 0600 /etc/iot-gateway/backup.env
sudo cp ops/systemd/iot-gateway-backup.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now iot-gateway-backup.timer
sudo systemctl start iot-gateway-backup.service
sudo journalctl -u iot-gateway-backup.service
```

`backup-postgres.sh` creates a compressed custom-format dump of the complete `public` schema, including the device timestamp trigger dependency, verifies its catalog, writes a SHA-256 sidecar, and removes files older than `RETENTION_DAYS`. Replicate `/var/backups/iot-gateway` off-host with encrypted storage and restricted access. Separately archive and encrypt `GATEWAY_DATA_HOST_PATH` after stopping gateway writes; it contains the IOTA signing key, IOTA registry, and simulator private keys.

```bash
docker compose --env-file .env -f ops/compose.production.yml stop gateway
tar czf - -C runtime . | openssl enc -aes-256-cbc -salt -pbkdf2 \
  -out /var/backups/iot-gateway/gateway-state-"$(date -u +%Y%m%dT%H%M%SZ)".tgz.enc
docker compose --env-file .env -f ops/compose.production.yml start gateway
```

## Restore drill

Restore into a separate Supabase project/database first. The command drops and recreates the two application tables, so stop the gateway and verify the target string before using `--yes`.

```bash
docker compose --env-file .env -f ops/compose.production.yml stop gateway
DATABASE_URL='postgresql://restore-target...' ./ops/restore-postgres.sh --yes /var/backups/iot-gateway/iot-gateway-TIMESTAMP.dump
psql "$DATABASE_URL" -c 'select count(*) from public.devices; select count(*) from public.access_logs;'
docker compose --env-file .env -f ops/compose.production.yml start gateway
curl --fail https://iot.example.com/readyz
```

To restore gateway state, stop the gateway, empty `GATEWAY_DATA_HOST_PATH`, decrypt and extract the selected off-host archive into it, preserve ownership for UID 1000, and restart. Confirm that the IOTA key/registry and simulator key file come from the same snapshot before allowing writes.

## Rollback

Application images are tagged by `deploy.sh`; successful deploys record current and previous tags under ignored `ops/state/`. Database schema changes must remain backward compatible during a release, or a pre-deploy backup and explicit database restore are required.

```bash
./ops/rollback.sh
# Or choose a retained image tag explicitly:
./ops/rollback.sh 1a2b3c4d5e6f
curl --fail https://iot.example.com/readyz
docker compose --env-file .env -f ops/compose.production.yml logs --since=10m gateway edge
```

Rollback uses existing local images and refuses to build. Keep at least the previous gateway/frontend image pair. If readiness fails, remove the edge from traffic, inspect logs, restore PostgreSQL/IOTA only when the failed release changed data incompatibly, and repeat the readiness and authenticated smoke tests before reopening traffic.
