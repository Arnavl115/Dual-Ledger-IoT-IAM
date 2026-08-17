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

async function seedDevices(seedRows) {
    // Insert seed devices that don't already exist.
    for (const row of seedRows) {
        const existing = await getDevice(row.id);
        if (!existing) {
            await insertDevice(row.id, row.public_key || row.key, row.status);
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
        status: row.status,
    };
}

module.exports = {
    isConfigured,
    getAllDevices,
    getDevice,
    insertDevice,
    updateDeviceStatus,
    seedDevices,
    insertAccessLog,
};
