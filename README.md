# Dual-Ledger IoT IAM Gateway

A production-oriented IoT identity and access management (IAM) gateway that integrates a Hyperledger Fabric blockchain ledger with a PostgreSQL-backed operational datastore. The system authenticates edge devices via HMAC-style cryptographic signatures, enforces per-device access policy, and exposes a real-time administrative console.

## Architecture

```
┌─────────────────┐   HTTPS    ┌──────────────────────────────────────┐
│  Edge Devices   │ ─────────▶ │  Express API Gateway (Node.js)       │
│  (iot_simulator)│  signatures │  port 3000                          │
└─────────────────┘            │                                      │
                               │  ┌─────────────┐   ┌───────────────┐ │
┌─────────────────┐   HTTPS    │  │ Fabric      │   │ Supabase      │ │
│  Admin Console  │ ─────────▶ │  │ client      │   │ client        │ │
│  (React + Vite) │  JWT       │  │ (ledger)    │   │ (Postgres)    │ │
└─────────────────┘            │  └─────────────┘   └───────────────┘ │
└───────────────────────────────────────────────────┘
```

### Components

| Layer | Technology | Responsibility |
|---|---|---|
| **API Gateway** | Node.js, Express 5 | Request routing, signature validation, JWT authorization, log persistence |
| **Fabric client** | `@hyperledger/fabric-gateway` | Device registry operations against the Hyperledger Fabric channel |
| **Chaincode** | Node.js, `fabric-contract-api` | `device-registry` smart contract storing device identity in world state |
| **Datastore** | Supabase (PostgreSQL) | Persistent `devices` and `access_logs` tables; Supabase Auth for console users |
| **Frontend** | React 19, Vite, Tailwind CSS v4 | Real-time admin dashboard with live ledger/log/device telemetry |

### Operation modes

The gateway runs in one of two ledger modes, selected at startup:

- **`FABRIC`** — device state is read/written via `fabric-client.js` against a live Hyperledger Fabric network. Set `FABRIC_ENABLED=true`.
- **`IOTA`** — device state is read/written via `iota-client.js` against the IOTA Tangle using the Notarization toolkit (one updatable Dynamic Notarization object per device). Set `IOTA_ENABLED=true`.
- **`MOCK`** — device state is served from Supabase Postgres when configured (`dbMode: POSTGRES`), otherwise from an in-memory seed (`dbMode: MEMORY`). This is the default for local development.

When a ledger operation fails (network unreachable), the gateway degrades gracefully: `ledgerError` is populated in `/api/state` and device reads fall back to the datastore.

The active data path is selected per-request by `activeRoute` (see `/api/route`): it picks the IOTA backend when set to `IOTA` and IOTA is enabled, the Fabric backend when set to `FABRIC` and Fabric is enabled, and otherwise falls back to the datastore.

## Repository layout

```
.
├── gateway.js                    # Express API gateway (entrypoint)
├── fabric-client.js              # Hyperledger Fabric gateway SDK wrapper
├── iota-client.js                # IOTA Tangle (Notarization toolkit) adapter
├── supabase-db.js                # Supabase/Postgres persistence layer
├── supabase-schema.sql           # DDL for devices + access_logs tables
├── iot_simulator.py              # Edge device simulator (signed request stream)
├── start-all.bat                 # Launches gateway + frontend on login
├── .env.example                  # Backend environment template
├── .iota-key.json                # Generated IOTA signer keypair (git-ignored)
├── .iota-registry.json           # Device -> notarization mapping (git-ignored)
├── chaincode/
│   └── device-registry/          # Fabric smart contract (fabric-contract-api)
└── frontend/
    ├── src/
    │   ├── App.jsx               # Session-aware route protection
    │   ├── Login.jsx             # Supabase Auth login screen
    │   ├── AdminDashboard.jsx    # Real-time admin console
    │   └── lib/                  # Supabase client + authenticated fetch helpers
    └── .env.example              # Frontend environment template
```

## Prerequisites

- Node.js >= 20 (tested on v26)
- npm >= 10
- Python 3.8+ with `requests` for the device simulator
- A Supabase project (free tier is sufficient)
- Optional: Hyperledger Fabric network (test-network) for `FABRIC` mode

