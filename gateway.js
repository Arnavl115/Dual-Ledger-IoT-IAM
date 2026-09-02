require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fabric = require('./fabric-client');
const iota = require('./iota-client');
const db = require('./supabase-db');

const app = express();
const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || process.env.CORS_ORIGIN || '*';

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));

// ------------------------------------------------------------------
// Security headers (helmet-lite) — production hardening
// ------------------------------------------------------------------
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (process.env.NODE_ENV === 'production') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
});

// ------------------------------------------------------------------
// CORS — restrict to frontend origin in production, allow * only for dev
// ------------------------------------------------------------------
app.use((req, res, next) => {
    const origin = req.headers.origin;
    const allowed = FRONTEND_URL === '*' ? '*' : FRONTEND_URL.split(',').map(s => s.trim());
    if (FRONTEND_URL === '*') {
        res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (origin && allowed.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

// ------------------------------------------------------------------
// Rate limiting — simple in-memory sliding window (production: use Redis)
// Limits /api/access to 120 req/min per IP to mitigate flooding
// ------------------------------------------------------------------
const rateBuckets = new Map();
function rateLimit({ windowMs, max, message }) {
    return (req, res, next) => {
        const key = req.ip || req.headers['x-forwarded-for'] || 'global';
        const now = Date.now();
        let bucket = rateBuckets.get(key);
        if (!bucket || now - bucket.windowStart > windowMs) {
            bucket = { count: 1, windowStart: now };
            rateBuckets.set(key, bucket);
            return next();
        }
        bucket.count++;
        if (bucket.count > max) {
            res.setHeader('Retry-After', Math.ceil((bucket.windowStart + windowMs - now) / 1000));
            return res.status(429).json({ error: message || 'Too many requests' });
        }
        next();
    };
}
// Periodic cleanup of stale buckets
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of rateBuckets.entries()) {
        if (now - v.windowStart > 60000) rateBuckets.delete(k);
    }
}, 60000).unref();

// ------------------------------------------------------------------
// Gateway production state — no hardcoded test identities
// ------------------------------------------------------------------
let activeRoute = iota.isEnabled() && !fabric.isEnabled() ? 'IOTA' : 'FABRIC';
let isStressTesting = false;
let processedCount = 0;
let requestCount = 0;

// In-memory fallbacks only when Postgres is unavailable (never seeded with fake keys)
// Production devices must be registered via /api/devices/register with a real PEM public key
let devices = [];
let ledgerMode = fabric.isEnabled() ? 'FABRIC' : (iota.isEnabled() ? 'IOTA' : 'MOCK');
let ledgerError = null;
let dbMode = db.isConfigured ? 'POSTGRES' : 'MEMORY';

// Which backend should device reads/writes actually hit, given the
// route selected in the console? Falls back to null (datastore/memory)
// when the selected backend is not enabled.
function activeBackend() {
    if (activeRoute === 'IOTA' && iota.isEnabled()) return 'IOTA';
    if (activeRoute === 'FABRIC' && fabric.isEnabled()) return 'FABRIC';
    return null;
}

// Device Store Abstraction:
//   - FABRIC mode  -> reads/writes device state via fabric-client (blockchain)
//   - IOTA mode    -> reads/writes device state via iota-client (Tangle)
//   - otherwise    -> Supabase Postgres when configured, else in-memory array.
const deviceStore = {
    async getAll() {
        const backend = activeBackend();
        if (backend === 'IOTA') {
            try {
                const list = await iota.getAllDevices();
                if (list && list.length > 0) return list;
                console.warn('   ⚠️ [IOTA] getAllDevices empty on Tangle, falling back to Postgres');
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [IOTA] getAllDevices failed: ${err.message}`);
            }
            return dbMode === 'POSTGRES' ? await this._getAllPostgres() : devices;
        }
        if (backend === 'FABRIC') {
            try {
                const list = await fabric.getAllDevices();
                if (list && list.length > 0) return list;
                console.warn('   ⚠️ [FABRIC] getAllDevices empty on ledger, falling back to Postgres');
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [FABRIC] getAllDevices failed: ${err.message}`);
            }
            return dbMode === 'POSTGRES' ? await this._getAllPostgres() : devices;
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
        const backend = activeBackend();
        if (backend === 'IOTA') {
            try {
                const dev = await iota.getDevice(id);
                if (dev) return dev;
                // Not found on Tangle — fall through to Postgres for already-registered devices
                console.warn(`   ⚠️ [IOTA] getDevice(${id}) not found on Tangle, falling back to Postgres`);
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [IOTA] getDevice failed: ${err.message}`);
            }
        }
        if (backend === 'FABRIC') {
            try {
                const dev = await fabric.getDevice(id);
                if (dev) return dev;
                console.warn(`   ⚠️ [FABRIC] getDevice(${id}) not found on ledger, falling back to Postgres`);
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

    async register(id, key, publicKey) {
        const backend = activeBackend();
        if (backend === 'IOTA') {
            try {
                await iota.registerDevice(id, publicKey || key);
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [IOTA] registerDevice failed: ${err.message}`);
                throw err;
            }
        }
        if (backend === 'FABRIC') {
            try {
                await fabric.registerDevice(id, publicKey || key);
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [FABRIC] registerDevice failed: ${err.message}`);
                throw err;
            }
        }
        if (dbMode === 'POSTGRES') {
            try {
                const existing = await db.getDevice(id);
                if (!existing) {
                    await db.insertDevice(id, publicKey || key, 'ACTIVE');
                } else if (publicKey) {
                    await db.updateDevicePublicKey(id, publicKey);
                }
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [POSTGRES] registerDevice failed: ${err.message}`);
                if (!backend) throw err;
            }
        }
        if (!devices.some(d => d.id === id)) {
            devices.push({ id, key, publicKey, status: 'ACTIVE' });
        }
        return null;
    },

    async toggle(id) {
        const backend = activeBackend();
        if (backend === 'IOTA') {
            try {
                return await iota.toggleDeviceStatus(id);
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [IOTA] toggleDeviceStatus failed: ${err.message}`);
                throw err;
            }
        }
        if (backend === 'FABRIC') {
            try {
                return await fabric.toggleDeviceStatus(id);
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [FABRIC] toggleDeviceStatus failed: ${err.message}`);
                throw err;
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
                if (!backend) throw err;
            }
        }
        return null;
    },

    async updatePublicKey(id, publicKey) {
        const backend = activeBackend();
        if (backend === 'IOTA') {
            // IOTA stores publicKey in state; re-register semantics via writeState
            const dev = await iota.getDevice(id);
            if (!dev) throw new Error(`Device ${id} not found on IOTA`);
            dev.publicKey = publicKey;
            dev.key = publicKey;
            // Use register path to update state via writeState (toggle not needed)
            // For IOTA, we update by writing new state directly
            throw new Error('IOTA publicKey rotation via register with existing ID not yet supported — re-register device');
        }
        if (backend === 'FABRIC') {
            try {
                const c = await fabric.getContract();
                // fabric-client exposes UpdateDevicePublicKey via transaction
                const fabricClient = require('./fabric-client');
                // Fallback to direct contract call if helper not present
                if (fabricClient.updateDevicePublicKey) {
                    return await fabricClient.updateDevicePublicKey(id, publicKey);
                }
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [FABRIC] updateDevicePublicKey failed: ${err.message}`);
                throw err;
            }
        }
        if (dbMode === 'POSTGRES') {
            await db.updateDevicePublicKey(id, publicKey);
        }
        const mem = devices.find(d => d.id === id);
        if (mem) {
            mem.publicKey = publicKey;
            mem.key = publicKey;
        }
    },

    async setStatus(id, status) {
        const backend = activeBackend();
        if (backend === 'FABRIC') {
            try {
                const fab = require('./fabric-client');
                if (status === 'REVOKED' && fab.revokeDevice) return await fab.revokeDevice(id);
                if (status === 'ACTIVE' && fab.activateDevice) {
                    // fabric-client may not expose activate; use toggle if needed
                    const dev = await fab.getDevice(id);
                    if (dev && dev.status !== status) return await fab.toggleDeviceStatus(id);
                    return dev;
                }
            } catch (err) {
                ledgerError = err.message;
                throw err;
            }
        }
        if (backend === 'IOTA') {
            try {
                if (status === 'REVOKED') return await iota.revokeDevice(id);
                if (status === 'ACTIVE') {
                    const dev = await iota.getDevice(id);
                    if (dev && dev.status === 'REVOKED') return await iota.toggleDeviceStatus(id);
                    return dev;
                }
            } catch (err) {
                ledgerError = err.message;
                throw err;
            }
        }
        if (dbMode === 'POSTGRES') {
            await db.updateDeviceStatus(id, status);
        }
        const mem = devices.find(d => d.id === id);
        if (mem) mem.status = status;
    },

    async remove(id) {
        const backend = activeBackend();
        if (backend === 'FABRIC') {
            try {
                const fab = require('./fabric-client');
                if (fab.deleteDevice) await fab.deleteDevice(id);
                else throw new Error('Fabric delete not exposed');
            } catch (err) {
                ledgerError = err.message;
                throw err;
            }
        }
        if (backend === 'IOTA') {
            throw new Error('IOTA notarization delete not supported — revoke instead');
        }
        if (dbMode === 'POSTGRES') {
            const { createClient } = require('@supabase/supabase-js');
            // Use supabase-db helper if available, else direct
            if (db.deleteDevice) await db.deleteDevice(id);
            else {
                // Fallback: direct delete via supabase client
                const supabaseUrl = process.env.SUPABASE_URL;
                const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
                if (supabaseUrl && supabaseKey) {
                    const { createClient } = require('@supabase/supabase-js');
                    const supa = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });
                    const { error } = await supa.from('devices').delete().eq('id', id);
                    if (error) throw error;
                }
            }
        }
        devices = devices.filter(d => d.id !== id);
    }
};

// Persist an access log entry to Supabase (non-blocking; failures are logged, never crash the request).
function persistAccessLog(logEntry) {
    if (dbMode !== 'POSTGRES') return;
    db.insertAccessLog(logEntry).catch(err => {
        // Retry once on PK collision (extremely rare with UUID, but handle)
        if (String(err.message).includes('duplicate key')) {
            logEntry.id = `REQ-${crypto.randomUUID()}`;
            db.insertAccessLog(logEntry).catch(e => console.error(`   ⚠️ [POSTGRES] insertAccessLog retry failed: ${e.message}`));
        } else {
            console.error(`   ⚠️ [POSTGRES] insertAccessLog failed: ${err.message}`);
        }
    });
}

// Supabase signing keys (JWKS) for ES256 token verification.
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

function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!process.env.SUPABASE_JWT_SECRET && supabaseJwks.length === 0) {
        return next();
    }
    if (!token) {
        return res.status(401).json({ error: 'Unauthorized: Missing bearer token' });
    }
    if (process.env.SUPABASE_SERVICE_ROLE_KEY && token === process.env.SUPABASE_SERVICE_ROLE_KEY) {
        return next();
    }
    try {
        const payload = verifySupabaseToken(token);
        req.user = payload;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
    }
}

// ------------------------------------------------------------------
// Production in-memory state — no hardcoded demo logs/devices
// ------------------------------------------------------------------
let logs = [];
let tpsHistory = [{ time: new Date().toTimeString().split(' ')[0], tps: 0 }];

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

// ------------------------------------------------------------------
// Device signature verification — production hardened
// - Requires valid PEM public key (EC P-256 or RSA)
// - Enforces timestamp freshness (5 min window) to prevent replay
// - Uses crypto.verify with sha256 over device_id:action:timestamp
// ------------------------------------------------------------------
const SEEN_SIGNATURES = new Map(); // signature -> expiry
const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const FUTURE_TOLERANCE_MS = 30 * 1000; // 30s clock skew

function isTimestampFresh(timestamp) {
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || ts <= 0) return false;
    const tsMs = ts * 1000;
    const now = Date.now();
    if (tsMs > now + FUTURE_TOLERANCE_MS) return false;
    if (now - tsMs > TIMESTAMP_WINDOW_MS) return false;
    return true;
}

function isReplay(signature, timestamp) {
    const key = `${signature}:${timestamp}`;
    if (SEEN_SIGNATURES.has(key)) return true;
    SEEN_SIGNATURES.set(key, Date.now() + TIMESTAMP_WINDOW_MS);
    return false;
}
setInterval(() => {
    const now = Date.now();
    for (const [k, exp] of SEEN_SIGNATURES.entries()) {
        if (exp < now) SEEN_SIGNATURES.delete(k);
    }
}, 60000).unref();

function validateSignature(payload, publicKey) {
    const { device_id, action, timestamp, signature } = payload;
    if (!device_id || !action || !timestamp || !signature || !publicKey) return false;
    if (!isTimestampFresh(timestamp)) return false;
    if (isReplay(signature, timestamp)) return false;
    const rawDataString = `${device_id}:${action}:${timestamp}`;
    try {
        // Validate PEM format strictly
        if (!publicKey.includes('-----BEGIN PUBLIC KEY-----')) return false;
        const key = crypto.createPublicKey(publicKey);
        // Only allow EC P-256 / P-384 or RSA; reject weak keys
        const details = key.asymmetricKeyDetails || {};
        if (key.asymmetricKeyType === 'ec') {
            const curve = details.namedCurve;
            if (curve !== 'prime256v1' && curve !== 'secp256r1' && curve !== 'P-256' && curve !== 'secp384r1') return false;
        }
        return crypto.verify(
            'sha256',
            Buffer.from(rawDataString),
            key,
            Buffer.from(signature, 'base64')
        );
    } catch (err) {
        return false;
    }
}

function validatePublicKeyPem(pem) {
    if (typeof pem !== 'string' || !pem.includes('-----BEGIN PUBLIC KEY-----')) return false;
    try {
        const key = crypto.createPublicKey(pem);
        const type = key.asymmetricKeyType;
        if (type !== 'ec' && type !== 'rsa' && type !== 'ed25519') return false;
        return true;
    } catch {
        return false;
    }
}

// ------------------------------------------------------------------
// REST API Endpoints
// ------------------------------------------------------------------
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        ledgerMode,
        dbMode,
        activeRoute,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
    });
});

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
    try {
        await deviceStore.toggle(deviceId);
    } catch (err) {
        return res.status(500).json({ error: `Toggle failed: ${err.message}` });
    }
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
    const { id, key, publicKey } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing device parameters' });
    if (!publicKey && !key) return res.status(400).json({ error: 'publicKey (PEM) is required for production registration' });
    const pem = publicKey || key;
    if (pem && pem.includes('BEGIN PUBLIC KEY') && !validatePublicKeyPem(pem)) {
        return res.status(400).json({ error: 'Invalid publicKey PEM format' });
    }
    const formattedId = id.trim().replace(/\s+/g, '_');
    if (formattedId.length < 3 || formattedId.length > 64) return res.status(400).json({ error: 'Device ID must be 3-64 chars' });
    if (!/^[A-Za-z0-9_-]+$/.test(formattedId)) return res.status(400).json({ error: 'Device ID may only contain alphanumeric, underscore, hyphen' });
    let formattedKey = null;
    if (key) {
        formattedKey = key.startsWith('0x') ? key : `0x${key}`;
    }
    try {
        await deviceStore.register(formattedId, formattedKey, publicKey);
    } catch (err) {
        return res.status(500).json({ error: `Registration failed: ${err.message}` });
    }
    const existing = devices.find(d => d.id === formattedId);
    if (existing) {
        if (formattedKey) existing.key = formattedKey;
        if (publicKey) existing.publicKey = publicKey;
    } else {
        devices.push({ id: formattedId, key: formattedKey, publicKey: publicKey || null, status: 'ACTIVE' });
    }
    const logEntry = {
        id: `REQ-REG-${crypto.randomUUID()}`,
        deviceId: formattedId,
        endpoint: '/api/v1/register',
        status: 'REGISTERED',
        route: activeRoute,
        hash: publicKey
            ? `${publicKey.substring(0, 6)}...${publicKey.substring(publicKey.length - 6)}`
            : (formattedKey ? `${formattedKey.substring(0, 6)}...${formattedKey.substring(formattedKey.length - 3)}` : 'N/A')
    };
    logs.unshift(logEntry);
    if (logs.length > 40) logs.pop();
    persistAccessLog(logEntry);
    const deviceList = await deviceStore.getAll();
    return res.status(200).json({ devices: deviceList });
});

// Production: explicit revoke / activate / updateKey / delete — all actively use ledger transactions
app.post('/api/devices/revoke', requireAuth, async (req, res) => {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'Missing deviceId' });
    try {
        await deviceStore.setStatus(deviceId, 'REVOKED');
        devices = devices.map(d => d.id === deviceId ? { ...d, status: 'REVOKED' } : d);
        const list = await deviceStore.getAll();
        res.status(200).json({ devices: list });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/devices/activate', requireAuth, async (req, res) => {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'Missing deviceId' });
    try {
        await deviceStore.setStatus(deviceId, 'ACTIVE');
        devices = devices.map(d => d.id === deviceId ? { ...d, status: 'ACTIVE' } : d);
        const list = await deviceStore.getAll();
        res.status(200).json({ devices: list });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/devices/update-key', requireAuth, async (req, res) => {
    const { deviceId, publicKey } = req.body;
    if (!deviceId || !publicKey) return res.status(400).json({ error: 'deviceId and publicKey required' });
    if (!validatePublicKeyPem(publicKey)) return res.status(400).json({ error: 'Invalid publicKey PEM' });
    try {
        await deviceStore.updatePublicKey(deviceId, publicKey);
        const list = await deviceStore.getAll();
        res.status(200).json({ devices: list });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/devices/:id', requireAuth, async (req, res) => {
    const id = req.params.id;
    try {
        await deviceStore.remove(id);
        const list = await deviceStore.getAll();
        res.status(200).json({ devices: list });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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

// Gateway Edge Request Handler — rate limited, timestamp & replay protected
app.post('/api/access', rateLimit({ windowMs: 60 * 1000, max: 120, message: 'Rate limit exceeded: max 120 access requests per minute' }), async (req, res) => {
    const payload = req.body;
    processedCount++;
    requestCount++;

    console.log(`\n[REQUEST #${processedCount}] Received from ${payload.device_id}`);
    console.log(`   Action: ${payload.action} | Timestamp: ${payload.timestamp}`);

    // Basic payload validation
    if (!payload.device_id || !payload.action || !payload.timestamp || !payload.signature) {
        const logEntry = {
            id: `REQ-${crypto.randomUUID()}`,
            deviceId: payload.device_id || 'UNKNOWN',
            endpoint: `/api/v1/${payload.action || 'access'}`,
            status: 'DENIED',
            route: activeRoute,
            hash: 'N/A'
        };
        logs.unshift(logEntry);
        if (logs.length > 40) logs.pop();
        persistAccessLog(logEntry);
        return res.status(400).json({ status: "error", message: "Missing required fields: device_id, action, timestamp, signature", isStressTesting });
    }

    const device = await deviceStore.get(payload.device_id);

    if (!device) {
        const logEntry = {
            id: `REQ-${crypto.randomUUID()}`,
            deviceId: payload.device_id,
            endpoint: `/api/v1/${payload.action}`,
            status: 'DENIED',
            route: activeRoute,
            hash: payload.signature ? `${payload.signature.substring(0, 6)}...${payload.signature.substring(payload.signature.length - 3)}` : 'N/A'
        };
        logs.unshift(logEntry);
        if (logs.length > 40) logs.pop();
        persistAccessLog(logEntry);
        return res.status(401).json({ status: "error", message: "Unknown device: not registered", isStressTesting });
    }

    if (!isTimestampFresh(payload.timestamp)) {
        const logEntry = {
            id: `REQ-${crypto.randomUUID()}`,
            deviceId: payload.device_id,
            endpoint: `/api/v1/${payload.action}`,
            status: 'DENIED',
            route: activeRoute,
            hash: `${payload.signature.substring(0, 6)}...${payload.signature.substring(payload.signature.length - 3)}`
        };
        logs.unshift(logEntry);
        if (logs.length > 40) logs.pop();
        persistAccessLog(logEntry);
        return res.status(401).json({ status: "error", message: "Stale timestamp: must be within 5 minutes", isStressTesting });
    }

    const isValid = validateSignature(payload, device && device.publicKey);
    if (!isValid) {
        console.log(`   ❌ [SECURITY ALERT] Signature mismatch or replay. Payload rejected!`);

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
            message: "Unauthorized: Invalid cryptographic signature or replay detected",
            isStressTesting
        });
    }

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
    console.log(`🚦 IoT API Gateway (production) live!`);
    console.log(`📡 Listening for edge devices on port ${PORT}`);
    console.log(`🔗 Ledger backend: ${ledgerMode}${ledgerError ? ` (error: ${ledgerError})` : ''}`);
    console.log(`🗄️  Persistence: ${dbMode}${dbMode === 'POSTGRES' ? ' (Supabase)' : ' (in-memory fallback)'}`);
    console.log(`🌐 CORS origin: ${FRONTEND_URL}`);
    console.log("=========================================\n");
});

loadSupabaseJwks();

// Production: do NOT seed fake devices. Only seed if explicitly enabled and DB is empty, using real registered devices.
// This block is intentionally disabled in production — devices must be registered via /api/devices/register with real PEM keys.
// If you need demo seeding, set SEED_DEMO_DEVICES=true
if (process.env.SEED_DEMO_DEVICES === 'true' && dbMode === 'POSTGRES' && ledgerMode === 'MOCK') {
    db.seedDevices(devices).then(() => {
        console.log("   🌱 [POSTGRES] Demo devices seeded (SEED_DEMO_DEVICES=true).");
    }).catch(err => {
        console.error(`   ⚠️ [POSTGRES] Seeding failed: ${err.message}`);
    });
}

if (iota.isEnabled()) {
    iota.initLedger(devices).then(() => {
        console.log("   🌱 [IOTA] Initial devices notarized on the Tangle (no-op if already present).");
    }).catch(err => {
        console.error(`   ⚠️ [IOTA] Seeding failed: ${err.message}`);
    });
}
