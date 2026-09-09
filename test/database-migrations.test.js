'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { parseRetentionDays, purgeExpiredAccessLogs } = require('../supabase-db');

const root = path.join(__dirname, '..');
const migrationsDirectory = path.join(root, 'supabase', 'migrations');

test('access-log retention configuration is bounded and can be disabled', () => {
    assert.equal(parseRetentionDays(undefined), 90);
    assert.equal(parseRetentionDays('0'), 0);
    assert.equal(parseRetentionDays('365'), 365);
    assert.throws(() => parseRetentionDays('-1'), /integer between 0 and 36500/);
    assert.throws(() => parseRetentionDays('1.5'), /integer between 0 and 36500/);
    assert.throws(() => parseRetentionDays('forever'), /integer between 0 and 36500/);
});

test('retention cleanup deletes rows older than the configured cutoff', async () => {
    const calls = [];
    const client = {
        from(table) {
            calls.push(['from', table]);
            return {
                delete() {
                    calls.push(['delete']);
                    return {
                        async lt(column, value) {
                            calls.push(['lt', column, value]);
                            return { error: null };
                        },
                    };
                },
            };
        },
    };

    await purgeExpiredAccessLogs(Date.parse('2026-09-09T12:00:00.000Z'), client, 90);

    assert.deepEqual(calls, [
        ['from', 'access_logs'],
        ['delete'],
        ['lt', 'created_at', '2026-06-11T12:00:00.000Z'],
    ]);
});

test('versioned migrations enforce audit domains, required fields, timestamps, and indexes', () => {
    const migrationNames = fs.readdirSync(migrationsDirectory).filter(name => name.endsWith('.sql')).sort();
    assert.deepEqual(migrationNames, [
        '202609090001_initial_schema.sql',
        '202609090002_harden_existing_schema.sql',
        '202609090003_access_log_device_index.sql',
        '202609090004_access_log_status_index.sql',
    ]);

    const sql = migrationNames
        .map(name => fs.readFileSync(path.join(migrationsDirectory, name), 'utf8'))
        .join('\n');

    assert.match(sql, /status in \('ACTIVE', 'REVOKED'\)/);
    assert.match(sql, /status in \('GRANTED', 'DENIED', 'REVOKED', 'REGISTERED'\)/);
    assert.match(sql, /route in \('FABRIC', 'IOTA', 'POSTGRES', 'MEMORY', 'GATEWAY', 'FABRIC\+IOTA'\)/);
    for (const column of ['device_id', 'endpoint', 'status', 'route', 'hash', 'created_at']) {
        assert.match(sql, new RegExp(`alter column ${column} set not null`));
    }
    assert.match(sql, /devices_set_updated_at/);
    assert.match(sql, /devices_timestamps_check/);
    assert.match(sql, /access_logs_required_fields_check/);
    assert.match(sql, /access_logs_timestamp_check/);
    assert.match(sql, /access_logs_device_created_at_idx/);
    assert.match(sql, /access_logs_status_created_at_idx/);
});
