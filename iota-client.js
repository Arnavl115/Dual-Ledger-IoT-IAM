'use strict';

// IOTA Tangle ledger adapter backed by the IOTA Notarization toolkit
// (Dynamic Notarization: one updatable on-chain object per device).
//
// Mirrors the fabric-client.js interface so the gateway can switch
// between Fabric and IOTA transparently:
//   isEnabled, initLedger, getAllDevices, getDevice,
//   registerDevice, toggleDeviceStatus, revokeDevice, close

const fs = require('node:fs');
const path = require('node:path');

const { IotaClient } = require('@iota/iota-sdk/client');
const { Ed25519Keypair } = require('@iota/iota-sdk/keypairs/ed25519');
const { requestIotaFromFaucetV0 } = require('@iota/iota-sdk/faucet');
const { Ed25519KeypairSigner } = require('@iota/iota-interaction-ts/node/test_utils');
const { NotarizationClient, NotarizationClientReadOnly, State } = require('@iota/notarization/node');

const nodeUrl = process.env.IOTA_NODE_URL || 'https://api.testnet.iota.cafe';
const faucetUrl = process.env.IOTA_FAUCET_URL || 'https://faucet.testnet.iota.cafe';
const pkgId = process.env.IOTA_NOTARIZATION_PKG_ID || '';
const registryPath = process.env.IOTA_REGISTRY_PATH || path.join(__dirname, '.iota-registry.json');
const keyPath = process.env.IOTA_KEY_PATH || path.join(__dirname, '.iota-key.json');

let iotaClient = null;
let readOnlyClient = null;
let client = null;
let registry = loadRegistry();

function isEnabled() {
    return process.env.IOTA_ENABLED === 'true';
}

// ------------------------------------------------------------------
// Signer / key management
// ------------------------------------------------------------------

function loadOrCreateKeypair() {
    // Prefer an explicitly configured private key (IOTA bech32 string,
    // e.g. iotaprivkey1qp2xatmfvvyeg9q...).
    if (process.env.IOTA_PRIVATE_KEY) {
        return Ed25519Keypair.fromSecretKey(process.env.IOTA_PRIVATE_KEY);
    }
    // Otherwise keep a stable signer across restarts so created
    // notarizations stay owned by the same gateway address.
    if (fs.existsSync(keyPath)) {
        const stored = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
        return Ed25519Keypair.fromSecretKey(stored.secretKey);
    }
    const keypair = Ed25519Keypair.generate();
    fs.writeFileSync(keyPath, JSON.stringify({
        secretKey: keypair.getSecretKey(),
    }, null, 2));
    return keypair;
}

function loadRegistry() {
    try {
        return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    } catch {
        return {};
    }
}

