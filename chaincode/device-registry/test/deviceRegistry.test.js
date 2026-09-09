'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const DeviceRegistry = require('../lib/deviceRegistry');

const publicKey = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
}).publicKey;

function context({ mspId = 'Org1MSP', clientId = 'x509::/OU=admin/CN=Admin@org1::/CN=ca', timestamp = 1_700_000_000 } = {}) {
    const state = new Map();
    const writes = [];
    const events = [];
    return {
        state,
        writes,
        events,
        clientIdentity: {
            getMSPID: () => mspId,
            getID: () => clientId,
        },
        stub: {
            getState: async id => state.get(id) || Buffer.alloc(0),
            putState: async (id, value) => { state.set(id, value); writes.push([id, Buffer.from(value)]); },
            deleteState: async id => state.delete(id),
            setEvent: (name, value) => events.push([name, Buffer.from(value)]),
            getTxTimestamp: () => ({ seconds: { toNumber: () => timestamp }, nanos: 123_000_000 }),
        },
    };
}

test('only the configured organization admin endorser can mutate devices', async () => {
    const contract = new DeviceRegistry();
    await assert.rejects(
        contract.RegisterDevice(context({ mspId: 'Org2MSP' }), 'device-1', publicKey),
        /Org1MSP admin identity required/
    );
    await assert.rejects(
        contract.RegisterDevice(context({ clientId: 'x509::/OU=client/CN=user::/CN=ca' }), 'device-1', publicKey),
        /Org1MSP admin identity required/
    );

    const org1Admin = context();
    const result = JSON.parse(await contract.RegisterDevice(org1Admin, 'device-1', publicKey));
    assert.equal(result.Status, 'ACTIVE');
    assert.match(result.RegisteredBy, /^Org1MSP:/);
});

test('multiple endorsers produce identical writes and events for a fixed transaction timestamp', async () => {
    const contract = new DeviceRegistry();
    const first = context({ clientId: 'x509::/OU=admin/CN=Admin@org1::/CN=ca' });
    const second = context({ clientId: 'x509::/OU=admin/CN=Admin@org1::/CN=ca' });

    const firstResult = await contract.RegisterDevice(first, 'device-1', publicKey);
    const secondResult = await contract.RegisterDevice(second, 'device-1', publicKey);

    assert.equal(firstResult, secondResult);
    assert.equal(first.writes[0][1].toString('hex'), second.writes[0][1].toString('hex'));
    assert.equal(first.events[0][1].toString('hex'), second.events[0][1].toString('hex'));
    assert.equal(JSON.parse(firstResult).RegisteredAt, '2023-11-14T22:13:20.123Z');
});

test('status mutations use the Fabric transaction timestamp, never wall-clock time', async () => {
    const contract = new DeviceRegistry();
    const ctx = context({ timestamp: 1_800_000_000 });
    await contract.RegisterDevice(ctx, 'device-1', publicKey);

    const revoked = JSON.parse(await contract.RevokeDevice(ctx, 'device-1'));
    assert.equal(revoked.Status, 'REVOKED');
    assert.equal(revoked.UpdatedAt, '2027-01-15T08:00:00.123Z');
    assert.equal(JSON.parse(ctx.events.at(-1)[1]).timestamp, revoked.UpdatedAt);
});
