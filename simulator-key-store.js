'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

class SimulatorKeyStore {
    constructor(filePath = process.env.SIMULATOR_KEY_FILE || path.join(__dirname, 'ecdsa_keys.json')) {
        this.filePath = path.resolve(filePath);
    }

    generateKeyPair() {
        return crypto.generateKeyPairSync('ec', {
            namedCurve: 'prime256v1',
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        });
    }

    has(deviceId) {
        return Object.hasOwn(this._load(), deviceId);
    }

    add(deviceId, privateKey) {
        const keys = this._load();
        if (Object.hasOwn(keys, deviceId)) {
            throw new Error(`Simulator device ${deviceId} already exists`);
        }
        crypto.createPrivateKey(privateKey);
        keys[deviceId] = privateKey;
        this._save(keys);
    }

    remove(deviceId) {
        const keys = this._load();
        if (!Object.hasOwn(keys, deviceId)) return false;
        delete keys[deviceId];
        this._save(keys);
        return true;
    }

    _load() {
        if (!fs.existsSync(this.filePath)) return {};
        const keys = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        if (!keys || Array.isArray(keys) || typeof keys !== 'object'
            || Object.entries(keys).some(([id, key]) => !id || typeof key !== 'string')) {
            throw new Error(`Invalid simulator key file: ${this.filePath}`);
        }
        return keys;
    }

    _save(keys) {
        const directory = path.dirname(this.filePath);
        fs.mkdirSync(directory, { recursive: true });
        const tempPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        fs.writeFileSync(tempPath, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
        try {
            fs.renameSync(tempPath, this.filePath);
        } catch (error) {
            fs.rmSync(tempPath, { force: true });
            throw error;
        }
    }
}

module.exports = { SimulatorKeyStore };
