require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fabric = require('./fabric-client');
const iota = require('./iota-client');
const db = require('./supabase-db');
const { SimulatorKeyStore } = require('./simulator-key-store');

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
let isStressTesting = false;
let stressSession = null;
let stressReport = null;
let processedCount = 0;
let requestCount = 0;

// In-memory fallbacks only when Postgres is unavailable (never seeded with fake keys)
// Production devices must be registered via /api/devices/register with a real PEM public key
let devices = [];
let ledgerError = null;
let dbMode = db.isConfigured ? 'POSTGRES' : 'MEMORY';
const simulatorKeys = new SimulatorKeyStore();
const pendingDeviceOperations = new Set();
const enabledRoutes = [
    ...(fabric.isEnabled() ? ['FABRIC'] : []),
    ...(iota.isEnabled() ? ['IOTA'] : []),
];

function fallbackBackend() {
    return dbMode === 'POSTGRES' ? 'POSTGRES' : 'MEMORY';
}

let activeRoute = enabledRoutes[0] || fallbackBackend();
let lastActiveBackend = activeRoute;

function activeBackend() {
    return enabledRoutes.includes(activeRoute) ? activeRoute : fallbackBackend();
}

function markBackend(context, backend) {
    if (context) context.backend = backend;
    lastActiveBackend = backend;
}

function requireBothLedgers() {
    const missing = ['FABRIC', 'IOTA'].filter(route => !enabledRoutes.includes(route));
    if (missing.length) {
        const error = new Error(`Both ledgers must be enabled; missing ${missing.join(' and ')}`);
        error.status = 409;
        throw error;
    }
}

async function withDeviceOperation(deviceId, operation) {
    if (pendingDeviceOperations.has(deviceId)) {
        const error = new Error(`Another lifecycle operation is already running for ${deviceId}`);
        error.status = 409;
        throw error;
    }
    pendingDeviceOperations.add(deviceId);
    try {
        return await operation();
    } finally {
        pendingDeviceOperations.delete(deviceId);
    }
}