## Getting started

### 1. Install dependencies

```bash
# Backend
npm install

# Frontend
cd frontend && npm install && cd ..

# Chaincode (only required for Fabric deployment)
cd chaincode/device-registry && npm install && cd ../..
```

### 2. Configure environment

Create environment files from the templates:

```bash
cp .env.example .env
cp frontend/.env.example frontend/.env
```

**Backend `.env`**

| Variable | Required | Description |
|---|---|---|
| `PORT` | no | Gateway listen port (default `3000`) |
| `SUPABASE_URL` | yes | Supabase project URL (`https://<ref>.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Service-role key (server-side only; bypasses RLS) |
| `SUPABASE_JWT_SECRET` | yes | JWT secret used for HS256 fallback verification |
| `FABRIC_ENABLED` | no | `true` to use the Fabric ledger (default `false`) |
| `CHANNEL_NAME` | no | Fabric channel name (default `mychannel`) |
| `CHAINCODE_NAME` | no | Fabric chaincode name (default `deviceregistry`) |
| `MSP_ID` | no | Organization MSP ID (default `Org1MSP`) |
| `CRYPTO_PATH` | no | Path to the organization's crypto material |
| `PEER_ENDPOINT` / `PEER_HOST_ALIAS` | no | Peer gRPC endpoint and host alias |

**Frontend `.env`**

| Variable | Required | Description |
|---|---|---|
| `VITE_SUPABASE_URL` | yes | Supabase project URL (must match backend) |
| `VITE_SUPABASE_ANON_KEY` | yes | **Anon / publishable** key (client-safe; `sb_publishable_...`) |
| `VITE_GATEWAY_URL` | no | Backend base URL (default `http://localhost:3000`) |

> **Security note:** `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_JWT_SECRET` must never be exposed to the frontend. Both `.env` files are covered by `.gitignore`; only the `.env.example` templates are committed.

### 3. Provision the database

Run `supabase-schema.sql` in the Supabase SQL Editor. It creates:

```sql
devices (id text PK, public_key text NOT NULL, status text DEFAULT 'ACTIVE', created_at timestamptz DEFAULT now())
access_logs (request_id text PK, device_id text, endpoint text, status text, route text, hash text, created_at timestamptz DEFAULT now())
```

Row Level Security is enabled on both tables; the service-role key bypasses RLS for backend access. Create at least one user under **Supabase Auth → Users** to sign in to the console.

### 4. Start the gateway

```bash
node gateway.js
```

On startup the gateway:

1. Loads the Supabase JWKS public keys (ES256) used to verify access tokens.
2. Seeds the initial device set into Postgres if the `devices` table is empty.
3. Listens for HTTP requests on `PORT`.

### 5. Start the frontend

```bash
cd frontend
npm run dev
```

Open `http://127.0.0.1:5173` and sign in with the Supabase Auth user.

### 6. Run the device simulator

```bash
python iot_simulator.py
```

The simulator fetches the registered device list and continuously posts cryptographically signed access requests to `/api/access`.

### 7. One-shot startup (optional)

Double-click `start-all.bat` (or copy its shortcut into the Windows Startup folder) to launch the gateway and frontend together on login.

## API reference

### Device-facing

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/access` | Device signature | Validates a signed access request; returns `200` (granted), `401` (bad signature), or `403` (device revoked) |

Request schema:

```json
{
  "device_id": "SmartLock_FrontDoor",
  "action": "unlock",
  "timestamp": "1760000000",
  "signature": "<sha256(device_id:action:timestamp)>"
}
```

### Console-facing

All console endpoints require an `Authorization: Bearer <supabase-access-token>` header. Tokens are verified against the project JWKS (ES256) with an HS256 fallback for legacy projects. When `SUPABASE_JWT_SECRET` is unset, auth is bypassed for local development.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/state` | Full dashboard state: devices, access logs, TPS history, ledger mode, persistence mode |
| `GET` | `/api/devices` | Registered device list |
| `POST` | `/api/route` | Switch active ledger route (`FABRIC` / `IOTA`) |
| `POST` | `/api/devices/toggle` | Toggle a device between `ACTIVE` and `REVOKED` |
| `POST` | `/api/devices/register` | Register a new device; emits a `REGISTERED` log entry |
| `POST` | `/api/stress` | Toggle stress-test pacing on the simulator |

### Response statuses (device access)

| Code | Meaning |
|---|---|
| `200` | Signature valid, device active — access granted |
| `401` | Signature mismatch or missing fields — rejected |
| `403` | Signature valid but device status is `REVOKED` |

## Hyperledger Fabric integration

The `device-registry` chaincode exposes the following transaction functions:

| Transaction | Description |
|---|---|
| `InitLedger` | Seeds the three default devices into world state |
| `RegisterDevice` | Enroll a device as `ACTIVE` with a public key |
| `ReadDevice` / `DeviceExists` | Read device identity by ID |
| `UpdateDevicePublicKey` | Rotate a device public key |
| `SetDeviceStatus` / `RevokeDevice` / `ActivateDevice` | Manage device lifecycle |
| `ToggleDeviceStatus` | Flip between `ACTIVE` and `REVOKED` |
| `GetAllDevices` | Enumerate all devices |
| `DeleteDevice` | Remove a device record |

The gateway connects through `fabric-client.js`, which reads connection profile and crypto material from the paths configured in `.env`. Deploy the chaincode to a running Fabric test-network before enabling `FABRIC_ENABLED=true`.

## IOTA Tangle integration

The gateway stores device identity on the IOTA Tangle via the [IOTA Notarization toolkit](https://github.com/iotaledger/notarization) (Rebased protocol). Every device is represented by a **Dynamic Notarization** object whose on-chain `state` holds `{ device_id, public_key, status }`; the object's immutable description stores the device ID and its metadata tracks the last update timestamp.

### Publishing the Notarization package

The toolkit's Move package must be published to the IOTA network once; the resulting package ID goes in `.env` as `IOTA_NOTARIZATION_PKG_ID`:

1. Install the IOTA CLI: `cargo install iota --version 1.14.0` (requires Rust toolchain).
2. Create a testnet environment and an account:
   ```bash
   iota client new-env --alias testnet --rpc https://api.testnet.iota.cafe
   iota client switch --env testnet
   iota client new-address ed25519
   ```
3. Fund the account with test tokens from the [testnet faucet](https://faucet.testnet.iota.cafe), then:
   ```bash
   iota client switch --address <YOUR_ADDRESS>
   ```
4. Clone the toolkit and publish:
   ```bash
   git clone https://github.com/iotaledger/notarization.git
   cd notarization/notarization-move
   ./scripts/publish_package.sh
   ```
5. Copy the printed package ID (e.g. `0x…`) into `IOTA_NOTARIZATION_PKG_ID`.

### Runtime behavior

- On startup, if `IOTA_ENABLED=true`, the gateway connects to the node (`IOTA_NODE_URL`, default `https://api.testnet.iota.cafe`), funds its signer address from the faucet when empty, and notarizes the seeded devices.
- The gateway signer is an Ed25519 keypair: set `IOTA_PRIVATE_KEY` to pin it, otherwise a keypair is generated and persisted to `.iota-key.json`.
- Device → notarization mappings are tracked locally in `.iota-registry.json` (created automatically).
- `register`, `toggle`, and `revoke` operations update the device's on-chain state; reads fetch the live state from the Tangle.
- The explorer URL for any notarization is `<IOTA_NODE_URL> + "/object/" + <notarization_id>` on the Rebased explorer.

## Security model

- **Device authentication** uses SHA-256 signatures over `device_id:action:timestamp` — no shared secrets cross the wire.
- **Console authorization** uses Supabase Auth JWTs verified server-side against the project signing keys.
- **Secrets management**: service-role and JWT secret live only in the backend `.env`; the frontend ships only the anon/publishable key.
- **RLS**: both database tables have Row Level Security enabled; backend access uses the service-role key.
- **CORS**: the gateway whitelists `Content-Type` and `Authorization` headers and responds to preflight `OPTIONS`.

## Development

```bash
# Frontend build + lint
cd frontend
npm run build
npm run lint        # oxlint

# Backend syntax check
node --check gateway.js
```

## License

Apache-2.0 (chaincode) / ISC (project).
