'use strict';

const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const utf8Decoder = new TextDecoder();

const channelName = process.env.CHANNEL_NAME || 'mychannel';
const chaincodeName = process.env.CHAINCODE_NAME || 'deviceregistry';
const mspId = process.env.MSP_ID || 'Org1MSP';

const cryptoPath = process.env.CRYPTO_PATH || path.resolve(
    __dirname,
    'fabric-samples',
    'test-network',
    'organizations',
    'peerOrganizations',
    'org1.example.com'
);

const keyDirectoryPath = process.env.KEY_DIRECTORY_PATH || path.resolve(
    cryptoPath,
    'users',
    'User1@org1.example.com',
    'msp',
    'keystore'
);

const certDirectoryPath = process.env.CERT_DIRECTORY_PATH || path.resolve(
    cryptoPath,
    'users',
    'User1@org1.example.com',
    'msp',
    'signcerts'
);

const tlsCertPath = process.env.TLS_CERT_PATH || path.resolve(
    cryptoPath,
    'peers',
    'peer0.org1.example.com',
    'tls',
    'ca.crt'
);

const peerEndpoint = process.env.PEER_ENDPOINT || 'localhost:7051';
const peerHostAlias = process.env.PEER_HOST_ALIAS || 'peer0.org1.example.com';

let client = null;
let gateway = null;
let contract = null;

function isEnabled() {
    return process.env.FABRIC_ENABLED === 'true';
}

async function connectGateway() {
    if (contract) {
        return contract;
    }

    const tlsRootCert = await fs.readFile(tlsCertPath);
    const tlsCredentials = grpc.credentials.createSsl(tlsRootCert);
    client = new grpc.Client(peerEndpoint, tlsCredentials, {
        'grpc.ssl_target_name_override': peerHostAlias,
    });

    gateway = connect({
        client,
        identity: await newIdentity(),
        signer: await newSigner(),
        hash: hashSHA256,
        evaluateOptions: () => ({ deadline: Date.now() + 5000 }),
        endorseOptions: () => ({ deadline: Date.now() + 15000 }),
        submitOptions: () => ({ deadline: Date.now() + 5000 }),
        commitStatusOptions: () => ({ deadline: Date.now() + 60000 }),
    });

    const network = gateway.getNetwork(channelName);
    contract = network.getContract(chaincodeName);
    return contract;
}

function hashSHA256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest();
}

async function newIdentity() {
    const certPath = await getFirstDirFileName(certDirectoryPath);
    const credentials = await fs.readFile(certPath);
    return { mspId, credentials };
}

async function newSigner() {
    const keyPath = await getFirstDirFileName(keyDirectoryPath);
    const privateKeyPem = await fs.readFile(keyPath);
    const privateKey = crypto.createPrivateKey(privateKeyPem);
    return signers.newPrivateKeySigner(privateKey);
}

async function getFirstDirFileName(dirPath) {
    const files = await fs.readdir(dirPath);
    const file = files[0];
    if (!file) {
        throw new Error(`No files in directory: ${dirPath}`);
    }
    return path.join(dirPath, file);
}

async function initLedger() {
    const c = await connectGateway();
    await c.submitTransaction('InitLedger');
    return true;
}

async function getAllDevices() {
    const c = await connectGateway();
    const resultBytes = await c.evaluateTransaction('GetAllDevices');
    const records = JSON.parse(utf8Decoder.decode(resultBytes));
    return records.map(toGatewayDevice);
}

async function getDevice(id) {
    const c = await connectGateway();
    try {
        const resultBytes = await c.evaluateTransaction('ReadDevice', id);
        const record = JSON.parse(utf8Decoder.decode(resultBytes));
        return toGatewayDevice(record);
    } catch (err) {
        if (isChaincodeError(err)) {
            return null;
        }
        throw err;
    }
}

async function registerDevice(id, publicKey) {
    const c = await connectGateway();
    await c.submitTransaction('RegisterDevice', id, publicKey);
    return getDevice(id);
}

async function toggleDeviceStatus(id) {
    const c = await connectGateway();
    const resultBytes = await c.submitTransaction('ToggleDeviceStatus', id);
    const record = JSON.parse(utf8Decoder.decode(resultBytes));
    return toGatewayDevice(record);
}

async function revokeDevice(id) {
    const c = await connectGateway();
    const resultBytes = await c.submitTransaction('RevokeDevice', id);
    const record = JSON.parse(utf8Decoder.decode(resultBytes));
    return toGatewayDevice(record);
}

function toGatewayDevice(record) {
    return {
        id: record.ID,
        key: record.PublicKey,
        status: record.Status,
    };
}

function isChaincodeError(err) {
    const message = String(err && err.message ? err.message : err);
    return message.includes('does not exist');
}

function close() {
    if (gateway) {
        gateway.close();
        gateway = null;
    }
    if (client) {
        client.close();
        client = null;
    }
    contract = null;
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
