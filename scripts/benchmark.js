'use strict';

require('dotenv').config({ quiet: true, override: true });

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exec } = require('node:child_process');
const { promisify } = require('node:util');

const execAsync = promisify(exec);

function parseArgs(argv) {
    const args = {};
    for (let index = 2; index < argv.length; index++) {
        const argument = argv[index];
        if (!argument.startsWith('--')) continue;
        const [name, inlineValue] = argument.slice(2).split('=', 2);
        if (inlineValue !== undefined) args[name] = inlineValue;
        else if (argv[index + 1] && !argv[index + 1].startsWith('--')) args[name] = argv[++index];
        else args[name] = true;
    }
    return args;
}

function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function numberOption(value, fallback, name, minimum = 0) {
    const parsed = value === undefined ? fallback : Number(value);
    if (!Number.isFinite(parsed) || parsed < minimum) throw new Error(`${name} must be at least ${minimum}`);
    return parsed;
}

function percentile(sorted, fraction) {
    if (!sorted.length) return null;
    return sorted[Math.min(Math.ceil(sorted.length * fraction) - 1, sorted.length - 1)];
}

function createWriter(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const stream = fs.createWriteStream(filePath, { flags: 'a' });
    return {
        write(record) { stream.write(`${JSON.stringify(record)}\n`); },
        close() { return new Promise((resolve, reject) => stream.end(error => error ? reject(error) : resolve())); },
    };
}

function machineMetadata(config) {
    const cpus = os.cpus();
    return {
        capturedAt: new Date().toISOString(),
        hostname: os.hostname(),
        platform: `${os.platform()} ${os.release()} ${os.arch()}`,
        cpuModel: cpus[0]?.model || 'unknown',
        logicalCpuCount: cpus.length,
        memoryBytes: os.totalmem(),
        nodeVersion: process.version,
        network: config.network || null,
        notes: config.machineNotes || null,
    };
}

