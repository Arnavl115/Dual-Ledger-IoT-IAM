/*
 * IoT Device Identity Registry Contract
 * SPDX-License-Identifier: Apache-2.0
 *
 * Manages device metadata on the Fabric ledger:
 *   - ID          : unique device identifier (e.g. SmartLock_FrontDoor)
 *   - PublicKey   : device public key (hex, 0x-prefixed)
 *   - Status      : ACTIVE | REVOKED
 */

'use strict';

const { Contract } = require('fabric-contract-api');

// Deterministic JSON.stringify() so world-state hashes are stable across peers
const stringify = require('json-stringify-deterministic');
const sortKeysRecursive = require('sort-keys-recursive');

const ACTIVE_STATUS = 'ACTIVE';
const REVOKED_STATUS = 'REVOKED';
const VALID_STATUSES = [ACTIVE_STATUS, REVOKED_STATUS];

class DeviceRegistry extends Contract {

    // Seed the ledger with the devices currently bootstrapped by the mock gateway.
    async InitLedger(ctx) {
        const devices = [
            { ID: 'SmartLock_FrontDoor', PublicKey: '0x4F...9A1B', Status: ACTIVE_STATUS },
            { ID: 'ServerRack_A', PublicKey: '0x8C...3E4F', Status: ACTIVE_STATUS },
            { ID: 'BioLab_Fridge', PublicKey: '0x12...77CD', Status: ACTIVE_STATUS },
        ];

        for (const device of devices) {
            const asset = {
                ID: device.ID,
                PublicKey: device.PublicKey,
                Status: device.Status,
                RegisteredAt: new Date().toISOString(),
                UpdatedAt: new Date().toISOString(),
            };
            await ctx.stub.putState(device.ID, Buffer.from(stringify(sortKeysRecursive(asset))));
            console.info(`Seeded device ${device.ID}`);
        }
    }

    // RegisterDevice enrolls a new device as ACTIVE.
    async RegisterDevice(ctx, id, publicKey) {
        const exists = await this.DeviceExists(ctx, id);
        if (exists) {
            throw new Error(`Device ${id} already exists`);
        }
        if (!publicKey) {
            throw new Error('A public key is required to register a device');
        }

        const device = {
            ID: id,
            PublicKey: publicKey,
            Status: ACTIVE_STATUS,
            RegisteredAt: new Date().toISOString(),
            UpdatedAt: new Date().toISOString(),
        };
        await ctx.stub.putState(id, Buffer.from(stringify(sortKeysRecursive(device))));
        return JSON.stringify(device);
    }

    // ReadDevice returns the device record stored in the world state.
    async ReadDevice(ctx, id) {
        const deviceJSON = await ctx.stub.getState(id);
        if (!deviceJSON || deviceJSON.length === 0) {
            throw new Error(`Device ${id} does not exist`);
        }
        return deviceJSON.toString();
    }

    // UpdateDevicePublicKey replaces the public key of an existing device.
    async UpdateDevicePublicKey(ctx, id, publicKey) {
        const device = await this._getDevice(ctx, id);
        if (!publicKey) {
            throw new Error('A public key is required to update a device');
        }
        device.PublicKey = publicKey;
        device.UpdatedAt = new Date().toISOString();
        await ctx.stub.putState(id, Buffer.from(stringify(sortKeysRecursive(device))));
        return JSON.stringify(device);
    }

    // SetDeviceStatus explicitly sets the device status (ACTIVE or REVOKED).
    async SetDeviceStatus(ctx, id, status) {
        const device = await this._getDevice(ctx, id);
        if (!VALID_STATUSES.includes(status)) {
            throw new Error(`Invalid status ${status}; expected ${VALID_STATUSES.join(' or ')}`);
        }
        device.Status = status;
        device.UpdatedAt = new Date().toISOString();
        await ctx.stub.putState(id, Buffer.from(stringify(sortKeysRecursive(device))));
        return JSON.stringify(device);
    }

    // RevokeDevice marks a device as REVOKED (convenience wrapper).
    async RevokeDevice(ctx, id) {
        return this.SetDeviceStatus(ctx, id, REVOKED_STATUS);
    }

    // ActivateDevice marks a device as ACTIVE (convenience wrapper).
    async ActivateDevice(ctx, id) {
        return this.SetDeviceStatus(ctx, id, ACTIVE_STATUS);
    }

    // ToggleDeviceStatus flips ACTIVE <-> REVOKED (mirrors the gateway toggle endpoint).
    async ToggleDeviceStatus(ctx, id) {
        const device = await this._getDevice(ctx, id);
        device.Status = device.Status === ACTIVE_STATUS ? REVOKED_STATUS : ACTIVE_STATUS;
        device.UpdatedAt = new Date().toISOString();
        await ctx.stub.putState(id, Buffer.from(stringify(sortKeysRecursive(device))));
        return JSON.stringify(device);
    }

    // DeleteDevice removes a device record from the world state.
    async DeleteDevice(ctx, id) {
        const exists = await this.DeviceExists(ctx, id);
        if (!exists) {
            throw new Error(`Device ${id} does not exist`);
        }
        await ctx.stub.deleteState(id);
    }

    // DeviceExists returns true when a device with the given ID is in the world state.
    async DeviceExists(ctx, id) {
        const deviceJSON = await ctx.stub.getState(id);
        return deviceJSON && deviceJSON.length > 0;
    }

    // GetAllDevices returns every device stored in the chaincode namespace.
    async GetAllDevices(ctx) {
        const allResults = [];
        const iterator = await ctx.stub.getStateByRange('', '');
        let result = await iterator.next();
        while (!result.done) {
            const strValue = Buffer.from(result.value.value.toString()).toString('utf8');
            let record;
            try {
                record = JSON.parse(strValue);
            } catch (err) {
                console.log(err);
                record = strValue;
            }
            allResults.push(record);
            result = await iterator.next();
        }
        return JSON.stringify(allResults);
    }

    // _getDevice loads and parses a device or throws if it does not exist.
    async _getDevice(ctx, id) {
        const deviceJSON = await ctx.stub.getState(id);
        if (!deviceJSON || deviceJSON.length === 0) {
            throw new Error(`Device ${id} does not exist`);
        }
        return JSON.parse(deviceJSON.toString());
    }
}

module.exports = DeviceRegistry;
