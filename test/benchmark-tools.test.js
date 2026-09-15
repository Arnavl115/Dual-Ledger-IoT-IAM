'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { accessPayload, parseBytes } = require('../scripts/benchmark');
const { quantile, summarize } = require('../scripts/analyze-benchmarks');

test('benchmark access payloads contain valid P-256 signatures', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const payload = accessPayload('bench-device', privateKey, 7);
    const message = `${payload.device_id}:${payload.action}:${payload.timestamp}`;

    assert.equal(payload.action, 'benchmark:7');
    assert.equal(crypto.verify('sha256', Buffer.from(message), publicKey, Buffer.from(payload.signature, 'base64')), true);
});

test('resource units and interpolated quantiles are normalized', () => {
    assert.equal(parseBytes('1.5 GiB'), 1.5 * 1024 ** 3);
    assert.equal(parseBytes('250MiB'), 250 * 1024 ** 2);
    assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
});

test('summary calculates publication statistics', () => {
    assert.deepEqual(summarize([1, 2, 3]), {
        n: 3,
        mean: 2,
        median: 2,
        p95: 2.9,
        p99: 2.98,
        min: 1,
        max: 3,
        stddev: Math.sqrt(2 / 3),
    });
});
