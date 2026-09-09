'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const jwt = require('jsonwebtoken');

process.env.SUPABASE_JWT_SECRET = 'test-only-gateway-secret-at-least-32-bytes';
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.FABRIC_ENABLED;
delete process.env.IOTA_ENABLED;

const gateway = require('../gateway');
const { app, deviceStore, __test } = gateway;

const keyPair = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const adminToken = jwt.sign({
    sub: 'admin-1',
    role: 'authenticated',
    app_metadata: { role: 'admin' },
}, process.env.SUPABASE_JWT_SECRET, { algorithm: 'HS256', audience: 'authenticated', expiresIn: '5m' });

let server;
let baseUrl;

test.before(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test.beforeEach(() => {
    __test.reset();
});

async function request(path, { token = adminToken, body, rawBody, method = 'GET' } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined || rawBody !== undefined) headers['content-type'] = 'application/json';
    const requestBody = rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body);
    const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(requestBody === undefined ? {} : { body: requestBody }),
    });
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null };
}

function signedPayload(deviceId, action = 'unlock', timestamp = Math.floor(Date.now() / 1000)) {
    const data = `${deviceId}:${action}:${timestamp}`;
    return {
        device_id: deviceId,
        action,
        timestamp,
        signature: crypto.sign('sha256', Buffer.from(data), keyPair.privateKey).toString('base64'),
    };
}

test('admin endpoints enforce authentication, role, audience, and expiry', async () => {
    assert.equal((await request('/api/devices', { token: null })).response.status, 401);
    assert.equal((await request('/api/devices', { token: 'not-a-jwt' })).response.status, 401);

    const userToken = jwt.sign({
        sub: 'user-1', role: 'authenticated', app_metadata: { role: 'viewer' },
    }, process.env.SUPABASE_JWT_SECRET, { audience: 'authenticated' });
    assert.equal((await request('/api/devices', { token: userToken })).response.status, 403);

    const wrongAudience = jwt.sign({
        sub: 'admin-1', role: 'authenticated', app_metadata: { role: 'admin' },
    }, process.env.SUPABASE_JWT_SECRET, { audience: 'other-service' });
    assert.equal((await request('/api/devices', { token: wrongAudience })).response.status, 401);

    const expired = jwt.sign({
        sub: 'admin-1', role: 'authenticated', app_metadata: { role: 'admin' }, exp: 1,
    }, process.env.SUPABASE_JWT_SECRET, { audience: 'authenticated' });
    assert.equal((await request('/api/devices', { token: expired })).response.status, 401);
    assert.equal((await request('/api/devices')).response.status, 200);
});

test('access rejects stale, future, malformed, and mismatched signatures', async () => {
    __test.reset({ memoryDevices: [{ id: 'device-1', publicKey: keyPair.publicKey, status: 'ACTIVE' }] });

    const stale = signedPayload('device-1', 'unlock', Math.floor(Date.now() / 1000) - 301);
    assert.match((await request('/api/access', { method: 'POST', token: null, body: stale })).body.message, /Stale timestamp/);

    const future = signedPayload('device-1', 'unlock', Math.floor(Date.now() / 1000) + 31);
    assert.match((await request('/api/access', { method: 'POST', token: null, body: future })).body.message, /Stale timestamp/);

    const mismatched = signedPayload('device-1');
    mismatched.action = 'lock';
    assert.match((await request('/api/access', { method: 'POST', token: null, body: mismatched })).body.message, /Invalid cryptographic signature/);

    const malformed = { ...signedPayload('device-1'), signature: 'not-base64!' };
    assert.equal((await request('/api/access', { method: 'POST', token: null, body: malformed })).response.status, 401);
});

test('authenticated requests are claimed once and revoked devices remain forbidden', async () => {
    __test.reset({ memoryDevices: [{ id: 'device-1', publicKey: keyPair.publicKey, status: 'ACTIVE' }] });
    const payload = signedPayload('device-1');
    assert.equal((await request('/api/access', { method: 'POST', token: null, body: payload })).response.status, 200);
    const replay = await request('/api/access', { method: 'POST', token: null, body: payload });
    assert.equal(replay.response.status, 401);
    assert.match(replay.body.message, /replay detected/);

    __test.reset({ memoryDevices: [{ id: 'device-2', publicKey: keyPair.publicKey, status: 'REVOKED' }] });
    const revoked = await request('/api/access', { method: 'POST', token: null, body: signedPayload('device-2') });
    assert.equal(revoked.response.status, 403);
    assert.match(revoked.body.message, /revoked/);
});

test('authoritative ledger failure never grants from a revoked or stale fallback', async t => {
    const original = __test.fabric.getDevice;
    t.after(() => { __test.fabric.getDevice = original; });
    __test.fabric.getDevice = async () => { throw new Error('peer unavailable'); };
    __test.reset({
        routes: ['FABRIC'],
        memoryDevices: [{ id: 'device-1', publicKey: keyPair.publicKey, status: 'ACTIVE' }],
    });

    const result = await request('/api/access', { method: 'POST', token: null, body: signedPayload('device-1') });
    assert.equal(result.response.status, 503);
    assert.match(result.body.message, /authoritative ledger could not be reached/);
});

test('endpoint failures are JSON and disabled routes are explicit', async () => {
    const missing = await request('/api/not-real');
    assert.equal(missing.response.status, 404);
    assert.equal(missing.body.error, 'Endpoint not found');

    const malformed = await request('/api/route', { method: 'POST', rawBody: '{' });
    assert.equal(malformed.response.status, 400);
    assert.equal(malformed.body.error, 'Invalid JSON request body');

    const disabled = await request('/api/route', { method: 'POST', body: { route: 'FABRIC' } });
    assert.equal(disabled.response.status, 409);
    assert.match(disabled.body.error, /not enabled/);
});

test('overlapping mutations for one device fail fast without invoking the adapter twice', async t => {
    const originalToggle = deviceStore.toggle;
    const originalGetAll = deviceStore.getAll;
    t.after(() => {
        deviceStore.toggle = originalToggle;
        deviceStore.getAll = originalGetAll;
    });
    let release;
    let calls = 0;
    deviceStore.toggle = async () => {
        calls++;
        await new Promise(resolve => { release = resolve; });
    };
    deviceStore.getAll = async () => [];

    const first = request('/api/devices/toggle', { method: 'POST', body: { deviceId: 'device-1' } });
    while (!release) await new Promise(resolve => setImmediate(resolve));
    const second = await request('/api/devices/toggle', { method: 'POST', body: { deviceId: 'device-1' } });
    assert.equal(second.response.status, 409);
    assert.equal(calls, 1);
    release();
    assert.equal((await first).response.status, 200);
});
