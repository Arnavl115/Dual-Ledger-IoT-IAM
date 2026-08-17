const express = require('express');
const crypto = require('crypto');
const fabric = require('./fabric-client');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Simple Custom CORS Middleware
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

// Device Store Abstraction: talks to the Fabric ledger when enabled,
// otherwise falls back to the in-memory mock state.
const deviceStore = {
    async getAll() {
        if (ledgerMode === 'FABRIC') {
            try {
                return await fabric.getAllDevices();
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [FABRIC] getAllDevices failed: ${err.message}`);
                return devices;
            }
        }
        return devices;
    },

    async get(id) {
        if (ledgerMode === 'FABRIC') {
            try {
                return await fabric.getDevice(id);
            } catch (err) {
                ledgerError = err.message;
                console.error(`   ⚠️ [FABRIC] getDevice failed: ${err.message}`);
                return devices.find(d => d.id === id) || null;
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
        return null;
    }
};

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
app.get('/api/state', async (req, res) => {
    const deviceList = await deviceStore.getAll();
    res.status(200).json({
        activeRoute,
        isStressTesting,
        ledgerMode,
        ledgerError,
        devices: deviceList,
        logs,
        tpsData: tpsHistory
    });
});

app.get('/api/devices', async (req, res) => {
    const deviceList = await deviceStore.getAll();
    res.status(200).json(deviceList);
});

app.post('/api/route', (req, res) => {
    const { route } = req.body;
    if (route === 'FABRIC' || route === 'IOTA') {
        activeRoute = route;
        return res.status(200).json({ activeRoute });
    }
    res.status(400).json({ error: 'Invalid ledger route' });
});

app.post('/api/devices/toggle', async (req, res) => {
    const { deviceId } = req.body;
    if (ledgerMode === 'FABRIC') {
        const updated = await deviceStore.toggle(deviceId);
        if (updated) {
            const deviceList = await deviceStore.getAll();
            return res.status(200).json({ devices: deviceList });
        }
    }
    devices = devices.map(d => {
        if (d.id === deviceId) {
            const newStatus = d.status === 'ACTIVE' ? 'REVOKED' : 'ACTIVE';
            return { ...d, status: newStatus };
        }
        return d;
    });
    res.status(200).json({ devices });
});

app.post('/api/devices/register', async (req, res) => {
    const { id, key } = req.body;
    if (id && key) {
        const formattedId = id.trim().replace(/\s+/g, '_');
        const formattedKey = key.startsWith('0x') ? key : `0x${key}`;
        await deviceStore.register(formattedId, formattedKey);
        const deviceList = await deviceStore.getAll();
        return res.status(200).json({ devices: deviceList });
    }
    res.status(400).json({ error: 'Missing device parameters' });
});

app.post('/api/stress', (req, res) => {
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
            id: `REQ-${processedCount}`,
            deviceId: payload.device_id || 'UNKNOWN',
            endpoint: `/api/v1/${payload.action || 'access'}`,
            status: 'DENIED',
            route: activeRoute,
            hash: payload.signature ? `${payload.signature.substring(0, 6)}...${payload.signature.substring(payload.signature.length - 3)}` : 'N/A'
        };
        logs.unshift(logEntry);
        if (logs.length > 40) logs.pop();

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
            id: `REQ-${processedCount}`,
            deviceId: payload.device_id,
            endpoint: `/api/v1/${payload.action || 'access'}`,
            status: 'REVOKED',
            route: activeRoute,
            hash: `${payload.signature.substring(0, 6)}...${payload.signature.substring(payload.signature.length - 3)}`
        };
        logs.unshift(logEntry);
        if (logs.length > 40) logs.pop();

        return res.status(403).json({
            status: "error",
            message: "Forbidden: Device registration is revoked",
            isStressTesting
        });
    }

    console.log(`   ✅ [ACCESS GRANTED] Signature verified. (Route: ${activeRoute})`);

    const logEntry = {
        id: `REQ-${processedCount}`,
        deviceId: payload.device_id,
        endpoint: `/api/v1/${payload.action || 'access'}`,
        status: 'GRANTED',
        route: activeRoute,
        hash: `${payload.signature.substring(0, 6)}...${payload.signature.substring(payload.signature.length - 3)}`
    };
    logs.unshift(logEntry);
    if (logs.length > 40) logs.pop();

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
    console.log("=========================================\n");
});