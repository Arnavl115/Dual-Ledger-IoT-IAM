'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SimulatorKeyStore } = require('../simulator-key-store');

function temporaryStore(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'simulator-keys-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return new SimulatorKeyStore(path.join(directory, 'keys.json'));
}

test('stores a generated P-256 key and removes it', t => {
    const store = temporaryStore(t);
    const { publicKey, privateKey } = store.generateKeyPair();

    store.add('device-1', privateKey);
    assert.equal(store.has('device-1'), true);

    const stored = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
    const derivedPublicKey = crypto.createPublicKey(stored['device-1'])
        .export({ type: 'spki', format: 'pem' });
    assert.equal(derivedPublicKey, publicKey);

    assert.equal(store.remove('device-1'), true);
    assert.equal(store.remove('device-1'), false);
    assert.equal(store.has('device-1'), false);
});

test('refuses duplicate devices and non-P-256 private keys', t => {
    const store = temporaryStore(t);
    const { privateKey } = store.generateKeyPair();
    store.add('device-1', privateKey);

    assert.throws(() => store.add('device-1', privateKey), /already exists/);

    const rsaKey = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
    assert.throws(() => store.add('device-2', rsaKey), /P-256/);
});
