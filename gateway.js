const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = 3000;

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
app.get('/api/state', (req, res) => {
    res.status(200).json({
        activeRoute,
        isStressTesting,
        devices,
        logs,
        tpsData: tpsHistory
    });
});

app.get('/api/devices', (req, res) => {
    res.status(200).json(devices);
});

app.post('/api/route', (req, res) => {
    const { route } = req.body;
    if (route === 'FABRIC' || route === 'IOTA') {
        activeRoute = route;
        return res.status(200).json({ activeRoute });
    }
    res.status(400).json({ error: 'Invalid ledger route' });
});

app.post('/api/devices/toggle', (req, res) => {
    const { deviceId } = req.body;
    devices = devices.map(d => {
        if (d.id === deviceId) {
            const newStatus = d.status === 'ACTIVE' ? 'REVOKED' : 'ACTIVE';
            return { ...d, status: newStatus };
        }
        return d;
    });
    res.status(200).json({ devices });
});

app.post('/api/devices/register', (req, res) => {
    const { id, key } = req.body;
    if (id && key) {
        const formattedId = id.trim().replace(/\s+/g, '_');
        const formattedKey = key.startsWith('0x') ? key : `0x${key}`;
        const newDevice = {
            id: formattedId,
            key: formattedKey,
            status: 'ACTIVE'
        };
        // Avoid duplicate ids
        if (!devices.some(d => d.id === formattedId)) {
            devices.push(newDevice);
        }
        return res.status(200).json({ devices });
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
app.post('/api/access', (req, res) => {
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
    const device = devices.find(d => d.id === payload.device_id);
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
    console.log("=========================================\n");
});