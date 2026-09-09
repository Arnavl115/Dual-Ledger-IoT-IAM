'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.SUPABASE_JWT_SECRET = 'test-only-gateway-secret-at-least-32-bytes';
const { deviceStore, __test } = require('../gateway');

function replace(t, object, name, implementation) {
    const original = object[name];
    object[name] = implementation;
    t.after(() => { object[name] = original; });
}

test.beforeEach(() => __test.reset());

test('Fabric mutations synchronize their committed state to Postgres', async t => {
    const committed = { id: 'device-1', publicKey: 'fabric-key', status: 'REVOKED' };
    let synchronized;
    replace(t, __test.fabric, 'toggleDeviceStatus', async () => committed);
    replace(t, __test.db, 'upsertDevice', async (...args) => { synchronized = args; });
    __test.reset({ routes: ['FABRIC'], mode: 'POSTGRES' });

    assert.deepEqual(await deviceStore.toggle('device-1'), committed);
    assert.deepEqual(synchronized, ['device-1', 'fabric-key', 'REVOKED']);
});

test('IOTA key rotations synchronize their committed state to Postgres', async t => {
    const committed = { id: 'device-2', publicKey: 'new-iota-key', status: 'ACTIVE' };
    let synchronized;
    replace(t, __test.iota, 'updateDevicePublicKey', async () => committed);
    replace(t, __test.db, 'upsertDevice', async (...args) => { synchronized = args; });
    __test.reset({ routes: ['IOTA'], mode: 'POSTGRES' });

    assert.deepEqual(await deviceStore.updatePublicKey('device-2', 'new-iota-key'), committed);
    assert.deepEqual(synchronized, ['device-2', 'new-iota-key', 'ACTIVE']);
});

test('Postgres-only registration checks and inserts atomically at the adapter boundary', async t => {
    const calls = [];
    replace(t, __test.db, 'getDevice', async id => { calls.push(['get', id]); return null; });
    replace(t, __test.db, 'insertDevice', async (...args) => { calls.push(['insert', ...args]); });
    __test.reset({ mode: 'POSTGRES' });

    await deviceStore.register('device-3', null, 'postgres-key');
    assert.deepEqual(calls, [
        ['get', 'device-3'],
        ['insert', 'device-3', 'postgres-key', 'ACTIVE'],
    ]);
});

test('a Postgres synchronization failure is surfaced after a Fabric commit', async t => {
    let fabricCommits = 0;
    replace(t, __test.fabric, 'revokeDevice', async () => {
        fabricCommits++;
        return { id: 'device-1', publicKey: 'key', status: 'REVOKED' };
    });
    replace(t, __test.db, 'upsertDevice', async () => { throw new Error('postgres unavailable'); });
    __test.reset({ routes: ['FABRIC'], mode: 'POSTGRES' });

    await assert.rejects(deviceStore.setStatus('device-1', 'REVOKED'), /postgres unavailable/);
    assert.equal(fabricCommits, 1);
    assert.equal(__test.state().ledgerError, 'postgres unavailable');
});

test('dual-ledger registration compensates Fabric when IOTA fails', async t => {
    const calls = [];
    replace(t, __test.fabric, 'getDevice', async () => null);
    replace(t, __test.iota, 'getDevice', async () => null);
    replace(t, __test.fabric, 'registerDevice', async id => {
        calls.push(`fabric-register:${id}`);
        return { id, publicKey: 'generated', status: 'ACTIVE' };
    });
    replace(t, __test.iota, 'registerDevice', async id => {
        calls.push(`iota-register:${id}`);
        throw new Error('IOTA commit rejected');
    });
    replace(t, __test.fabric, 'deleteDevice', async id => { calls.push(`fabric-delete:${id}`); });
    __test.reset({ routes: ['FABRIC', 'IOTA'] });

    await assert.rejects(deviceStore.registerSimulatorDevice('device-4'), /IOTA commit rejected/);
    assert.deepEqual(calls, [
        'fabric-register:device-4',
        'iota-register:device-4',
        'fabric-delete:device-4',
    ]);
});

test('partial dual-ledger deletion reports every failed adapter', async t => {
    replace(t, __test.fabric, 'getDevice', async () => ({ id: 'device-5' }));
    replace(t, __test.iota, 'getDevice', async () => ({ id: 'device-5' }));
    replace(t, __test.fabric, 'deleteDevice', async () => { throw new Error('Fabric unavailable'); });
    replace(t, __test.iota, 'deleteDevice', async () => { throw new Error('IOTA unavailable'); });
    replace(t, __test.db, 'deleteDevice', async () => { throw new Error('Postgres unavailable'); });
    __test.reset({ routes: ['FABRIC', 'IOTA'], mode: 'POSTGRES' });

    await assert.rejects(
        deviceStore.removeSimulatorDevice('device-5'),
        error => error.status === 502
            && /Fabric unavailable/.test(error.message)
            && /IOTA unavailable/.test(error.message)
            && /Postgres unavailable/.test(error.message)
    );
});
