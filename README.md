# Dual-Ledger IoT IAM Gateway — Production

A production-hardened IoT identity and access management gateway. Authenticates edge devices via **real ECDSA P-256 signatures** (`device_id:action:timestamp` → `crypto.verify('sha256')`), enforces **per-device `ACTIVE|REVOKED` policy on-chain**, and exposes a real-time admin console. No hardcoded demo identities — every device must be registered with a **real PEM public key** (supplied by the device or `iot_simulator.py`).

```
┌─────────────────┐   HTTPS    ┌──────────────────────────────────────┐
│  Edge Devices   │ ─────────▶ │  Express API Gateway (Node.js)       │
│  (iot_simulator │  ECDSA sig  │  port 3000 — no demo seed            │
│   or real hw)   │  + replay   │  timestamp 5m window + rate-limit    │
└─────────────────┘   protection│  ┌─────────────┐   ┌───────────────┐ │
┌─────────────────┐   HTTPS    │  │ Fabric      │   │ Supabase      │ │
│  Admin Console  │ ─────────▶ │  │ client      │   │ client        │ │
│  (React + Vite) │  JWT       │  │ (ledger)    │   │ (Postgres)    │ │
└─────────────────┘            │  └─────────────┘   └───────────────┘ │
└───────────────────────────────────────────────────┘
                                 │  ┌─────────────┐                  │
                                 │  │ IOTA        │                  │
                                 │  │ Notarization│                  │
                                 │  └─────────────┘                  │
```

## Components — all real, no mocks in production

| Layer | Technology | Production behavior |
|---|---|---|
| **API Gateway** | Node.js 20+, Express 5, `crypto` | ECDSA P-256 verification, 5-min timestamp freshness, replay cache, 120 req/min rate-limit, `helmet`-lite headers, CORS restricted to `FRONTEND_URL`, `POSTGRES` persistence, `/health` |
| **Fabric client** | `@hyperledger/fabric-gateway@1.12`, `@grpc/grpc-js` | Real gRPC TLS to `peer0.org1:7051`, MSP `Org1MSP`, channel `mychannel`, chaincode `deviceregistry` — all 9 transactions actively used |
| **Chaincode** | Node `fabric-contract-api@2.5` | `device-registry` — `InitLedger` (idempotent, no fake `0x...` seed), `RegisterDevice` (P-256 validation, event), `ReadDevice`, `UpdateDevicePublicKey`, `SetDeviceStatus`/`Revoke`/`Activate`/`Toggle`, `DeleteDevice`, `GetAllDevices`, `GetDeviceHistory` (events: `DeviceRegistered`, `DeviceKeyRotated`, `DeviceStatusChanged`, etc.) |
| **IOTA** | `@iota/iota-sdk@1.15`, `@iota/notarization@0.1.14` | Dynamic Notarization — one updatable and destroyable on-chain object per device, `state={device_id,public_key,status}`, Ed25519 signer (`iotaprivkey1...` or generated `.iota-key.json`), faucet auto-fund |
| **Datastore** | Supabase Postgres | `devices(id PK, public_key NOT NULL, status, created_at)` + `access_logs(request_id PK, device_id, endpoint, status, route, hash, created_at)` — RLS enabled, service-role bypass, no fake seed |
| **Frontend** | React 19, Vite 8, Tailwind 4, `chart.js` | Real `VITE_GATEWAY_URL` + Supabase Auth (ES256 JWKS), live selected-route and actual-backend reporting |

**Operation modes** (selected at startup via env, switched per-request via `activeRoute`):
- `FABRIC` (`FABRIC_ENABLED=true` + peer `7051` live + `deviceregistry` deployed) — reads/writes via `fabric-client.js`
- `IOTA` (`IOTA_ENABLED=true` + `IOTA_NOTARIZATION_PKG_ID` set) — reads/writes via `iota-client.js` (Dynamic Notarization)
- Neither ledger enabled: the active backend is `POSTGRES` when configured, otherwise `MEMORY`. Dashboard reads may fall back to Postgres when a selected ledger is unreachable, but device authorization fails closed with `503` rather than trusting projected state.

## Repository layout
```
.
├── gateway.js                    # Production gateway (no hardcoded demo logs/devices)
├── fabric-client.js              # Fabric Gateway SDK — real TLS/MSP, all txns exposed
├── iota-client.js                # IOTA Notarization adapter (mirrors fabric-client)
├── supabase-db.js                # Postgres layer (real, no fake seed)
├── supabase-schema.sql           # DDL + RLS
├── iot_simulator.py              # ONLY test component — real ECDSA P-256 device emulator
├── chaincode/device-registry/    # Production chaincode (events, validation, history)
├── frontend/                     # Admin console (Vite)
├── scripts/
│   ├── deploy-fabric.sh          # Linux/WSL2: up + createChannel + deployCC
│   ├── deploy-fabric.bat         # Windows: Git Bash + Docker Desktop
│   └── publish-iota-package.sh   # Publish Notarization Move package
├── .env.example                  # Backend template (FRONTEND_URL, SEED_DEMO_DEVICES=false)
└── frontend/.env.example
```

