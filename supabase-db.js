'use strict';

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RETENTION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function parseRetentionDays(value) {
    if (value === undefined || value === '') return 90;
    const days = Number(value);
    if (!Number.isInteger(days) || days < 0 || days > 36500) {
        throw new Error('ACCESS_LOG_RETENTION_DAYS must be an integer between 0 and 36500');
    }
    return days;
}

const accessLogRetentionDays = parseRetentionDays(process.env.ACCESS_LOG_RETENTION_DAYS);

const isConfigured = Boolean(supabaseUrl && supabaseKey && !supabaseUrl.includes('YOUR_PROJECT_REF'));

const supabase = isConfigured
    ? createClient(supabaseUrl, supabaseKey, {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
        },
    })
    : null;

let nextRetentionCleanupAt = 0;
let retentionCleanupPromise = null;

// -------------------------------
// Devices table
// -------------------------------

async function getAllDevices() {
    const { data, error } = await supabase
        .from('devices')
        .select('id, public_key, status, created_at')
        .order('created_at', { ascending: true });
    if (error) throw error;
    return data.map(mapDeviceRow);
}

async function getDevice(id) {
    const { data, error } = await supabase
        .from('devices')
        .select('id, public_key, status, created_at')
        .eq('id', id)
        .maybeSingle();
    if (error) throw error;
    return data ? mapDeviceRow(data) : null;
}

async function insertDevice(id, publicKey, status = 'ACTIVE') {
    const { error } = await supabase
        .from('devices')
        .insert({ id, public_key: publicKey, status });
    if (error) throw error;
}

async function upsertDevice(id, publicKey, status) {
    const { error } = await supabase
        .from('devices')
        .upsert({ id, public_key: publicKey, status }, { onConflict: 'id' });
    if (error) throw error;
}

async function updateDeviceStatus(id, status) {
    const { error } = await supabase
        .from('devices')
        .update({ status })
        .eq('id', id);
    if (error) throw error;
}

async function updateDevicePublicKey(id, publicKey) {
    const { error } = await supabase
        .from('devices')
        .update({ public_key: publicKey })
        .eq('id', id);
    if (error) throw error;
}

async function deleteDevice(id) {
    const { error } = await supabase
        .from('devices')
        .delete()
        .eq('id', id);
    if (error) throw error;
}

async function seedDevices(seedRows) {
    // Production: only seed if explicitly requested and rows are real PEMs (no fake 0x...).
    if (!seedRows || seedRows.length === 0) return;
    for (const row of seedRows) {
        if (!row.id || (!row.public_key && !row.key)) continue;
        const pem = row.public_key || row.key;
        if (typeof pem === 'string' && pem.startsWith('0x') && pem.includes('...')) continue; // skip fake demo keys
        const existing = await getDevice(row.id);
        if (!existing) {
            await insertDevice(row.id, pem, row.status);
        }
    }
}

// -------------------------------
// Access logs table
// -------------------------------

async function insertAccessLog(logEntry) {
    const { error } = await supabase
        .from('access_logs')
        .insert({
            request_id: logEntry.id,
            device_id: logEntry.deviceId,
            endpoint: logEntry.endpoint,
            status: logEntry.status,
            route: logEntry.route,
            hash: logEntry.hash,
            created_at: logEntry.createdAt || new Date().toISOString(),
    });
    if (error) throw error;
    void maybeCleanupExpiredAccessLogs();
}

async function getAccessLogs({ limit = 100, offset = 0 } = {}) {
    const { data, error, count } = await supabase
        .from('access_logs')
        .select('request_id, device_id, endpoint, status, route, hash, created_at', { count: 'exact' })
        .order('created_at', { ascending: false })
        .order('request_id', { ascending: false })
        .range(offset, offset + limit - 1);
    if (error) throw error;
    return {
        logs: (data || []).map(mapAccessLogRow),
        total: count || 0,
    };
}

async function claimAccessLog(logEntry) {
    try {
        await insertAccessLog(logEntry);
        return true;
    } catch (err) {
        if (err.code === '23505' || String(err.message).includes('duplicate key')) {
            return false;
        }
        throw err;
    }
}

async function purgeExpiredAccessLogs(now = Date.now(), client = supabase, retentionDays = accessLogRetentionDays) {
    if (retentionDays === 0) return;
    const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await client
        .from('access_logs')
        .delete()
        .lt('created_at', cutoff);
    if (error) throw error;
}

async function maybeCleanupExpiredAccessLogs(now = Date.now()) {
    if (accessLogRetentionDays === 0 || now < nextRetentionCleanupAt) return;
    if (retentionCleanupPromise) return retentionCleanupPromise;

    retentionCleanupPromise = purgeExpiredAccessLogs(now)
        .catch(error => {
            console.error(`   [AUDIT] Retention cleanup failed: ${error.message}`);
        })
        .finally(() => {
            nextRetentionCleanupAt = Date.now() + RETENTION_CLEANUP_INTERVAL_MS;
            retentionCleanupPromise = null;
        });
    return retentionCleanupPromise;
}

// -------------------------------
// Helpers
// -------------------------------

function mapDeviceRow(row) {
    return {
        id: row.id,
        key: row.public_key,
        publicKey: row.public_key,
        status: row.status,
    };
}

function mapAccessLogRow(row) {
    return {
        id: row.request_id,
        deviceId: row.device_id,
        endpoint: row.endpoint,
        status: row.status,
        route: row.route,
        hash: row.hash,
        createdAt: row.created_at,
    };
}

module.exports = {
    isConfigured,
    accessLogRetentionDays,
    parseRetentionDays,
    getAllDevices,
    getDevice,
    insertDevice,
    upsertDevice,
    updateDeviceStatus,
    updateDevicePublicKey,
    deleteDevice,
    seedDevices,
    insertAccessLog,
    getAccessLogs,
    claimAccessLog,
    purgeExpiredAccessLogs,
};