function saveRegistry() {
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ensureFunded(address) {
    try {
        const balance = await iotaClient.getBalance({ owner: address });
        if (Number(balance.totalBalance) > 0) {
            return;
        }
    } catch (err) {
        console.warn(`   ⚠️ [IOTA] getBalance failed for ${address}: ${err.message} — skipping faucet`);
        return;
    }
    console.log(`   🌐 [IOTA] Requesting test tokens from faucet for ${address} ...`);
    try {
        await requestIotaFromFaucetV0({ host: faucetUrl, recipient: address });
    } catch (err) {
        console.warn(`   ⚠️ [IOTA] Faucet request failed (use https://faucet.testnet.iota.cafe manually): ${err.message}`);
        console.warn(`   ⚠️ [IOTA] Fund ${address} via web faucet and restart gateway`);
        return;
    }
    for (let i = 0; i < 10; i++) {
        await sleep(2000);
        try {
            const check = await iotaClient.getBalance({ owner: address });
            if (Number(check.totalBalance) > 0) {
                console.log(`   ✅ [IOTA] Funded ${address}`);
                return;
            }
        } catch {}
    }
    console.warn(`   ⚠️ [IOTA] Faucet did not fund ${address} yet; fund manually at ${faucetUrl} and retry on next write.`);
}

async function connect() {
    if (client) {
        return client;
    }
    if (!pkgId) {
        throw new Error('IOTA_NOTARIZATION_PKG_ID is not configured. Publish the Notarization Move package and set it in .env');
    }
    iotaClient = new IotaClient({ url: nodeUrl });
    readOnlyClient = await NotarizationClientReadOnly.createWithPkgId(iotaClient, pkgId);
    const keypair = loadOrCreateKeypair();
    const signer = new Ed25519KeypairSigner(keypair);
    client = await NotarizationClient.create(readOnlyClient, signer);
    await ensureFunded(client.senderAddress());
    console.log(`   🔗 [IOTA] Connected to ${nodeUrl} (package ${pkgId})`);
    return client;
}

// ------------------------------------------------------------------
// Device <-> Notarization state mapping
// ------------------------------------------------------------------

function deviceToState(device) {
    return JSON.stringify({
        device_id: device.id,
        public_key: device.publicKey || device.key,
        status: device.status,
    });
}

function stateToDevice(state) {
    const parsed = JSON.parse(state.data.toString());
    return {
        id: parsed.device_id,
        key: parsed.public_key,
        publicKey: parsed.public_key,
        status: parsed.status,
    };
}

async function writeState(device) {
    const c = await connect();
    const notarizationId = registry[device.id];
    if (!notarizationId) {
        throw new Error(`Device ${device.id} is not registered on the Tangle`);
    }
    const state = State.fromString(deviceToState(device), new Date().toISOString());
    await c.updateState(state, notarizationId).buildAndExecute(c);
    await c.updateMetadata(JSON.stringify({ lastChange: new Date().toISOString() }), notarizationId).buildAndExecute(c);
}

// ------------------------------------------------------------------
// Public interface (mirrors fabric-client.js)
// ------------------------------------------------------------------

async function initLedger(seedDevices) {
    const c = await connect();
    for (const device of seedDevices) {
        if (!registry[device.id]) {
            await registerDevice(device.id, device.publicKey || device.key);
        }
    }
    return true;
}

async function getAllDevices() {
    await connect();
    const results = [];
    for (const deviceId of Object.keys(registry)) {
        try {
            results.push(await getDevice(deviceId));
        } catch (err) {
            console.error(`   ⚠️ [IOTA] getDevice(${deviceId}) failed: ${err.message}`);
        }
    }
    return results;
}

async function getDevice(id) {
    await connect();
    const notarizationId = registry[id];
    if (!notarizationId) {
        return null;
    }
    // NOTE: @iota/notarization@0.1.14 WASM `readOnlyClient.state()` aborts
    // the process on Node 26 ("null pointer passed to rust"), so reads go
    // through plain JSON-RPC instead. The device JSON lives at
    // fields.state.fields.data (verified on-chain 2026-09-05).
    const obj = await iotaClient.getObject({
        id: notarizationId,
        options: { showContent: true },
    });
    const content = obj && obj.data && obj.data.content;
    const data = content && content.fields && content.fields.state
        && content.fields.state.fields && content.fields.state.fields.data;
    if (!data) {
        return null;
    }
    return stateToDevice({ data: Buffer.from(data) });
}

async function registerDevice(id, publicKey) {
    const c = await connect();
    if (registry[id]) {
        return getDevice(id);
    }
    const state = deviceToState({ id, publicKey, status: 'ACTIVE' });
    const { output } = await c
        .createDynamic()
        .withStringState(state, new Date().toISOString())
        .withImmutableDescription(id)
        .withUpdatableMetadata(JSON.stringify({ lastChange: new Date().toISOString() }))
        .finish()
        .buildAndExecute(c);
    registry[id] = output.id;
    saveRegistry();
    return getDevice(id);
}

async function toggleDeviceStatus(id) {
    const device = await getDevice(id);
    if (!device) {
        return null;
    }
    device.status = device.status === 'ACTIVE' ? 'REVOKED' : 'ACTIVE';
    await writeState(device);
    return getDevice(id);
}

async function revokeDevice(id) {
    const device = await getDevice(id);
    if (!device) {
        return null;
    }
    device.status = 'REVOKED';
    await writeState(device);
    return getDevice(id);
}

function close() {
    // WASM clients manage their own resources; nothing to tear down here.
    client = null;
    readOnlyClient = null;
    iotaClient = null;
}

module.exports = {
    isEnabled,
    initLedger,
    getAllDevices,
    getDevice,
    registerDevice,
    toggleDeviceStatus,
    revokeDevice,
    close,
};