async function request(baseUrl, pathname, { method = 'GET', token, body, timeoutMs = 30000 } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const started = process.hrtime.bigint();
    try {
        const options = {
            method,
            headers: {
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
                ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            signal: controller.signal,
        };
        if (body !== undefined) options.body = JSON.stringify(body);
        const response = await fetch(new URL(pathname, baseUrl), options);
        const responseBody = await response.json().catch(() => ({}));
        return {
            statusCode: response.status,
            ok: response.ok,
            body: responseBody,
            latencyMs: Number(process.hrtime.bigint() - started) / 1e6,
        };
    } catch (error) {
        return {
            statusCode: 0,
            ok: false,
            body: { error: error.message },
            latencyMs: Number(process.hrtime.bigint() - started) / 1e6,
        };
    } finally {
        clearTimeout(timeout);
    }
}

function generateKeyPair() {
    return crypto.generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
}

function accessPayload(deviceId, privateKey, sequence) {
    const timestamp = Date.now() / 1000;
    const action = `benchmark:${sequence}`;
    const message = `${deviceId}:${action}:${timestamp}`;
    return {
        device_id: deviceId,
        action,
        timestamp,
        signature: crypto.sign('sha256', Buffer.from(message), privateKey).toString('base64'),
    };
}

async function requireOk(result, operation) {
    if (!result.ok) throw new Error(`${operation} returned HTTP ${result.statusCode}: ${result.body.error || result.body.message || 'unknown error'}`);
    return result;
}

async function selectBackend(config, token) {
    if (config.backend === 'SYNCHRONIZED') {
        const health = await requireOk(await request(config.baseUrl, '/health'), 'health check');
        const routes = Array.isArray(health.body.enabledRoutes) ? health.body.enabledRoutes : [];
        if (!routes.includes('FABRIC') || !routes.includes('IOTA') || health.body.dbMode !== 'POSTGRES') {
            throw new Error('SYNCHRONIZED profile requires Fabric, IOTA, and PostgreSQL to be enabled');
        }
        return;
    }
    if (config.backend === 'FABRIC' || config.backend === 'IOTA') {
        await requireOk(await request(config.baseUrl, '/api/route', {
            method: 'POST', token, body: { route: config.backend },
        }), `select ${config.backend}`);
    }
    const health = await requireOk(await request(config.baseUrl, '/health'), 'health check');
    const actual = health.body.activeRoute || health.body.activeBackend;
    if (config.backend === 'POSTGRES' && (health.body.dbMode !== 'POSTGRES' || actual !== 'POSTGRES')) {
        throw new Error('POSTGRES profile requires PostgreSQL to be configured and active with Fabric and IOTA disabled');
    }
    if (config.backend !== 'POSTGRES' && actual !== config.backend) {
        throw new Error(`Expected backend ${config.backend}, gateway reports ${actual}`);
    }
}

async function registerDevice(config, token, id, publicKey) {
    return requireOk(await request(config.baseUrl, '/api/devices/register', {
        method: 'POST', token, body: { id, publicKey, simulatorManaged: false }, timeoutMs: config.requestTimeoutMs,
    }), `register ${id}`);
}

async function deleteDevice(config, token, id) {
    return request(config.baseUrl, `/api/devices/${encodeURIComponent(id)}`, {
        method: 'DELETE', token, timeoutMs: config.requestTimeoutMs,
    });
}

async function sampleProcess(pid, previous) {
    if (!pid) return null;
    if (process.platform === 'win32') {
        const command = `powershell -NoProfile -Command "$p=Get-Process -Id ${Number(pid)} -ErrorAction Stop; [Console]::WriteLine(('{0},{1}' -f $p.CPU,$p.WorkingSet64))"`;
        const { stdout } = await execAsync(command, { windowsHide: true });
        const [cpuSeconds, memoryBytes] = stdout.trim().split(',').map(Number);
        const now = Date.now();
        const cpuPercent = previous ? ((cpuSeconds - previous.cpuSeconds) * 100000) / (now - previous.at) : null;
        return { cpuSeconds, memoryBytes, cpuPercent, at: now };
    }
    const { stdout } = await execAsync(`ps -p ${Number(pid)} -o %cpu=,rss=`);
    const [cpuPercent, rssKb] = stdout.trim().split(/\s+/).map(Number);
    return { cpuPercent, memoryBytes: rssKb * 1024, at: Date.now() };
}

async function sampleContainers(names) {
    if (!names.length) return [];
    const quoted = names.map(name => `"${String(name).replaceAll('"', '')}"`).join(' ');
    const { stdout } = await execAsync(`docker stats --no-stream --format "{{json .}}" ${quoted}`);
    return stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function parsePercent(value) {
    const parsed = Number.parseFloat(String(value || '').replace('%', ''));
    return Number.isFinite(parsed) ? parsed : null;
}

function parseBytes(value) {
    const match = String(value || '').trim().match(/^([\d.]+)\s*([kmgt]?i?b)$/i);
    if (!match) return null;
    const units = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
    return Number(match[1]) * units[match[2].toLowerCase()];
}

function startResourceSampler(config, writer, runId) {
    let stopped = false;
    let previousProcessSample = null;
    const task = (async () => {
        while (!stopped) {
            const capturedAt = new Date().toISOString();
            try {
                previousProcessSample = await sampleProcess(config.gatewayPid, previousProcessSample);
                if (previousProcessSample) writer.write({ kind: 'measurement', experiment: 'resource', runId, backend: config.backend, target: 'gateway-process', capturedAt, cpuPercent: previousProcessSample.cpuPercent, memoryBytes: previousProcessSample.memoryBytes });
            } catch (error) {
                writer.write({ kind: 'measurement', experiment: 'resource', runId, backend: config.backend, target: 'gateway-process', capturedAt, error: error.message });
            }
            try {
                for (const container of await sampleContainers(config.containers)) {
                    const memoryUsage = String(container.MemUsage || '').split('/')[0];
                    writer.write({ kind: 'measurement', experiment: 'resource', runId, backend: config.backend, target: `container:${container.Name || container.Container}`, capturedAt, cpuPercent: parsePercent(container.CPUPerc), memoryBytes: parseBytes(memoryUsage) });
                }
            } catch (error) {
                writer.write({ kind: 'measurement', experiment: 'resource', runId, backend: config.backend, target: 'containers', capturedAt, error: error.message });
            }
            await sleep(config.resourceIntervalMs);
        }
    })();
    return async () => { stopped = true; await task; };
}

async function runAccess(config, token, writer, label = 'authorization') {
    const runId = crypto.randomUUID();
    const id = `bench-access-${crypto.randomUUID().slice(0, 8)}`;
    const keys = generateKeyPair();
    await registerDevice(config, token, id, keys.publicKey);
    const stopResources = startResourceSampler(config, writer, runId);
    let sequence = 0;
    const issue = async (record, phase) => {
        const result = await request(config.baseUrl, '/api/access', {
            method: 'POST', body: accessPayload(id, keys.privateKey, sequence++), timeoutMs: config.requestTimeoutMs,
        });
        const timings = result.body.accessTimingMs || {};
        if (record) writer.write({
            kind: 'measurement', experiment: label, runId, backend: config.backend, phase, concurrency: config.concurrency,
            completedAt: new Date().toISOString(), latencyMs: result.latencyMs,
            ledgerLookupMs: Number.isFinite(timings.ledgerLookup) ? timings.ledgerLookup : null,
            replayAuditPersistenceMs: Number.isFinite(timings.replayAuditPersistence) ? timings.replayAuditPersistence : null,
            gatewayTotalMs: Number.isFinite(timings.gatewayTotal) ? timings.gatewayTotal : null,
            statusCode: result.statusCode, success: result.ok,
        });
        return result;
    };
    const runWorkers = async (seconds, record, phase) => {
        const startedAt = Date.now();
        const deadline = startedAt + seconds * 1000;
        let requests = 0;
        let successes = 0;
        await Promise.all(Array.from({ length: config.concurrency }, async () => {
            while (Date.now() < deadline) {
                const result = await issue(record, phase);
                requests++;
                if (result.ok) successes++;
            }
        }));
        return { elapsedMs: Date.now() - startedAt, requests, successes };
    };
    try {
        if (config.warmupSeconds) await runWorkers(config.warmupSeconds, false, 'warmup');
        writer.write({ kind: 'event', event: 'run_start', experiment: label, runId, backend: config.backend, concurrency: config.concurrency, at: new Date().toISOString() });
        const result = await runWorkers(config.durationSeconds, true, 'steady');
        writer.write({ kind: 'event', event: 'run_end', experiment: label, runId, backend: config.backend, concurrency: config.concurrency, at: new Date().toISOString(), ...result, throughputRps: result.successes / (result.elapsedMs / 1000) });
        return { id, keys, runId };
    } finally {
        await stopResources();
        const cleanup = await deleteDevice(config, token, id);
        if (!cleanup.ok) console.warn(`Cleanup of ${id} failed: HTTP ${cleanup.statusCode}`);
    }
}

async function runLifecycle(config, token, writer) {
    const runId = crypto.randomUUID();
    const stopResources = startResourceSampler(config, writer, runId);
    try {
        for (let iteration = 0; iteration < config.lifecycleIterations; iteration++) {
            const id = `bench-life-${crypto.randomUUID().slice(0, 8)}`;
            const initial = generateKeyPair();
            const rotated = generateKeyPair();
            const operations = [
                ['register', '/api/devices/register', 'POST', { id, publicKey: initial.publicKey, simulatorManaged: false }],
                ['revoke', '/api/devices/revoke', 'POST', { deviceId: id }],
                ['activate', '/api/devices/activate', 'POST', { deviceId: id }],
                ['rotate', '/api/devices/update-key', 'POST', { deviceId: id, publicKey: rotated.publicKey }],
                ['delete', `/api/devices/${encodeURIComponent(id)}`, 'DELETE', undefined],
            ];
            for (const [operation, pathname, method, body] of operations) {
                const result = await request(config.baseUrl, pathname, { method, body, token, timeoutMs: config.requestTimeoutMs });
                writer.write({ kind: 'measurement', experiment: 'lifecycle', runId, backend: config.backend, iteration, operation, completedAt: new Date().toISOString(), latencyMs: result.latencyMs, statusCode: result.statusCode, success: result.ok });
                if (!result.ok) {
                    await deleteDevice(config, token, id);
                    throw new Error(`${operation} failed for ${id}: HTTP ${result.statusCode}`);
                }
            }
        }
    } finally {
        await stopResources();
    }
}

async function runSynchronizedRegistration(config, token, writer) {
    const runId = crypto.randomUUID();
    const stopResources = startResourceSampler(config, writer, runId);
    const requiredStages = ['T_F', 'T_I', 'T_P', 'T_K', 'T_total'];
    try {
        for (let iteration = 0; iteration < config.lifecycleIterations; iteration++) {
            const id = `bench-sync-${crypto.randomUUID().slice(0, 8)}`;
            let registered = false;
            try {
                const result = await request(config.baseUrl, '/api/devices/register', {
                    method: 'POST', token, body: { id, simulatorManaged: true }, timeoutMs: config.requestTimeoutMs,
                });
                registered = result.ok;
                const timings = result.body.registrationTimingMs || {};
                for (const stage of requiredStages) {
                    if (Number.isFinite(timings[stage])) {
                        writer.write({ kind: 'measurement', experiment: 'synchronized_registration', runId, backend: 'SYNCHRONIZED', iteration, operation: stage, completedAt: new Date().toISOString(), latencyMs: timings[stage], statusCode: result.statusCode, success: result.ok });
                    } else if (result.ok) {
                        throw new Error(`Synchronized registration response is missing ${stage}`);
                    }
                }
                writer.write({ kind: 'measurement', experiment: 'synchronized_registration', runId, backend: 'SYNCHRONIZED', iteration, operation: 'endpoint', completedAt: new Date().toISOString(), latencyMs: result.latencyMs, statusCode: result.statusCode, success: result.ok });
                if (!result.ok) throw new Error(`synchronized registration failed for ${id}: HTTP ${result.statusCode}`);
            } finally {
                if (registered) {
                    const cleanup = await deleteDevice(config, token, id);
                    if (!cleanup.ok) console.warn(`Cleanup of ${id} failed: HTTP ${cleanup.statusCode}`);
                }
            }
        }
    } finally {
        await stopResources();
    }
}

async function runOutage(config, token, writer, allowOutage) {
    if (!allowOutage) throw new Error('Outage mode requires --allow-outage because it executes configured stop/start commands');
    if (!config.outage?.stopCommand || !config.outage?.startCommand) throw new Error('outage.stopCommand and outage.startCommand are required');
    const runId = crypto.randomUUID();
    const id = `bench-outage-${crypto.randomUUID().slice(0, 8)}`;
    const keys = generateKeyPair();
    await registerDevice(config, token, id, keys.publicKey);
    let sequence = 0;
    let dependencyStopped = false;
    const probe = async phase => {
        const result = await request(config.baseUrl, '/api/access', { method: 'POST', body: accessPayload(id, keys.privateKey, sequence++), timeoutMs: config.requestTimeoutMs });
        writer.write({ kind: 'measurement', experiment: 'outage', runId, backend: config.backend, target: config.outage.target || config.backend, phase, completedAt: new Date().toISOString(), latencyMs: result.latencyMs, statusCode: result.statusCode, success: result.ok });
        return result;
    };
    try {
        for (let count = 0; count < config.outage.baselineSamples; count++) { await probe('baseline'); await sleep(config.outage.probeIntervalMs); }
        writer.write({ kind: 'event', event: 'outage_started', experiment: 'outage', runId, backend: config.backend, at: new Date().toISOString() });
        await execAsync(config.outage.stopCommand, { timeout: config.outage.commandTimeoutMs });
        dependencyStopped = true;
        const outageDeadline = Date.now() + config.outage.outageSeconds * 1000;
        while (Date.now() < outageDeadline) { await probe('outage'); await sleep(config.outage.probeIntervalMs); }
        await execAsync(config.outage.startCommand, { timeout: config.outage.commandTimeoutMs });
        dependencyStopped = false;
        const recoveryStarted = Date.now();
        const recoveryDeadline = recoveryStarted + config.outage.recoveryTimeoutSeconds * 1000;
        let recovered = false;
        while (Date.now() < recoveryDeadline) {
            const result = await probe('recovery');
            if (result.ok) { recovered = true; break; }
            await sleep(config.outage.probeIntervalMs);
        }
        writer.write({ kind: 'event', event: 'outage_recovered', experiment: 'outage', runId, backend: config.backend, at: new Date().toISOString(), recovered, recoveryMs: Date.now() - recoveryStarted });
        if (!recovered) throw new Error('Backend did not recover before the configured timeout');
    } finally {
        if (dependencyStopped) {
            try { await execAsync(config.outage.startCommand, { timeout: config.outage.commandTimeoutMs }); }
            catch (error) { console.error(`Emergency dependency restart failed: ${error.message}`); }
        }
        await deleteDevice(config, token, id);
    }
}

async function main() {
    const args = parseArgs(process.argv);
    if (!args.config) throw new Error('Usage: node scripts/benchmark.js --config <file> [--mode access|lifecycle|synchronized|outage|all] [--allow-outage]');
    const configPath = path.resolve(args.config);
    const source = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const config = {
        ...source,
        baseUrl: source.baseUrl || 'http://localhost:3000',
        backend: String(source.backend || '').toUpperCase(),
        concurrency: numberOption(args.concurrency ?? source.concurrency, 4, 'concurrency', 1),
        durationSeconds: numberOption(args.duration ?? source.durationSeconds, 30, 'durationSeconds', 1),
        warmupSeconds: numberOption(source.warmupSeconds, 5, 'warmupSeconds'),
        lifecycleIterations: numberOption(source.lifecycleIterations, 10, 'lifecycleIterations', 1),
        requestTimeoutMs: numberOption(source.requestTimeoutMs, 30000, 'requestTimeoutMs', 1),
        resourceIntervalMs: numberOption(source.resourceIntervalMs, 1000, 'resourceIntervalMs', 100),
        gatewayPid: source.gatewayPid || process.env.BENCHMARK_GATEWAY_PID,
        containers: Array.isArray(source.containers) ? source.containers : [],
        outage: {
            baselineSamples: 5, probeIntervalMs: 500, outageSeconds: 10, recoveryTimeoutSeconds: 60, commandTimeoutMs: 60000,
            ...source.outage,
        },
    };
    if (!['FABRIC', 'IOTA', 'POSTGRES', 'SYNCHRONIZED'].includes(config.backend)) throw new Error('backend must be FABRIC, IOTA, POSTGRES, or SYNCHRONIZED');
    const token = process.env.BENCHMARK_ADMIN_TOKEN || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!token) throw new Error('BENCHMARK_ADMIN_TOKEN must contain an admin access token or server-side service-role key');
    const output = path.resolve(args.output || source.output || `results/raw/${config.backend.toLowerCase()}-${Date.now()}.jsonl`);
    const writer = createWriter(output);
    writer.write({ kind: 'metadata', schemaVersion: 1, backend: config.backend, configuration: { ...config, outage: config.outage ? { ...config.outage, stopCommand: '[configured]', startCommand: '[configured]' } : null }, machine: machineMetadata(config) });
    try {
        await selectBackend(config, token);
        const mode = args.mode || 'access';
        if (!['access', 'lifecycle', 'synchronized', 'outage', 'all'].includes(mode)) throw new Error('mode must be access, lifecycle, synchronized, outage, or all');
        if (config.backend === 'SYNCHRONIZED' && mode !== 'synchronized') throw new Error('SYNCHRONIZED backend requires --mode synchronized');
        if (mode === 'access' || mode === 'all') await runAccess(config, token, writer);
        if (mode === 'lifecycle' || mode === 'all') await runLifecycle(config, token, writer);
        if (mode === 'synchronized') await runSynchronizedRegistration(config, token, writer);
        if (mode === 'outage' || mode === 'all') await runOutage(config, token, writer, args['allow-outage'] === true);
        console.log(`Raw benchmark data written to ${output}`);
    } finally {
        await writer.close();
    }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { accessPayload, parseBytes, percentile };
