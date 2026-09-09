'use strict';

// IOTA Tangle ledger adapter backed by the IOTA Notarization toolkit
// (Dynamic Notarization: one updatable on-chain object per device).
//
// Mirrors the fabric-client.js interface so the gateway can switch
// between Fabric and IOTA transparently:
//   isEnabled, initLedger, getAllDevices, getDevice,
//   registerDevice, toggleDeviceStatus, revokeDevice, activateDevice,
//   updateDevicePublicKey, deleteDevice, close

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
const MAX_OBJECTS_PER_READ = 50;

let iotaClient = null;
let readOnlyClient = null;
let client = null;
let registry = loadRegistry();
let notarizationIdsByDevice = new Map(
    Object.entries(registry).map(([deviceId, notarizationId]) => [deviceId, [notarizationId]])
);

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
    if (!fs.existsSync(registryPath)) return {};
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object'
        || Object.values(parsed).some(id => typeof id !== 'string')) {
        throw new Error(`Invalid IOTA registry file: ${registryPath}`);
    }
    return parsed;
}

function saveRegistry() {
    const tempPath = `${registryPath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(registry, null, 2), { mode: 0o600 });
    fs.renameSync(tempPath, registryPath);
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
    try {
        await ensureFunded(client.senderAddress());
        await reconcileRegistry();
    } catch (err) {
        close();
        throw err;
    }
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

function objectToDevice(object) {
    const content = object && object.data && object.data.content;
    const fields = content && content.fields;
    const data = fields && fields.state && fields.state.fields && fields.state.fields.data;
    if (!data) throw new Error(`IOTA notarization ${object && object.data ? object.data.objectId : 'unknown'} has no device state`);
    return {
        device: stateToDevice({ data: Buffer.from(data) }),
        id: object.data.objectId,
        version: BigInt(fields.state_version_count || 0),
    };
}

async function reconcileRegistry() {
    const recovered = new Map();
    const recoveredIds = new Map();
    let cursor = null;
    do {
        const page = await iotaClient.getOwnedObjects({
            owner: client.senderAddress(),
            cursor,
            options: { showType: true, showContent: true },
        });
        for (const object of page.data || []) {
            const type = object.data && object.data.type;
            if (!type || !type.startsWith(`${pkgId}::notarization::Notarization<`)) continue;
            const candidate = objectToDevice(object);
            const ids = recoveredIds.get(candidate.device.id) || [];
            ids.push(candidate.id);
            recoveredIds.set(candidate.device.id, ids);
            const existing = recovered.get(candidate.device.id);
            const preferredId = registry[candidate.device.id];
            if (!existing || candidate.version > existing.version
                || (candidate.version === existing.version && candidate.id === preferredId)
                || (candidate.version === existing.version && existing.id !== preferredId && candidate.id < existing.id)) {
                recovered.set(candidate.device.id, candidate);
            }
        }
        cursor = page.hasNextPage ? page.nextCursor : null;
    } while (cursor);

    const nextRegistry = Object.fromEntries(
        Array.from(recovered.entries())
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([deviceId, value]) => [deviceId, value.id])
    );
    notarizationIdsByDevice = recoveredIds;
    if (JSON.stringify(nextRegistry) !== JSON.stringify(registry)) {
        registry = nextRegistry;
        saveRegistry();
        console.log(`   ♻️ [IOTA] Reconciled ${Object.keys(registry).length} device mapping(s) from the Tangle`);
    }
}

async function writeState(device) {
    const c = await connect();
    const notarizationId = registry[device.id];
    if (!notarizationId) {
        throw new Error(`Device ${device.id} is not registered on the Tangle`);
    }
    const state = State.fromString(deviceToState(device), new Date().toISOString());
    await c.updateState(state, notarizationId).buildAndExecute(c);
}

// ------------------------------------------------------------------
// Public interface (mirrors fabric-client.js)
// ------------------------------------------------------------------

async function initLedger(seedDevices) {
    await connect();
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
    const entries = Object.entries(registry);
    for (let offset = 0; offset < entries.length; offset += MAX_OBJECTS_PER_READ) {
        const batch = entries.slice(offset, offset + MAX_OBJECTS_PER_READ);
        const objects = await iotaClient.multiGetObjects({
            ids: batch.map(([, notarizationId]) => notarizationId),
            options: { showContent: true },
        });
        for (let index = 0; index < batch.length; index++) {
            const [deviceId] = batch[index];
            try {
                results.push(objectToDevice(objects[index]).device);
            } catch (err) {
                console.error(`   ⚠️ [IOTA] getDevice(${deviceId}) failed: ${err.message}`);
            }
        }
    }
    return results;
}

async function checkHealth() {
    await connect();
    await iotaClient.getLatestCheckpointSequenceNumber();
    return true;
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
    return objectToDevice(obj).device;
}

async function registerDevice(id, publicKey) {
    const c = await connect();
    if (registry[id]) {
        throw new Error(`Device ${id} already exists on the Tangle`);
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
    notarizationIdsByDevice.set(id, [output.id]);
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

async function activateDevice(id) {
    const device = await getDevice(id);
    if (!device) return null;
    if (device.status !== 'ACTIVE') {
        device.status = 'ACTIVE';
        await writeState(device);
    }
    return getDevice(id);
}

async function updateDevicePublicKey(id, publicKey) {
    const device = await getDevice(id);
    if (!device) return null;
    device.publicKey = publicKey;
    device.key = publicKey;
    await writeState(device);
    return getDevice(id);
}

async function deleteDevice(id) {
    const c = await connect();
    const notarizationIds = notarizationIdsByDevice.get(id) || (registry[id] ? [registry[id]] : []);
    if (notarizationIds.length === 0) return false;
    for (const notarizationId of new Set(notarizationIds)) {
        await c.destroy(notarizationId).buildAndExecute(c);
    }
    delete registry[id];
    notarizationIdsByDevice.delete(id);
    saveRegistry();
    return true;
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
    checkHealth,
    getDevice,
    registerDevice,
    toggleDeviceStatus,
    revokeDevice,
    activateDevice,
    updateDevicePublicKey,
    deleteDevice,
    close,
};
