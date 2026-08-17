/*
 * IoT Device Identity Registry Contract
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const deviceRegistry = require('./lib/deviceRegistry');

module.exports.DeviceRegistry = deviceRegistry;
module.exports.contracts = [deviceRegistry];
