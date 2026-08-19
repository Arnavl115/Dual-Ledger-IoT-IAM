require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fabric = require('./fabric-client');
const db = require('./supabase-db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Simple Custom CORS Middleware
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Gateway In-Memory State
let activeRoute = 'FABRIC';
let isStressTesting = false;
let processedCount = 0;
let requestCount = 0;

let devices = [
    { id: 'SmartLock_FrontDoor', key: '0x4F...9A1B', status: 'ACTIVE' },
    { id: 'ServerRack_A', key: '0x8C...3E4F', status: 'ACTIVE' },
    { id: 'BioLab_Fridge', key: '0x12...77CD', status: 'ACTIVE' }
];

let ledgerMode = fabric.isEnabled() ? 'FABRIC' : 'MOCK';
let ledgerError = null;
let dbMode = db.isConfigured ? 'POSTGRES' : 'MEMORY';

// Device Store Abstraction:
//   - FABRIC mode  -> reads/writes device state via fabric-client (blockchain)
//   - MOCK mode    -> reads/writes device state via Supabase Postgres when configured,
//                     otherwise falls back to the in-memory array.
const deviceStore = {
    async getAll() {
        if (ledgerMode === 'FABRIC') {
            try {
                return await fabric.getAllDevices();
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [FABRIC] getAllDevices failed: ${err.message}`);
                return dbMode === 'POSTGRES' ? await this._getAllPostgres() : devices;
            }
        }
        return dbMode === 'POSTGRES' ? await this._getAllPostgres() : devices;
    },

    async _getAllPostgres() {
        try {
            return await db.getAllDevices();
        } catch (err) {
            ledgerError = err.message;
            console.error(`   ⚠️ [POSTGRES] getAllDevices failed: ${err.message}`);
            return devices;
        }
    },

    async get(id) {
        if (ledgerMode === 'FABRIC') {
            try {
                return await fabric.getDevice(id);
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [FABRIC] getDevice failed: ${err.message}`);
            }
        }
        if (dbMode === 'POSTGRES') {
            try {
                return await db.getDevice(id);
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [POSTGRES] getDevice failed: ${err.message}`);
            }
        }
        return devices.find(d => d.id === id) || null;
    },

    async register(id, key) {
        if (ledgerMode === 'FABRIC') {
            try {
                return await fabric.registerDevice(id, key);
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [FABRIC] registerDevice failed: ${err.message}`);
            }
        }
        if (dbMode === 'POSTGRES') {
            try {
                const existing = await db.getDevice(id);
                if (!existing) {
                    await db.insertDevice(id, key, 'ACTIVE');
                }
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [POSTGRES] registerDevice failed: ${err.message}`);
            }
        }
        if (!devices.some(d => d.id === id)) {
            devices.push({ id, key, status: 'ACTIVE' });
        }
        return null;
    },

    async toggle(id) {
        if (ledgerMode === 'FABRIC') {
            try {
                return await fabric.toggleDeviceStatus(id);
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [FABRIC] toggleDeviceStatus failed: ${err.message}`);
            }
        }
        if (dbMode === 'POSTGRES') {
            try {
                const current = await db.getDevice(id);
                if (current) {
                    const newStatus = current.status === 'ACTIVE' ? 'REVOKED' : 'ACTIVE';
                    await db.updateDeviceStatus(id, newStatus);
                }
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [POSTGRES] toggleDeviceStatus failed: ${err.message}`);
            }
        }
        return null;
    }
};

// Persist an access log entry to Supabase (non-blocking; failures are logged, never crash the request).
function persistAccessLog(logEntry) {
    if (dbMode !== 'POSTGRES') return;
    db.insertAccessLog(logEntry).catch(err => {
        console.error(`   ⚠️ [POSTGRES] insertAccessLog failed: ${err.message}`);
    });
}

// Supabase signing keys (JWKS) for ES256 token verification.
// Modern Supabase projects sign access tokens with ES256 using a per-project
// public key served at /auth/v1/.well-known/jwks.json, NOT the HS256 JWT secret.
let supabaseJwks = [];

async function loadSupabaseJwks() {
    const baseUrl = (process.env.SUPABASE_URL || '').trim();
    if (!baseUrl || baseUrl.includes('YOUR_PROJECT_REF')) return;
    try {
        const res = await fetch(`${baseUrl}/auth/v1/.well-known/jwks.json`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        supabaseJwks = Array.isArray(data.keys) ? data.keys : [];
        if (supabaseJwks.length > 0) {
            console.log(`   🔐 [AUTH] Loaded ${supabaseJwks.length} Supabase signing key(s) via JWKS`);
        }
    } catch (err) {
        console.error(`   ⚠️ [AUTH] JWKS fetch failed: ${err.message}`);
    }
}

function verifySupabaseToken(token) {
    // 1) Prefer JWKS keys (ES256 / RS256) used by modern Supabase projects.
    for (const jwk of supabaseJwks) {
        try {
            const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
            return jwt.verify(token, publicKey, {
                algorithms: jwk.alg ? [jwk.alg] : ['ES256', 'RS256'],
            });
        } catch (err) {
            // try next key
        }
    }
    // 2) Fallback: legacy HS256 projects sign with the JWT secret.
    if (process.env.SUPABASE_JWT_SECRET) {
        try {
            return jwt.verify(token, process.env.SUPABASE_JWT_SECRET, {
                algorithms: ['HS256'],
            });
        } catch (err) {
            throw err;
        }
    }
    throw new Error('no verification key available');
}

// JWT verification middleware for protected API routes.
function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    // Dev mode: if Supabase auth is not configured, allow unauthenticated access.
    if (!process.env.SUPABASE_JWT_SECRET && supabaseJwks.length === 0) {
        return next();
    }

    if (!token) {
        return res.status(401).json({ error: 'Unauthorized: Missing bearer token' });
    }

    try {
        const payload = verifySupabaseToken(token);
        req.user = payload;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
    }
}

let logs = [
    { id: 'REQ-101', deviceId: 'SmartLock_FrontDoor', endpoint: '/api/v1/unlock', status: 'GRANTED', route: 'FABRIC', hash: '8e329c...5e2' },
    { id: 'REQ-102', deviceId: 'ServerRack_A', endpoint: '/api/v1/telemetry', status: 'GRANTED', route: 'FABRIC', hash: 'bc0d3a...e98' }
];

// TPS History Buffer
let tpsHistory = [
    { time: '00:00:00', tps: 0 },
    { time: '00:00:02', tps: 0 },
    { time: '00:00:04', tps: 0 },
    { time: '00:00:06', tps: 0 }
];

// Background thread calculating live TPS (updated every 2 seconds)
setInterval(() => {
    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0];
    tpsHistory.push({ time: timeStr, tps: Math.round(requestCount / 2) });
    requestCount = 0;
    if (tpsHistory.length > 15) {
        tpsHistory.shift();
    }
}, 2000);

function validateSignature(payload) {
    const { device_id, action, timestamp, signature } = payload;
    if (!device_id || !action || !timestamp || !signature) return false;
    const rawDataString = `${device_id}:${action}:${timestamp}`;
    const expectedSignature = crypto
        .createHash('sha256')
        .update(rawDataString)
        .digest('hex');
    return expectedSignature === signature;
}

// REST API Endpoints for Frontend Integration
// All routes are protected by the Supabase JWT middleware.
app.get('/api/state', requireAuth, async (req, res) => {
    const deviceList = await deviceStore.getAll();
    res.status(200).json({
        activeRoute,
        isStressTesting,
        ledgerMode,
        ledgerError,
        dbMode,
        devices: deviceList,
        logs,
        tpsData: tpsHistory
    });
});

app.get('/api/devices', requireAuth, async (req, res) => {
    const deviceList = await deviceStore.getAll();
    res.status(200).json(deviceList);
});

app.post('/api/route', requireAuth, (req, res) => {
    const { route } = req.body;
    if (route === 'FABRIC' || route === 'IOTA') {
        activeRoute = route;
        return res.status(200).json({ activeRoute });
    }
    res.status(400).json({ error: 'Invalid ledger route' });
});

app.post('/api/devices/toggle', requireAuth, async (req, res) => {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'Missing deviceId' });

    await deviceStore.toggle(deviceId);

    // Keep the in-memory array in sync too (also covers MOCK+MEMORY fallback).
    devices = devices.map(d => {
        if (d.id === deviceId) {
            const newStatus = d.status === 'ACTIVE' ? 'REVOKED' : 'ACTIVE';
            return { ...d, status: newStatus };
        }
        return d;
    });

    const deviceList = await deviceStore.getAll();
    res.status(200).json({ devices: deviceList });
});

app.post('/api/devices/register', requireAuth, async (req, res) => {
    const { id, key } = req.body;
    if (id && key) {
        const formattedId = id.trim().replace(/\s+/g, '_');
        const formattedKey = key.startsWith('0x') ? key : `0x${key}`;
        await deviceStore.register(formattedId, formattedKey);

        // Log the registration event so it shows up in the traffic feed.
        const logEntry = {
            id: `REQ-REG-${crypto.randomUUID()}`,
            deviceId: formattedId,
            endpoint: '/api/v1/register',
            status: 'REGISTERED',
            route: activeRoute,
            hash: `${formattedKey.substring(0, 6)}...${formattedKey.substring(formattedKey.length - 3)}`
        };
        logs.unshift(logEntry);
        if (logs.length > 40) logs.pop();
        persistAccessLog(logEntry);

        const deviceList = await deviceStore.getAll();
        return res.status(200).json({ devices: deviceList });
    }
    res.status(400).json({ error: 'Missing device parameters' });
});

app.post('/api/stress', requireAuth, (req, res) => {
    const { isStressTesting: stress } = req.body;
    isStressTesting = stress;
    if (isStressTesting) {
        console.log("   🔥 [STRESS TEST INITIALIZED] Pacing simulator up...");
        setTimeout(() => {
            isStressTesting = false;
            console.log("   🔌 [STRESS TEST OVER] System returned to baseline pacing.");
        }, 3000);
    }
    res.status(200).json({ isStressTesting });
});

// Gateway Edge Request Handler
app.post('/api/access', async (req, res) => {
    const payload = req.body;
    processedCount++;
    requestCount++;

    console.log(`\n[REQUEST #${processedCount}] Received from ${payload.device_id}`);
    console.log(`   Action: ${payload.action} | Timestamp: ${payload.timestamp}`);

    const isValid = validateSignature(payload);
    if (!isValid) {
        console.log(`   ❌ [SECURITY ALERT] Signature mismatch. Payload rejected!`);

        const logEntry = {
            id: `REQ-${crypto.randomUUID()}`,
            deviceId: payload.device_id || 'UNKNOWN',
            endpoint: `/api/v1/${payload.action || 'access'}`,
            status: 'DENIED',
            route: activeRoute,
            hash: payload.signature ? `${payload.signature.substring(0, 6)}...${payload.signature.substring(payload.signature.length - 3)}` : 'N/A'
        };
        logs.unshift(logEntry);
        if (logs.length > 40) logs.pop();
        persistAccessLog(logEntry);

        return res.status(401).json({
            status: "error",
            message: "Unauthorized: Invalid cryptographic signature",
            isStressTesting
        });
    }

    // Verify if registered device status is REVOKED
    const device = await deviceStore.get(payload.device_id);
    if (device && device.status === 'REVOKED') {
        console.log(`   ❌ [ACCESS REVOKED] Authenticated request rejected due to revoked status.`);

        const logEntry = {
            id: `REQ-${crypto.randomUUID()}`,
            deviceId: payload.device_id,
            endpoint: `/api/v1/${payload.action || 'access'}`,
            status: 'REVOKED',
            route: activeRoute,
            hash: `${payload.signature.substring(0, 6)}...${payload.signature.substring(payload.signature.length - 3)}`
        };
        logs.unshift(logEntry);
        if (logs.length > 40) logs.pop();
        persistAccessLog(logEntry);

        return res.status(403).json({
            status: "error",
            message: "Forbidden: Device registration is revoked",
            isStressTesting
        });
    }

    console.log(`   ✅ [ACCESS GRANTED] Signature verified. (Route: ${activeRoute})`);

    const logEntry = {
        id: `REQ-${crypto.randomUUID()}`,
        deviceId: payload.device_id,
        endpoint: `/api/v1/${payload.action || 'access'}`,
        status: 'GRANTED',
        route: activeRoute,
        hash: `${payload.signature.substring(0, 6)}...${payload.signature.substring(payload.signature.length - 3)}`
    };
    logs.unshift(logEntry);
    if (logs.length > 40) logs.pop();
    persistAccessLog(logEntry);

    res.status(200).json({
        status: "success",
        message: "Access granted and logged",
        routed_to: activeRoute,
        isStressTesting
    });
});

app.listen(PORT, () => {
    console.log("=========================================");
    console.log(`🚦 IoT API Gateway (Dynamic integration) live!`);
    console.log(`📡 Listening for edge devices on port ${PORT}`);
    console.log(`🔗 Ledger backend: ${ledgerMode}${ledgerError ? ` (error: ${ledgerError})` : ''}`);
    console.log(`🗄️  Persistence: ${dbMode}${dbMode === 'POSTGRES' ? ' (Supabase)' : ' (in-memory fallback)'}`);
    console.log("=========================================\n");
});

// Load Supabase signing keys (JWKS) for access-token verification.
loadSupabaseJwks();

// Seed initial devices into Supabase on startup (mock mode only, when Postgres is configured).
if (dbMode === 'POSTGRES' && ledgerMode === 'MOCK') {
    db.seedDevices(devices).then(() => {
        console.log("   🌱 [POSTGRES] Initial devices seeded (no-op if already present).");
    }).catch(err => {
        console.error(`   ⚠️ [POSTGRES] Seeding failed: ${err.message}`);
    });
}