## Prerequisites — production

- Node.js >=20, npm >=10, Python 3.8+ (`pip install -r requirements.txt`)
- Supabase project (free tier OK) + `supabase-schema.sql` executed
- **Fabric (for `FABRIC` mode):** Docker Engine 20+ & `docker compose` v2, WSL2 Ubuntu 22.04+ on Windows (Docker Desktop → Settings → Resources → WSL Integration → Ubuntu), `curl`, `jq`, `Go` (for chaincode), `fabric-samples/bin` (Linux binaries)
- **IOTA (for `IOTA` mode):** Rust toolchain, `cargo install iota --version 1.14.0`, testnet IOTA tokens via faucet

## Quick start (MOCK + POSTGRES — no ledger)

```bash
git submodule update --init --recursive
npm install
cd frontend && npm install && cd ..
cd chaincode/device-registry && npm install && cd ../..

cp .env.example .env          # set Supabase backend, frontend, and simulator credentials
cp frontend/.env.example frontend/.env  # same SUPABASE_URL + ANON_KEY

# Provision DB: Supabase Dashboard → SQL Editor → run supabase-schema.sql
# Create Auth user: Dashboard → Authentication → Users → Add user
# Set that user's app_metadata.role to "admin" before using the console/simulator
# For the simulator, set SUPABASE_ANON_KEY + SIMULATOR_EMAIL/PASSWORD,
# or provide a short-lived admin-user SIMULATOR_ACCESS_TOKEN. Never use service_role.

node gateway.js               # → 🔗 Ledger backend: MOCK  🗄️ POSTGRES (Supabase)
cd frontend && npm run dev    # → http://localhost:5173
python iot_simulator.py       # provisions only simulator-owned IDs, then streams signed requests
```

Gateway on startup: loads JWKS (`/auth/v1/.well-known/jwks.json`), **does NOT seed fake `0x...` devices** (production: `SEED_DEMO_DEVICES=false`), listens on `PORT`.

The simulator authenticates device listing and registration with an admin user JWT. It never reads or accepts the unrestricted service-role key. Existing device IDs are used only when their registered public key matches `ecdsa_keys.json`; otherwise startup fails rather than replacing the real device key. `POST /api/devices/register` is create-only; intentional rotation uses `/api/devices/update-key`.

## Production: Hyperledger Fabric

**What you must do manually (Windows):**

1. **Enable WSL2 + Docker Desktop integration**
   - Install WSL2 Ubuntu: `wsl --install`
   - Docker Desktop → Settings → Resources → WSL Integration → Enable Ubuntu
   - Verify: `wsl bash -c "docker ps"` shows containers (not `docker: command not found`)

2. **Deploy Fabric network + chaincode** (choose one):

   **Option A — WSL2 Ubuntu (recommended):**
   ```bash
   wsl
   cd /mnt/c/Users/arnav/se_project
   bash scripts/deploy-fabric.sh
   # Equivalent manual:
   cd fabric-samples/test-network
   ./network.sh up createChannel -c mychannel -ca
   ./network.sh deployCC -ccn deviceregistry -ccp ../../chaincode/device-registry -ccl javascript -c mychannel
   ```

   **Option B — Windows Git Bash:**
   ```powershell
   scripts\deploy-fabric.bat
   # If path conversion error "mkdir C:\Program Files\Git\var", use WSL2 steps above
   ```

   Verify: `docker ps | grep peer0.org1` and `docker logs peer0.org1.example.com` should show chaincode container `dev-peer0.org1...-deviceregistry`.

3. **Configure gateway for Fabric:**
   ```env
   FABRIC_ENABLED=true
   CHANNEL_NAME=mychannel
    CHAINCODE_NAME=deviceregistry
    MSP_ID=Org1MSP
    FABRIC_IDENTITY=Admin@org1.example.com
    CRYPTO_PATH=./fabric-samples/test-network/organizations/peerOrganizations/org1.example.com
   PEER_ENDPOINT=localhost:7051
   PEER_HOST_ALIAS=peer0.org1.example.com
   ```
   Restart: `node gateway.js` → `🔗 Ledger backend: FABRIC` (no `ledgerError`).

