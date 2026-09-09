'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.SUPABASE_JWT_SECRET = 'test-only-readiness-secret-at-least-32-bytes';
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.FABRIC_ENABLED;
delete process.env.IOTA_ENABLED;

const { app, __test } = require('../gateway');

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
    process.env.NODE_ENV = 'development';
    __test.reset();
});

test('health remains a dependency-free liveness check', async () => {
    process.env.NODE_ENV = 'production';
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'ok');
});

test('readiness rejects volatile persistence in production', async () => {
    process.env.NODE_ENV = 'production';
    const response = await fetch(`${baseUrl}/readyz`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).status, 'not_ready');
});

test('readiness probes every enabled ledger', async () => {
    const originalCheckFabric = __test.fabric.checkHealth;
    const originalCheckIota = __test.iota.checkHealth;
    __test.fabric.checkHealth = async () => true;
    __test.iota.checkHealth = async () => { throw new Error('IOTA unavailable'); };
    __test.reset({ routes: ['FABRIC', 'IOTA'] });
    try {
        const response = await fetch(`${baseUrl}/readyz`);
        assert.equal(response.status, 503);
        assert.deepEqual((await response.json()).checks.backends, ['FABRIC', 'IOTA']);
    } finally {
        __test.fabric.checkHealth = originalCheckFabric;
        __test.iota.checkHealth = originalCheckIota;
    }
});
