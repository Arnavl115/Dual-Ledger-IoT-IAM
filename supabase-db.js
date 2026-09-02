'use strict';

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const isConfigured = Boolean(supabaseUrl && supabaseKey && !supabaseUrl.includes('YOUR_PROJECT_REF'));

const supabase = isConfigured
    ? createClient(supabaseUrl, supabaseKey, {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
        },
    })
    : null;

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
        });
    if (error) throw error;
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

module.exports = {
    isConfigured,
    getAllDevices,
    getDevice,
    insertDevice,
    updateDeviceStatus,
    updateDevicePublicKey,
    deleteDevice,
    seedDevices,
    insertAccessLog,
};