4. **Test Fabric path:**
   ```bash
   node -e "require('dotenv').config(); require('./fabric-client').getAllDevices().then(c=>console.log('Fabric devices',c.length)).catch(e=>console.error(e.message))"
   curl -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" http://localhost:3000/api/state | jq .ledgerMode,.ledgerError
   ```

   Chaincode transactions actively used (all 9 via gateway):
   ```
   RegisterDevice, ReadDevice, DeviceExists, UpdateDevicePublicKey, SetDeviceStatus,
   RevokeDevice, ActivateDevice, ToggleDeviceStatus, GetAllDevices, DeleteDevice, GetDeviceHistory
   ```
   New gateway endpoints expose them: `POST /api/devices/revoke`, `/activate`, `/update-key`, `DELETE /api/devices/:id`.

**Chaincode production notes:** `InitLedger` is now idempotent and emits `InitLedger` event — it **does not** seed `0x4F...` fake keys. Devices must be registered with canonical P-256 SPKI PEMs via `RegisterDevice` and IDs matching `^[A-Za-z0-9_-]{3,64}$`. Mutations require an `Org1MSP` certificate with `OU=admin`; the gateway uses `FABRIC_IDENTITY=Admin@org1.example.com` by default. All mutations emit events (`DeviceRegistered`, `DeviceStatusChanged`, etc.) and record `RegisteredBy`/`UpdatedBy` (`MSP:cert`).

## Production: IOTA Tangle

**What you must do manually:**

1. **Install IOTA CLI** (requires Rust):
   ```bash
   cargo install iota --version 1.14.0 --locked
   iota --version
   ```

2. **Publish Notarization Move package** (one-time):
   ```bash
   bash scripts/publish-iota-package.sh
   # Or manually:
   iota client new-env --alias testnet --rpc https://api.testnet.iota.cafe
   iota client switch --env testnet
   iota client new-address ed25519
   iota client faucet --address <YOUR_ADDRESS>  # or https://faucet.testnet.iota.cafe
   git clone https://github.com/iotaledger/notarization.git /tmp/notarization
   cd /tmp/notarization/notarization-move && ./scripts/publish_package.sh
   # Copy printed 0x... package ID
   ```

3. **Configure gateway for IOTA:**
   ```env
   IOTA_ENABLED=true
   IOTA_NODE_URL=https://api.testnet.iota.cafe
   IOTA_FAUCET_URL=https://faucet.testnet.iota.cafe
   IOTA_NOTARIZATION_PKG_ID=0x<your_package_id>
   # Optional: pin signer
   # IOTA_PRIVATE_KEY=iotaprivkey1q...
   ```
   Restart: `node gateway.js` → `🔗 Ledger backend: IOTA` → `🌱 [IOTA] Connected to ...` → faucet funds address if empty → notarizes devices.

   Gateway stores its signer in `.iota-key.json` and a recoverable `device→notarization` cache in `.iota-registry.json` (both git-ignored). On startup it rebuilds the cache from notarizations owned by the signer; registry writes use atomic file replacement.

   Verify: `node -e "require('dotenv').config(); require('./iota-client').getAllDevices().then(console.log)"` and explorer `https://explorer.iota.org/object/<object_id>?network=testnet`.

**Switching ledgers at runtime:** Admin console → `ACTIVE ROUTE` → `FABRIC` / `IOTA TANGLE` (`POST /api/route`). Only routes present in `enabledRoutes` can be selected. `activeRoute` is the selected ledger, while `activeBackend`/`ledgerMode` identify the backend that actually served the latest state read (`FABRIC`, `IOTA`, `POSTGRES`, or `MEMORY`). Empty ledger results are authoritative; dashboard reads fall back only after an error. Device authorization requires the selected ledger and returns `503` when it cannot be reached.

## Security model — production hardened

- **Device auth:** Real ECDSA P-256 `SHA256(device_id:action:timestamp)` verified via `crypto.createPublicKey` + `crypto.verify`. Validates canonical SPKI PEM and curve (`prime256v1`/`P-256`). After signature verification, the gateway atomically claims a SHA-256 request ID in `access_logs`; its primary key rejects re-signed duplicates across gateway processes and restarts. Memory-only mode uses a 5-minute request cache. `validateSignature` also enforces a **5-minute timestamp window** (`TIMESTAMP_WINDOW_MS`) + **30-second future tolerance**. `429` rate limit: 120 access requests per minute per IP.
- **Console auth:** Supabase Auth JWT verified against JWKS `ES256` (`/auth/v1/.well-known/jwks.json`) with `HS256` fallback (`SUPABASE_JWT_SECRET`). Console users must have server-controlled `app_metadata.role = "admin"`; ordinary authenticated users receive `403`. The service-role key is accepted server-to-server only. `requireAuth` `gateway.js:424`.
- **Secrets:** `SUPABASE_SERVICE_ROLE_KEY`/`JWT_SECRET` never leave `.env` (git-ignored); frontend only gets `VITE_SUPABASE_ANON_KEY`.
- **Headers:** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `HSTS` in production, `Referrer-Policy`, `Permissions-Policy`.
- **CORS:** Restricted to `FRONTEND_URL` (`http://localhost:5173` dev, your domain in prod); `*` only if explicitly set.
- **Persistence:** Every `GRANTED`/`DENIED`/`REVOKED`/`REGISTERED` log is awaited in `access_logs` with a `REQ-<UUID>` PK (retry on rare collision). The dashboard reads paginated durable history; the 40-entry memory ring is used only without Postgres.
- **RLS:** `supabase-schema.sql` enables RLS on `devices`/`access_logs`; backend uses service-role bypass.