// Device Store Abstraction:
//   - FABRIC mode  -> reads/writes device state via fabric-client (blockchain)
//   - IOTA mode    -> reads/writes device state via iota-client (Tangle)
//   - otherwise    -> Supabase Postgres when configured, else in-memory array.
const deviceStore = {
    async getAll(context) {
        const backend = activeBackend();
        if (backend === 'IOTA') {
            try {
                const list = await iota.getAllDevices();
                ledgerError = null;
                markBackend(context, 'IOTA');
                return list || [];
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [IOTA] getAllDevices failed: ${err.message}`);
            }
            return this._getAllFallback(context);
        }
        if (backend === 'FABRIC') {
            try {
                const list = await fabric.getAllDevices();
                ledgerError = null;
                markBackend(context, 'FABRIC');
                return list || [];
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [FABRIC] getAllDevices failed: ${err.message}`);
            }
            return this._getAllFallback(context);
        }
        return this._getAllFallback(context);
    },

    async _getAllFallback(context) {
        if (dbMode === 'POSTGRES') return this._getAllPostgres(context);
        markBackend(context, 'MEMORY');
        return devices;
    },

    async _getAllPostgres(context) {
        try {
            const list = await db.getAllDevices();
            markBackend(context, 'POSTGRES');
            return list;
        } catch (err) {
            ledgerError = err.message;
            console.error(`   ⚠️ [POSTGRES] getAllDevices failed: ${err.message}`);
            markBackend(context, 'MEMORY');
            return devices;
        }
    },

    async get(id, authoritative = false, context) {
        const backend = activeBackend();
        if (backend === 'IOTA') {
            try {
                const dev = await iota.getDevice(id);
                ledgerError = null;
                markBackend(context, 'IOTA');
                return dev;
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [IOTA] getDevice failed: ${err.message}`);
                if (authoritative) throw err;
            }
        }
        if (backend === 'FABRIC') {
            try {
                const dev = await fabric.getDevice(id);
                ledgerError = null;
                markBackend(context, 'FABRIC');
                return dev;
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [FABRIC] getDevice failed: ${err.message}`);
                if (authoritative) throw err;
            }
        }
        if (dbMode === 'POSTGRES') {
            try {
                const device = await db.getDevice(id);
                markBackend(context, 'POSTGRES');
                return device;
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [POSTGRES] getDevice failed: ${err.message}`);
            }
        }
        markBackend(context, 'MEMORY');
        return devices.find(d => d.id === id) || null;
    },

    async _syncPostgres(device) {
        if (dbMode !== 'POSTGRES' || !device) return;
        await db.upsertDevice(device.id, device.publicKey || device.key, device.status);
    },

    async register(id, key, publicKey, context) {
        const backend = activeBackend();
        let ledgerDevice = null;
        if (backend === 'IOTA') {
            try {
                ledgerDevice = await iota.registerDevice(id, publicKey || key);
                ledgerError = null;
                markBackend(context, 'IOTA');
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [IOTA] registerDevice failed: ${err.message}`);
                throw err;
            }
        }
        if (backend === 'FABRIC') {
            try {
                ledgerDevice = await fabric.registerDevice(id, publicKey || key);
                ledgerError = null;
                markBackend(context, 'FABRIC');
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [FABRIC] registerDevice failed: ${err.message}`);
                throw err;
            }
        }
        if (dbMode === 'POSTGRES') {
            try {
                if (backend === 'FABRIC' || backend === 'IOTA') {
                    await this._syncPostgres(ledgerDevice);
                } else {
                    const existing = await db.getDevice(id);
                    if (existing) throw new Error(`Device ${id} already exists`);
                    await db.insertDevice(id, publicKey || key, 'ACTIVE');
                    markBackend(context, 'POSTGRES');
                }
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [POSTGRES] registerDevice failed: ${err.message}`);
                throw err;
            }
        }
        if (backend === 'MEMORY') {
            if (devices.some(d => d.id === id)) throw new Error(`Device ${id} already exists`);
            devices.push({ id, key, publicKey, status: 'ACTIVE' });
        }
        if (backend === 'MEMORY') markBackend(context, 'MEMORY');
        return ledgerDevice;
    },

    async registerSimulatorDevice(id, context) {
        requireBothLedgers();
        if (simulatorKeys.has(id)) throw new Error(`Simulator device ${id} already exists`);

        const [fabricDevice, iotaDevice] = await Promise.all([
            fabric.getDevice(id),
            iota.getDevice(id),
        ]);
        if (fabricDevice || iotaDevice) throw new Error(`Device ${id} already exists on a ledger`);

        const { publicKey, privateKey } = simulatorKeys.generateKeyPair();
        const completed = [];
        try {
            const registeredFabricDevice = await fabric.registerDevice(id, publicKey);
            completed.push('FABRIC');
            await iota.registerDevice(id, publicKey);
            completed.push('IOTA');
            if (dbMode === 'POSTGRES') {
                await db.upsertDevice(id, publicKey, 'ACTIVE');
                completed.push('POSTGRES');
            }
            simulatorKeys.add(id, privateKey);
            completed.push('SIMULATOR');
            ledgerError = null;
            markBackend(context, 'FABRIC+IOTA');
            return registeredFabricDevice;
        } catch (error) {
            const rollbackErrors = [];
            if (completed.includes('SIMULATOR')) {
                try { simulatorKeys.remove(id); } catch (rollbackError) { rollbackErrors.push(`simulator: ${rollbackError.message}`); }
            }
            if (completed.includes('POSTGRES')) {
                try { await db.deleteDevice(id); } catch (rollbackError) { rollbackErrors.push(`PostgreSQL: ${rollbackError.message}`); }
            }
            if (completed.includes('IOTA')) {
                try { await iota.deleteDevice(id); } catch (rollbackError) { rollbackErrors.push(`IOTA: ${rollbackError.message}`); }
            }
            if (completed.includes('FABRIC')) {
                try { await fabric.deleteDevice(id); } catch (rollbackError) { rollbackErrors.push(`Fabric: ${rollbackError.message}`); }
            }
            ledgerError = error.message;
            const suffix = rollbackErrors.length ? `; rollback failed for ${rollbackErrors.join(', ')}` : '';
            throw new Error(`${error.message}${suffix}`);
        }
    },

    async toggle(id, context) {
        const backend = activeBackend();
        if (backend === 'IOTA') {
            try {
                const device = await iota.toggleDeviceStatus(id);
                await this._syncPostgres(device);
                ledgerError = null;
                markBackend(context, 'IOTA');
                return device;
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [IOTA] toggleDeviceStatus failed: ${err.message}`);
                throw err;
            }
        }
        if (backend === 'FABRIC') {
            try {
                const device = await fabric.toggleDeviceStatus(id);
                await this._syncPostgres(device);
                ledgerError = null;
                markBackend(context, 'FABRIC');
                return device;
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [FABRIC] toggleDeviceStatus failed: ${err.message}`);
                throw err;
            }
        }
        if (backend === 'POSTGRES') {
            try {
                const current = await db.getDevice(id);
                if (current) {
                    const newStatus = current.status === 'ACTIVE' ? 'REVOKED' : 'ACTIVE';
                    await db.updateDeviceStatus(id, newStatus);
                }
                markBackend(context, 'POSTGRES');
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [POSTGRES] toggleDeviceStatus failed: ${err.message}`);
                throw err;
            }
        }
        if (backend === 'MEMORY') markBackend(context, 'MEMORY');
        return null;
    },

    async updatePublicKey(id, publicKey, context) {
        const backend = activeBackend();
        if (backend === 'IOTA') {
            try {
                const device = await iota.updateDevicePublicKey(id, publicKey);
                await this._syncPostgres(device);
                ledgerError = null;
                markBackend(context, 'IOTA');
                return device;
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [IOTA] updateDevicePublicKey failed: ${err.message}`);
                throw err;
            }
        }
        if (backend === 'FABRIC') {
            try {
                const fabricClient = require('./fabric-client');
                if (fabricClient.updateDevicePublicKey) {
                    const device = await fabricClient.updateDevicePublicKey(id, publicKey);
                    await this._syncPostgres(device);
                    ledgerError = null;
                    markBackend(context, 'FABRIC');
                    return device;
                }
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [FABRIC] updateDevicePublicKey failed: ${err.message}`);
                throw err;
            }
        }
        if (backend === 'POSTGRES') {
            await db.updateDevicePublicKey(id, publicKey);
            markBackend(context, 'POSTGRES');
        }
        const mem = devices.find(d => d.id === id);
        if (mem) {
            mem.publicKey = publicKey;
            mem.key = publicKey;
        }
        if (backend === 'MEMORY') markBackend(context, 'MEMORY');
    },

    async setStatus(id, status, context) {
        const backend = activeBackend();
        if (backend === 'FABRIC') {
            try {
                const fab = require('./fabric-client');
                let device;
                if (status === 'REVOKED' && fab.revokeDevice) device = await fab.revokeDevice(id);
                if (status === 'ACTIVE' && fab.activateDevice) {
                    device = await fab.activateDevice(id);
                }
                await this._syncPostgres(device);
                ledgerError = null;
                markBackend(context, 'FABRIC');
                return device;
            } catch (err) {
                ledgerError = err.message;
                throw err;
            }
        }
        if (backend === 'IOTA') {
            try {
                let device;
                if (status === 'REVOKED') device = await iota.revokeDevice(id);
                if (status === 'ACTIVE') device = await iota.activateDevice(id);
                await this._syncPostgres(device);
                ledgerError = null;
                markBackend(context, 'IOTA');
                return device;
            } catch (err) {
                ledgerError = err.message;
                throw err;
            }
        }
        if (backend === 'POSTGRES') {
            await db.updateDeviceStatus(id, status);
            markBackend(context, 'POSTGRES');
        }
        const mem = devices.find(d => d.id === id);
        if (mem) mem.status = status;
        if (backend === 'MEMORY') markBackend(context, 'MEMORY');
    },

    async history(id, context) {
        const backend = activeBackend();
        if (backend !== 'FABRIC') {
            const err = new Error(`Device history is unavailable for the ${backend} backend`);
            err.status = 409;
            throw err;
        }
        try {
            const history = await fabric.getDeviceHistory(id);
            ledgerError = null;
            markBackend(context, 'FABRIC');
            return history;
        } catch (err) {
            ledgerError = err.message;
            throw err;
        }
    },

    async remove(id, context) {
        const backend = activeBackend();
        if (backend === 'FABRIC') {
            try {
                const fab = require('./fabric-client');
                if (fab.deleteDevice) await fab.deleteDevice(id);
                else throw new Error('Fabric delete not exposed');
                ledgerError = null;
                markBackend(context, 'FABRIC');
            } catch (err) {
                ledgerError = err.message;
                throw err;
            }
        }
        if (backend === 'IOTA') {
            try {
                await iota.deleteDevice(id);
                ledgerError = null;
                markBackend(context, 'IOTA');
            } catch (err) {
                ledgerError = err.message;
                throw err;
            }
        }
        if (dbMode === 'POSTGRES') {
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
            if (backend === 'POSTGRES') markBackend(context, 'POSTGRES');
        }
        devices = devices.filter(d => d.id !== id);
        if (backend === 'MEMORY') markBackend(context, 'MEMORY');
    },

    async removeSimulatorDevice(id, context) {
        requireBothLedgers();
        const [fabricDevice, iotaDevice] = await Promise.all([
            fabric.getDevice(id),
            iota.getDevice(id),
        ]);
        if (!fabricDevice && !iotaDevice && !simulatorKeys.has(id)) {
            const error = new Error(`Device ${id} does not exist`);
            error.status = 404;
            throw error;
        }

        // Stop request generation before removing either authoritative identity.
        simulatorKeys.remove(id);
        const deletions = await Promise.allSettled([
            fabricDevice ? fabric.deleteDevice(id) : Promise.resolve(),
            iotaDevice ? iota.deleteDevice(id) : Promise.resolve(),
        ]);
        const failures = deletions
            .map((result, index) => result.status === 'rejected'
                ? `${index === 0 ? 'Fabric' : 'IOTA'}: ${result.reason.message}`
                : null)
            .filter(Boolean);

        if (dbMode === 'POSTGRES') {
            try {
                await db.deleteDevice(id);
            } catch (error) {
                failures.push(`PostgreSQL: ${error.message}`);
            }
        }
        devices = devices.filter(device => device.id !== id);
        if (failures.length) {
            ledgerError = failures.join('; ');
            const error = new Error(`Device removal was incomplete: ${ledgerError}`);
            error.status = 502;
            throw error;
        }
        ledgerError = null;
        markBackend(context, 'FABRIC+IOTA');
    }
};

function cacheAccessLog(logEntry) {
    logs.unshift(logEntry);
    if (logs.length > 40) logs.pop();
}

// Audit persistence is part of request completion: callers must handle failures.
async function persistAccessLog(logEntry) {
    if (dbMode !== 'POSTGRES') return;
    try {
        await db.insertAccessLog(logEntry);
    } catch (err) {
        if (String(err.message).includes('duplicate key')) {
            logEntry.id = `REQ-${crypto.randomUUID()}`;
            await db.insertAccessLog(logEntry);
            return;
        }
        throw err;
    }
}

async function recordAccessLog(logEntry) {
    logEntry.createdAt = logEntry.createdAt || new Date().toISOString();
    cacheAccessLog(logEntry);
    await persistAccessLog(logEntry);
}

function auditUnavailable(res, err, details) {
    console.error(`   ⚠️ [AUDIT] Access log persistence failed: ${err.message}`);
    return res.status(503).json({
        status: 'error',
        message: 'Request could not be completed because its audit record was not persisted',
        ...(details || {}),
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
        return res.status(503).json({ error: 'Authentication service unavailable' });
    }
    if (!token) {
        return res.status(401).json({ error: 'Unauthorized: Missing bearer token' });
    }
    if (process.env.SUPABASE_SERVICE_ROLE_KEY && token === process.env.SUPABASE_SERVICE_ROLE_KEY) {
        return next();
    }
    try {
        const payload = verifySupabaseToken(token);
        if (payload.role !== 'authenticated' || !payload.sub || payload.app_metadata?.role !== 'admin') {
            return res.status(403).json({ error: 'Forbidden: Administrator access required' });
        }
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

function measureStressRequest(req, res, next) {
    const session = stressSession && stressSession.accepting ? stressSession : null;
    if (!session) return next();

    const startedAt = process.hrtime.bigint();
    session.inFlight++;
    res.once('finish', () => {
        const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        session.samples.push({
            completedAt: Date.now(),
            latencyMs,
            statusCode: res.statusCode,
            route: res.locals.backend || 'GATEWAY',
        });
        session.inFlight--;
    });
    next();
}

function buildStressReport(session) {
    const completedAt = Date.now();
    const samples = session.samples;
    const latencies = samples.map(sample => sample.latencyMs).sort((a, b) => a - b);
    const successfulRequests = samples.filter(sample => sample.statusCode >= 200 && sample.statusCode < 300).length;
    const durationMs = completedAt - session.startedAt;
    let peakTps = 0;
    let windowStart = 0;
    const completionTimes = samples.map(sample => sample.completedAt).sort((a, b) => a - b);
    for (let windowEnd = 0; windowEnd < completionTimes.length; windowEnd++) {
        while (completionTimes[windowEnd] - completionTimes[windowStart] >= 1000) windowStart++;
        peakTps = Math.max(peakTps, windowEnd - windowStart + 1);
    }

    const statusCodes = {};
    const routeSamples = {};
    for (const sample of samples) {
        statusCodes[sample.statusCode] = (statusCodes[sample.statusCode] || 0) + 1;
        routeSamples[sample.route] = routeSamples[sample.route] || [];
        routeSamples[sample.route].push(sample);
    }

    return {
        startedAt: new Date(session.startedAt).toISOString(),
        completedAt: new Date(completedAt).toISOString(),
        durationMs,
        totalRequests: samples.length,
        successfulRequests,
        failedRequests: samples.length - successfulRequests,
        peakTps,
        averageTps: durationMs > 0 ? Number((samples.length / (durationMs / 1000)).toFixed(2)) : 0,
        averageLatencyMs: latencies.length
            ? Number((latencies.reduce((sum, value) => sum + value, 0) / latencies.length).toFixed(2))
            : 0,
        p95LatencyMs: latencies.length
            ? Number(latencies[Math.min(Math.ceil(latencies.length * 0.95) - 1, latencies.length - 1)].toFixed(2))
            : 0,
        successRate: samples.length ? Number(((successfulRequests / samples.length) * 100).toFixed(2)) : 0,
        statusCodes,
        routes: Object.entries(routeSamples).map(([route, routeEntries]) => {
            const routeSuccesses = routeEntries.filter(sample => sample.statusCode >= 200 && sample.statusCode < 300).length;
            return {
                route,
                requests: routeEntries.length,
                averageLatencyMs: Number((routeEntries.reduce((sum, sample) => sum + sample.latencyMs, 0) / routeEntries.length).toFixed(2)),
                successRate: Number(((routeSuccesses / routeEntries.length) * 100).toFixed(2)),
            };
        }),
    };
}

function finishStressSession(session) {
    session.accepting = false;
    const waitDeadline = Date.now() + 5000;
    const finish = () => {
        if (session.inFlight > 0 && Date.now() < waitDeadline) {
            return setTimeout(finish, 25);
        }
        stressReport = buildStressReport(session);
        if (stressSession === session) stressSession = null;
        isStressTesting = false;
        console.log(`   🔌 [STRESS TEST OVER] Measured ${stressReport.totalRequests} requests at ${stressReport.averageTps} average TPS.`);
    };
    finish();
}

// ------------------------------------------------------------------
// Device signature verification — production hardened
// - Requires a canonical P-256 SPKI PEM public key
// - Enforces timestamp freshness (5 min window) to prevent replay
// - Uses crypto.verify with sha256 over device_id:action:timestamp
// ------------------------------------------------------------------
const SEEN_REQUESTS = new Map(); // authenticated request ID -> expiry (memory mode only)
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

async function claimAuthenticatedRequest(logEntry) {
    if (dbMode === 'POSTGRES') {
        return db.claimAccessLog(logEntry);
    }
    if (SEEN_REQUESTS.has(logEntry.id)) return false;
    SEEN_REQUESTS.set(logEntry.id, Date.now() + TIMESTAMP_WINDOW_MS);
    return true;
}
setInterval(() => {
    const now = Date.now();
    for (const [k, exp] of SEEN_REQUESTS.entries()) {
        if (exp < now) SEEN_REQUESTS.delete(k);
    }
}, 60000).unref();

function validateSignature(payload, publicKey) {
    const { device_id, action, timestamp, signature } = payload;
    if (!device_id || !action || !timestamp || !signature || !publicKey) return false;
    if (!isTimestampFresh(timestamp)) return false;
    const rawDataString = `${device_id}:${action}:${timestamp}`;
    try {
        if (!validatePublicKeyPem(publicKey)) return false;
        const key = crypto.createPublicKey(publicKey);
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
    if (typeof pem !== 'string' || pem.length < 80 || pem.length > 10000) return false;
    try {
        const key = crypto.createPublicKey(pem);
        if (key.type !== 'public' || key.asymmetricKeyType !== 'ec') return false;
        const curve = key.asymmetricKeyDetails && key.asymmetricKeyDetails.namedCurve;
        if (!['prime256v1', 'secp256r1', 'P-256'].includes(curve)) return false;
        const normalized = value => value.trim().replace(/\r\n/g, '\n');
        const canonicalPem = key.export({ type: 'spki', format: 'pem' });
        return normalized(pem) === normalized(canonicalPem);
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
        ledgerMode: lastActiveBackend,
        activeBackend: lastActiveBackend,
        dbMode,
        activeRoute,
        enabledRoutes,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
    });
});

app.get('/api/state', requireAuth, async (req, res) => {
    const backendContext = {};
    const deviceList = await deviceStore.getAll(backendContext);
    const actualBackend = backendContext.backend || activeBackend();
    res.status(200).json({
        activeRoute,
        activeBackend: actualBackend,
        enabledRoutes,
        isStressTesting,
        stressReport,
        ledgerMode: actualBackend,
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

app.get('/api/devices/:id/history', requireAuth, async (req, res) => {
    const backendContext = {};
    try {
        const history = await deviceStore.history(req.params.id, backendContext);
        return res.status(200).json({
            deviceId: req.params.id,
            backend: backendContext.backend,
            history,
        });
    } catch (err) {
        return res.status(err.status || 500).json({ error: err.message });
    }
});

app.get('/api/logs', requireAuth, async (req, res) => {
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const requestedOffset = Number.parseInt(req.query.offset, 10);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 100;
    const offset = Number.isFinite(requestedOffset) ? Math.max(requestedOffset, 0) : 0;
    try {
        if (dbMode === 'POSTGRES') {
            const result = await db.getAccessLogs({ limit, offset });
            return res.status(200).json({ ...result, limit, offset });
        }
        return res.status(200).json({
            logs: logs.slice(offset, offset + limit),
            total: logs.length,
            limit,
            offset,
        });
    } catch (err) {
        console.error(`   ⚠️ [AUDIT] Access log read failed: ${err.message}`);
        return res.status(503).json({ error: 'Audit history unavailable' });
    }
});

app.post('/api/route', requireAuth, (req, res) => {
    const { route } = req.body;
    if (route !== 'FABRIC' && route !== 'IOTA') {
        return res.status(400).json({ error: 'Invalid ledger route', enabledRoutes });
    }
    if (!enabledRoutes.includes(route)) {
        return res.status(409).json({ error: `${route} is not enabled`, activeRoute, enabledRoutes });
    }
    activeRoute = route;
    lastActiveBackend = route;
    ledgerError = null;
    return res.status(200).json({ activeRoute, activeBackend: route, enabledRoutes });
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
    const { id, publicKey, simulatorManaged = false } = req.body;
    if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'Missing device parameters' });
    if (!simulatorManaged && !validatePublicKeyPem(publicKey)) return res.status(400).json({ error: 'A valid P-256 SPKI publicKey PEM is required' });
    const formattedId = id.trim().replace(/\s+/g, '_');
    if (formattedId.length < 3 || formattedId.length > 64) return res.status(400).json({ error: 'Device ID must be 3-64 chars' });
    if (!/^[A-Za-z0-9_-]+$/.test(formattedId)) return res.status(400).json({ error: 'Device ID may only contain alphanumeric, underscore, hyphen' });
    const backendContext = {};
    try {
        await withDeviceOperation(formattedId, () => simulatorManaged
            ? deviceStore.registerSimulatorDevice(formattedId, backendContext)
            : deviceStore.register(formattedId, null, publicKey, backendContext));
    } catch (err) {
        if (String(err.message).includes('already exists')) {
            return res.status(409).json({ error: `Registration failed: ${err.message}` });
        }
        return res.status(err.status || 500).json({ error: `Registration failed: ${err.message}` });
    }
    const registeredPublicKey = simulatorManaged
        ? (await fabric.getDevice(formattedId)).publicKey
        : publicKey;
    const existing = devices.find(d => d.id === formattedId);
    if (existing) {
        existing.key = registeredPublicKey;
        existing.publicKey = registeredPublicKey;
    } else {
        devices.push({ id: formattedId, key: registeredPublicKey, publicKey: registeredPublicKey, status: 'ACTIVE' });
    }
    const logEntry = {
        id: `REQ-REG-${crypto.randomUUID()}`,
        deviceId: formattedId,
        endpoint: '/api/v1/register',
        status: 'REGISTERED',
        route: backendContext.backend || activeBackend(),
        hash: `${registeredPublicKey.substring(0, 6)}...${registeredPublicKey.substring(registeredPublicKey.length - 6)}`
    };
    try {
        await recordAccessLog(logEntry);
    } catch (err) {
        return auditUnavailable(res, err, { registrationCommitted: true });
    }
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
    if (!validatePublicKeyPem(publicKey)) return res.status(400).json({ error: 'A valid P-256 SPKI publicKey PEM is required' });
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
        await withDeviceOperation(id, () => simulatorKeys.has(id)
            ? deviceStore.removeSimulatorDevice(id)
            : deviceStore.remove(id));
        const list = await deviceStore.getAll();
        res.status(200).json({ devices: list });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

app.post('/api/stress', requireAuth, (req, res) => {
    const { isStressTesting: stress } = req.body;
    if (stress !== true) return res.status(400).json({ error: 'isStressTesting must be true' });
    if (isStressTesting) return res.status(409).json({ error: 'A stress test is already running' });

    isStressTesting = true;
    stressReport = null;
    stressSession = {
        startedAt: Date.now(),
        accepting: true,
        inFlight: 0,
        samples: [],
    };
    console.log("   🔥 [STRESS TEST INITIALIZED] Measuring /api/access traffic for 3 seconds...");
    setTimeout(() => finishStressSession(stressSession), 3000);
    res.status(202).json({ isStressTesting, startedAt: new Date(stressSession.startedAt).toISOString(), durationMs: 3000 });
});

// Gateway Edge Request Handler — rate limited, timestamp & replay protected
app.post('/api/access', measureStressRequest, rateLimit({ windowMs: 60 * 1000, max: 120, message: 'Rate limit exceeded: max 120 access requests per minute' }), async (req, res) => {
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
            route: 'GATEWAY',
            hash: 'N/A'
        };
        try {
            await recordAccessLog(logEntry);
        } catch (err) {
            return auditUnavailable(res, err, { isStressTesting });
        }
        return res.status(400).json({ status: "error", message: "Missing required fields: device_id, action, timestamp, signature", isStressTesting });
    }

    let device;
    const backendContext = {};
    try {
        device = await deviceStore.get(payload.device_id, true, backendContext);
        res.locals.backend = backendContext.backend;
    } catch (err) {
        res.locals.backend = backendContext.backend || activeBackend();
        console.error(`   ⚠️ [ACCESS] Authoritative ledger read failed: ${err.message}`);
        return res.status(503).json({
            status: 'error',
            message: 'Access unavailable: authoritative ledger could not be reached',
            isStressTesting,
        });
    }

    if (!device) {
        const logEntry = {
            id: `REQ-${crypto.randomUUID()}`,
            deviceId: payload.device_id,
            endpoint: `/api/v1/${payload.action}`,
            status: 'DENIED',
            route: res.locals.backend,
            hash: payload.signature ? `${payload.signature.substring(0, 6)}...${payload.signature.substring(payload.signature.length - 3)}` : 'N/A'
        };
        try {
            await recordAccessLog(logEntry);
        } catch (err) {
            return auditUnavailable(res, err, { isStressTesting });
        }
        return res.status(401).json({ status: "error", message: "Unknown device: not registered", isStressTesting });
    }

    if (!isTimestampFresh(payload.timestamp)) {
        const logEntry = {
            id: `REQ-${crypto.randomUUID()}`,
            deviceId: payload.device_id,
            endpoint: `/api/v1/${payload.action}`,
            status: 'DENIED',
            route: res.locals.backend,
            hash: `${payload.signature.substring(0, 6)}...${payload.signature.substring(payload.signature.length - 3)}`
        };
        try {
            await recordAccessLog(logEntry);
        } catch (err) {
            return auditUnavailable(res, err, { isStressTesting });
        }
        return res.status(401).json({ status: "error", message: "Stale timestamp: must be within 5 minutes", isStressTesting });
    }

    const isValid = validateSignature(payload, device && device.publicKey);
    if (!isValid) {
        console.log(`   ❌ [SECURITY ALERT] Signature mismatch. Payload rejected!`);

        const logEntry = {
            id: `REQ-${crypto.randomUUID()}`,
            deviceId: payload.device_id || 'UNKNOWN',
            endpoint: `/api/v1/${payload.action || 'access'}`,
            status: 'DENIED',
            route: res.locals.backend,
            hash: payload.signature ? `${payload.signature.substring(0, 6)}...${payload.signature.substring(payload.signature.length - 3)}` : 'N/A'
        };
        try {
            await recordAccessLog(logEntry);
        } catch (err) {
            return auditUnavailable(res, err, { isStressTesting });
        }

        return res.status(401).json({
            status: "error",
            message: "Unauthorized: Invalid cryptographic signature",
            isStressTesting
        });
    }

    const requestKey = `${payload.device_id}:${payload.action}:${payload.timestamp}`;
    const logEntry = {
        id: `REQ-AUTH-${crypto.createHash('sha256').update(requestKey).digest('hex')}`,
        deviceId: payload.device_id,
        endpoint: `/api/v1/${payload.action || 'access'}`,
        status: device.status === 'REVOKED' ? 'REVOKED' : 'GRANTED',
        route: res.locals.backend,
        hash: `${payload.signature.substring(0, 6)}...${payload.signature.substring(payload.signature.length - 3)}`
    };
    let claimed;
    try {
        claimed = await claimAuthenticatedRequest(logEntry);
    } catch (err) {
        console.error(`   ⚠️ [SECURITY] Replay claim failed: ${err.message}`);
        return res.status(503).json({
            status: 'error',
            message: 'Access unavailable: replay protection could not be verified',
            isStressTesting,
        });
    }
    if (!claimed) {
        console.log(`   ❌ [SECURITY ALERT] Authenticated request replay rejected!`);
        const replayLog = { ...logEntry, id: `REQ-${crypto.randomUUID()}`, status: 'DENIED' };
        try {
            await recordAccessLog(replayLog);
        } catch (err) {
            return auditUnavailable(res, err, { isStressTesting });
        }
        return res.status(401).json({
            status: 'error',
            message: 'Unauthorized: Authenticated request replay detected',
            isStressTesting,
        });
    }

    logEntry.createdAt = new Date().toISOString();
    cacheAccessLog(logEntry);

    if (device && device.status === 'REVOKED') {
        console.log(`   ❌ [ACCESS REVOKED] Authenticated request rejected due to revoked status.`);

        return res.status(403).json({
            status: "error",
            message: "Forbidden: Device registration is revoked",
            isStressTesting
        });
    }

    console.log(`   ✅ [ACCESS GRANTED] Signature verified. (Backend: ${res.locals.backend})`);

    res.status(200).json({
        status: "success",
        message: "Access granted and logged",
        routed_to: res.locals.backend,
        isStressTesting
    });
});

app.listen(PORT, () => {
    console.log("=========================================");
    console.log(`🚦 IoT API Gateway (production) live!`);
    console.log(`📡 Listening for edge devices on port ${PORT}`);
    console.log(`🔗 Active backend: ${activeBackend()}${ledgerError ? ` (error: ${ledgerError})` : ''}`);
    console.log(`🗄️  Persistence: ${dbMode}${dbMode === 'POSTGRES' ? ' (Supabase)' : ' (in-memory fallback)'}`);
    console.log(`🌐 CORS origin: ${FRONTEND_URL}`);
    console.log("=========================================\n");
});

loadSupabaseJwks();

// Production: do NOT seed fake devices. Only seed if explicitly enabled and DB is empty, using real registered devices.
// This block is intentionally disabled in production — devices must be registered via /api/devices/register with real PEM keys.
// If you need demo seeding, set SEED_DEMO_DEVICES=true
if (process.env.SEED_DEMO_DEVICES === 'true' && dbMode === 'POSTGRES' && enabledRoutes.length === 0) {
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