## API reference

**Device-facing:** `POST /api/access` — `device_id, action, timestamp, signature` (base64 ECDSA). `200` granted, `400` missing fields, `401` bad sig / stale timestamp / replay / unknown device, `403` revoked, `429` rate-limit, `503` selected ledger unavailable. `routed_to` and audit `route` name the backend actually used. `GET /health` reports `activeRoute`, `activeBackend`, and `enabledRoutes`.

**Console-facing:** `Authorization: Bearer <supabase-access-token>` required.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/state` | Devices + logs + TPS + selected `activeRoute`, actual `activeBackend`, `enabledRoutes`, and fallback errors |
| `GET` | `/api/devices` | List |
| `POST` | `/api/route` | `{route:"FABRIC"\|"IOTA"}`; returns `409` when the requested ledger is disabled |
| `POST` | `/api/devices/register` | `{id, publicKey}` (P-256 SPKI PEM required, `3-64` `^[A-Za-z0-9_-]+$`) |
| `POST` | `/api/devices/toggle` | `{deviceId}` flips `ACTIVE↔REVOKED` (Fabric/IOTA/Postgres) |
| `POST` | `/api/devices/revoke` | `{deviceId}` → `REVOKED` |
| `POST` | `/api/devices/activate` | `{deviceId}` → `ACTIVE` |
| `POST` | `/api/devices/update-key` | `{deviceId, publicKey}` P-256 SPKI PEM rotation |
| `DELETE` | `/api/devices/:id` | Remove (Fabric `DeleteDevice` or IOTA `destroy` + Postgres) |
| `GET` | `/api/logs?limit=100&offset=0` | Paginated durable audit history (latest first, max 200 per page) |
| `POST` | `/api/stress` | `{isStressTesting:true}` starts a 3-second `/api/access` measurement window; results appear in `/api/state.stressReport` |

## Development & production checks

```bash
npm test                    # backend syntax: gateway, fabric-client, iota-client, supabase-db
npm run test:frontend       # cd frontend && npm run build
npm run lint                # oxlint
node --check gateway.js && node --check chaincode/device-registry/lib/deviceRegistry.js

# Production build
cd frontend && npm run build   # → dist/
NODE_ENV=production FRONTEND_URL=https://your.domain node gateway.js
```

## Manual checklist — what YOU must do for production

- [ ] **Supabase:** Create project, run `supabase-schema.sql`, create an Auth user with `app_metadata.role = "admin"`, fill `.env` + `frontend/.env`
- [ ] **Fabric (if `FABRIC` mode):** Enable WSL2 Docker integration, run `scripts/deploy-fabric.sh` (or `.bat` → fallback to WSL2), set `FABRIC_ENABLED=true` in `.env`, verify `peer0.org1:7051` and chaincode `deviceregistry` via `docker ps` + `fabric-client.getAllDevices()`
- [ ] **IOTA (if `IOTA` mode):** `cargo install iota`, `scripts/publish-iota-package.sh`, set `IOTA_NOTARIZATION_PKG_ID` + `IOTA_ENABLED=true` in `.env`
- [ ] **Gateway:** Set `FRONTEND_URL` to your frontend origin (not `*` in prod), `NODE_ENV=production`, `PORT`, `SEED_DEMO_DEVICES=false` (never `true` in prod), ensure `SUPABASE_*` set, run `node gateway.js` and check `/health` + `/api/state` (`activeBackend` matches the backend actually used and no unexpected `ledgerError`)
- [ ] **Frontend:** Set `VITE_GATEWAY_URL` to production gateway URL, `VITE_SUPABASE_*`, `npm run build`, serve `dist/` via `vite preview` or Nginx
- [ ] **Devices:** Provision real devices with P-256 keypairs (`cryptography`/`ecdsa`), register via `POST /api/devices/register` with PEM, test `POST /api/access` with fresh `timestamp` + `signature`; **never use `0x4F...` demo keys in production** (chaincode rejects non-PEM, gateway rejects fake)
- [ ] **Security:** Put gateway behind HTTPS reverse proxy (Nginx/Caddy), set `Strict-Transport-Security`, restrict Supabase RLS policies if needed, rotate `SUPABASE_JWT_SECRET` regularly

## License
Apache-2.0 (chaincode) / ISC (project).
