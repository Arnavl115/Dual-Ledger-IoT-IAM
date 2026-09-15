'use strict';

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
    const args = {};
    for (let index = 2; index < argv.length; index++) {
        if (!argv[index].startsWith('--')) continue;
        const name = argv[index].slice(2);
        args[name] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
    }
    return args;
}

function quantile(sorted, fraction) {
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function summarize(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return { n: 0, mean: null, median: null, p95: null, p99: null, min: null, max: null, stddev: null };
    const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
    const variance = sorted.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / sorted.length;
    return { n: sorted.length, mean, median: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), p99: quantile(sorted, 0.99), min: sorted[0], max: sorted.at(-1), stddev: Math.sqrt(variance) };
}

function groupBy(records, key) {
    const groups = new Map();
    for (const record of records) {
        const value = typeof key === 'function' ? key(record) : record[key];
        if (!groups.has(value)) groups.set(value, []);
        groups.get(value).push(record);
    }
    return groups;
}

function csvValue(value) {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'number' ? value.toFixed(3) : String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeCsv(file, rows) {
    const columns = ['experiment', 'backend', 'operation', 'metric', 'n', 'mean', 'median', 'p95', 'p99', 'min', 'max', 'stddev', 'successRate'];
    fs.writeFileSync(file, `${columns.join(',')}\n${rows.map(row => columns.map(column => csvValue(row[column])).join(',')).join('\n')}\n`);
}

function escapeXml(value) {
    return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function barChart(title, subtitle, items, valueLabel) {
    const width = 1000;
    const height = Math.max(300, 150 + items.length * 52);
    const max = Math.max(...items.map(item => item.value), 1);
    const bars = items.map((item, index) => {
        const y = 112 + index * 52;
        const barWidth = 620 * item.value / max;
        return `<text x="260" y="${y + 18}" text-anchor="end" class="label">${escapeXml(item.label)}</text><rect x="280" y="${y}" width="${barWidth.toFixed(1)}" height="27" rx="3" fill="${item.color || '#2563eb'}"/><text x="${Math.min(920, 292 + barWidth).toFixed(1)}" y="${y + 19}" class="value">${escapeXml(valueLabel(item.value))}</text>`;
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"><style>text{font-family:Inter,Arial,sans-serif;fill:#172033}.title{font-size:24px;font-weight:700}.subtitle{font-size:12px;fill:#64748b}.label{font-size:13px}.value{font-size:12px;font-weight:700}</style><rect width="100%" height="100%" fill="white"/><text x="45" y="43" class="title">${escapeXml(title)}</text><text x="45" y="67" class="subtitle">${escapeXml(subtitle)}</text>${bars}</svg>`;
}

function resourceChart(cpuItems, memoryItems) {
    const panel = (items, yOffset, max, formatter) => items.map((item, index) => {
        const y = yOffset + index * 43;
        const width = 530 * item.value / Math.max(max, 1);
        return `<text x="300" y="${y + 17}" text-anchor="end" class="label">${escapeXml(item.label)}</text><rect x="320" y="${y}" width="${width.toFixed(1)}" height="25" rx="3" fill="${item.color || '#2563eb'}"/><text x="${Math.min(900, 332 + width).toFixed(1)}" y="${y + 18}" class="value">${escapeXml(formatter(item.value))}</text>`;
    }).join('');
    const count = Math.max(cpuItems.length, memoryItems.length, 1);
    const memoryY = 135 + count * 43 + 75;
    const height = memoryY + Math.max(memoryItems.length, 1) * 43 + 55;
    const empty = !cpuItems.length && !memoryItems.length ? '<text x="45" y="105" class="subtitle">No matching resource samples were exported.</text>' : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${height}" viewBox="0 0 1000 ${height}" role="img"><style>text{font-family:Inter,Arial,sans-serif;fill:#172033}.title{font-size:24px;font-weight:700}.section{font-size:16px;font-weight:700}.subtitle{font-size:12px;fill:#64748b}.label{font-size:12px}.value{font-size:12px;font-weight:700}</style><rect width="100%" height="100%" fill="white"/><text x="45" y="43" class="title">CPU and memory utilization</text><text x="45" y="67" class="subtitle">Mean utilization by measured gateway process or container.</text>${empty}<text x="45" y="112" class="section">CPU utilization</text>${panel(cpuItems, 135, Math.max(...cpuItems.map(item => item.value), 1), value => `${value.toFixed(2)}%`)}<text x="45" y="${memoryY - 23}" class="section">Resident memory</text>${panel(memoryItems, memoryY, Math.max(...memoryItems.map(item => item.value), 1), value => `${(value / 1024 ** 2).toFixed(2)} MiB`)}</svg>`;
}

function confidenceInterval(values) {
    const stats = summarize(values);
    if (stats.n < 2) return { low: stats.mean, high: stats.mean };
    const margin = 1.96 * stats.stddev / Math.sqrt(stats.n);
    return { low: Math.max(0, stats.mean - margin), high: stats.mean + margin };
}

function authorizationConcurrencySummary(records, maxConcurrency, maxRuns) {
    const metrics = ['median', 'p95', 'p99'];
    const runGroups = groupBy(records.filter(record => record.experiment === 'authorization' && record.success && record.concurrency <= maxConcurrency), record => `${record.backend}|${record.concurrency}|${record.runId}`);
    const runStats = Array.from(runGroups.entries()).map(([key, samples]) => {
        const [backend, concurrency] = key.split('|');
        return { backend, concurrency: Number(concurrency), ...summarize(samples.map(sample => sample.latencyMs)) };
    });
    const pointGroups = groupBy(runStats, record => `${record.backend}|${record.concurrency}`);
    return Array.from(pointGroups.entries()).flatMap(([key, runs]) => {
        const [backend, concurrency] = key.split('|');
        const selectedRuns = runs.slice(0, maxRuns);
        return metrics.map(metric => {
            const values = selectedRuns.map(run => run[metric]);
            return { backend, concurrency: Number(concurrency), metric, runs: selectedRuns.length, value: summarize(values).mean, ...confidenceInterval(values) };
        });
    });
}

function throughputConcurrencySummary(records, maxConcurrency, maxRuns) {
    const groups = groupBy(records.filter(record => record.kind === 'event' && record.event === 'run_end' && record.experiment === 'authorization' && record.concurrency <= maxConcurrency), record => `${record.backend}|${record.concurrency}`);
    return Array.from(groups.entries()).map(([key, runs]) => {
        const [backend, concurrency] = key.split('|');
        const selectedRuns = runs.slice(0, maxRuns);
        const values = selectedRuns.map(run => run.throughputRps);
        return { backend, concurrency: Number(concurrency), metric: 'throughput_rps', runs: selectedRuns.length, value: summarize(values).mean, ...confidenceInterval(values) };
    });
}

function latencyByConcurrencyChart(records, maxConcurrency, maxRuns) {
    const backends = ['FABRIC', 'IOTA', 'POSTGRES'];
    const metrics = [
        { key: 'median', label: 'Median', color: '#172554' },
        { key: 'p95', label: 'p95', color: '#2563eb' },
        { key: 'p99', label: 'p99', color: '#ea580c' },
    ];
    const summaries = authorizationConcurrencySummary(records, maxConcurrency, maxRuns);
    const points = Array.from(groupBy(summaries, record => `${record.backend}|${record.concurrency}`).entries()).map(([key, entries]) => {
        const [backend, concurrency] = key.split('|');
        const point = { backend, concurrency: Number(concurrency), runs: entries[0].runs };
        for (const entry of entries) {
            point[entry.metric] = entry.value;
            point[`${entry.metric}Ci`] = { low: entry.low, high: entry.high };
        }
        return point;
    });
    const width = 1160;
    const height = 890;
    const left = 100;
    const right = 45;
    const panelWidth = width - left - right;
    const panelHeight = 205;
    const panelGap = 55;
    const chartTop = 120;
    const levels = [...new Set(points.map(point => point.concurrency))].sort((a, b) => a - b);
    const content = backends.map((backend, panelIndex) => {
        const backendPoints = points.filter(point => point.backend === backend).sort((a, b) => a.concurrency - b.concurrency);
        const top = chartTop + panelIndex * (panelHeight + panelGap);
        const bottom = top + panelHeight;
        const maxValue = Math.max(...backendPoints.flatMap(point => metrics.map(metric => point[`${metric.key}Ci`].high)), 1);
        const x = concurrency => left + levels.indexOf(concurrency) * (panelWidth / Math.max(levels.length - 1, 1));
        const y = value => bottom - value / maxValue * panelHeight;
        const grid = Array.from({ length: 5 }, (_, index) => {
            const value = maxValue * index / 4;
            const gridY = y(value);
            return `<line x1="${left}" y1="${gridY}" x2="${width - right}" y2="${gridY}" class="grid"/><text x="${left - 12}" y="${gridY + 4}" text-anchor="end" class="tick">${value.toFixed(0)}</text>`;
        }).join('');
        const series = metrics.map(metric => {
            const available = backendPoints.filter(point => Number.isFinite(point[metric.key]));
            const path = available.map((point, index) => `${index ? 'L' : 'M'}${x(point.concurrency)},${y(point[metric.key])}`).join(' ');
            const marks = available.map(point => {
                const ci = point[`${metric.key}Ci`];
                const pointX = x(point.concurrency);
                return `<line x1="${pointX}" y1="${y(ci.low)}" x2="${pointX}" y2="${y(ci.high)}" stroke="${metric.color}" class="ci"/><line x1="${pointX - 4}" y1="${y(ci.low)}" x2="${pointX + 4}" y2="${y(ci.low)}" stroke="${metric.color}"/><line x1="${pointX - 4}" y1="${y(ci.high)}" x2="${pointX + 4}" y2="${y(ci.high)}" stroke="${metric.color}"/><circle cx="${pointX}" cy="${y(point[metric.key])}" r="4" fill="${metric.color}"/>`;
            }).join('');
            return `<path d="${path}" fill="none" stroke="${metric.color}" stroke-width="2.5"/>${marks}`;
        }).join('');
        const xTicks = levels.map(level => `<text x="${x(level)}" y="${bottom + 23}" text-anchor="middle" class="tick">${level}</text>`).join('');
        const runLabel = backendPoints.length ? `${Math.min(...backendPoints.map(point => point.runs))}-${Math.max(...backendPoints.map(point => point.runs))} runs per point` : 'no samples';
        return `<text x="${left}" y="${top - 17}" class="panel">${backend}</text><text x="${width - right}" y="${top - 17}" text-anchor="end" class="tick">${runLabel}</text>${grid}<line x1="${left}" y1="${top}" x2="${left}" y2="${bottom}" class="axis"/><line x1="${left}" y1="${bottom}" x2="${width - right}" y2="${bottom}" class="axis"/>${series}${xTicks}`;
    }).join('');
    const legend = metrics.map((metric, index) => `<line x1="${left + index * 150}" y1="82" x2="${left + 28 + index * 150}" y2="82" stroke="${metric.color}" stroke-width="3"/><text x="${left + 36 + index * 150}" y="87" class="legend">${metric.label}</text>`).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"><style>text{font-family:Inter,Arial,sans-serif;fill:#172033}.title{font-size:25px;font-weight:700}.subtitle,.tick{font-size:11px;fill:#64748b}.panel{font-size:15px;font-weight:700}.legend{font-size:12px}.grid{stroke:#e2e8f0;stroke-width:1}.axis{stroke:#64748b;stroke-width:1.2}.ci{stroke-width:1.2}</style><rect width="100%" height="100%" fill="white"/><text x="45" y="38" class="title">End-to-end authorization latency by route and concurrency</text><text x="45" y="61" class="subtitle">Points are means of run-level percentiles; whiskers are normal-approximation 95% confidence intervals. Latency in milliseconds.</text>${legend}${content}<text x="${width / 2}" y="${height - 12}" text-anchor="middle" class="subtitle">Concurrent clients</text><text x="18" y="${height / 2}" text-anchor="middle" transform="rotate(-90 18 ${height / 2})" class="subtitle">Latency (ms)</text></svg>`;
}

function throughputByConcurrencyChart(records, maxConcurrency, maxRuns) {
    const colors = { FABRIC: '#2563eb', IOTA: '#0f766e', POSTGRES: '#c2410c', SYNCHRONIZED: '#7c3aed' };
    const points = throughputConcurrencySummary(records, maxConcurrency, maxRuns).map(point => ({ ...point, ci: { low: point.low, high: point.high } }));
    const levels = [...new Set(points.map(point => point.concurrency))].sort((a, b) => a - b);
    const width = 1050;
    const height = 560;
    const left = 90;
    const right = 45;
    const top = 105;
    const bottom = 475;
    const maxValue = Math.max(...points.map(point => point.ci.high), 1);
    const x = concurrency => left + levels.indexOf(concurrency) * ((width - left - right) / Math.max(levels.length - 1, 1));
    const y = value => bottom - value / maxValue * (bottom - top);
    const grid = Array.from({ length: 6 }, (_, index) => {
        const value = maxValue * index / 5;
        return `<line x1="${left}" y1="${y(value)}" x2="${width - right}" y2="${y(value)}" class="grid"/><text x="${left - 12}" y="${y(value) + 4}" text-anchor="end" class="tick">${value.toFixed(1)}</text>`;
    }).join('');
    const series = Object.entries(colors).map(([backend, color], backendIndex) => {
        const backendPoints = points.filter(point => point.backend === backend).sort((a, b) => a.concurrency - b.concurrency);
        const path = backendPoints.map((point, index) => `${index ? 'L' : 'M'}${x(point.concurrency)},${y(point.value)}`).join(' ');
        const marks = backendPoints.map(point => `<line x1="${x(point.concurrency)}" y1="${y(point.ci.low)}" x2="${x(point.concurrency)}" y2="${y(point.ci.high)}" stroke="${color}"/><circle cx="${x(point.concurrency)}" cy="${y(point.value)}" r="5" fill="${color}"/><text x="${x(point.concurrency)}" y="${y(point.value) - 10}" text-anchor="middle" class="value">${point.value.toFixed(1)}</text>`).join('');
        return `<path d="${path}" fill="none" stroke="${color}" stroke-width="3"/>${marks}<line x1="${left + backendIndex * 165}" y1="78" x2="${left + 28 + backendIndex * 165}" y2="78" stroke="${color}" stroke-width="3"/><text x="${left + 36 + backendIndex * 165}" y="83" class="legend">${backend}</text>`;
    }).join('');
    const xTicks = levels.map(level => `<text x="${x(level)}" y="${bottom + 25}" text-anchor="middle" class="tick">${level}</text>`).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"><style>text{font-family:Inter,Arial,sans-serif;fill:#172033}.title{font-size:25px;font-weight:700}.subtitle,.tick{font-size:11px;fill:#64748b}.legend,.value{font-size:12px}.value{font-weight:700}.grid{stroke:#e2e8f0;stroke-width:1}.axis{stroke:#64748b;stroke-width:1.2}</style><rect width="100%" height="100%" fill="white"/><text x="45" y="38" class="title">Authorization throughput by route and concurrency</text><text x="45" y="60" class="subtitle">Mean successful requests per second; whiskers are normal-approximation 95% confidence intervals.</text>${grid}<line x1="${left}" y1="${top}" x2="${left}" y2="${bottom}" class="axis"/><line x1="${left}" y1="${bottom}" x2="${width - right}" y2="${bottom}" class="axis"/>${series}${xTicks}<text x="${width / 2}" y="${height - 18}" text-anchor="middle" class="subtitle">Concurrent clients</text><text x="18" y="${height / 2}" text-anchor="middle" transform="rotate(-90 18 ${height / 2})" class="subtitle">Successful requests per second</text></svg>`;
}

function main() {
    const args = parseArgs(process.argv);
    if (!args.input) throw new Error('Usage: node scripts/analyze-benchmarks.js --input <raw-directory> [--output results/analysis]');
    const input = path.resolve(args.input);
    const output = path.resolve(args.output || 'results/analysis');
    fs.mkdirSync(output, { recursive: true });
    const files = fs.statSync(input).isDirectory()
        ? fs.readdirSync(input).filter(name => name.endsWith('.jsonl')).map(name => path.join(input, name))
        : [input];
    const records = files.flatMap(file => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
        try { return JSON.parse(line); } catch (error) { throw new Error(`${file}:${index + 1}: ${error.message}`); }
    }));
    const measurements = records.filter(record => record.kind === 'measurement');
    const maxConcurrency = Number(args['max-concurrency'] || Number.POSITIVE_INFINITY);
    const maxRuns = Number(args['max-runs'] || Number.POSITIVE_INFINITY);
    const rows = [];
    for (const [key, samples] of groupBy(measurements.filter(record => Number.isFinite(record.latencyMs)), record => `${record.experiment}|${record.backend}|${record.operation || 'all'}`)) {
        const [experiment, backend, operation] = key.split('|');
        const latencySamples = ['lifecycle', 'synchronized_registration'].includes(experiment)
            ? samples.filter(sample => sample.success)
            : samples;
        rows.push({ experiment, backend, operation, metric: 'latency_ms', ...summarize(latencySamples.map(sample => sample.latencyMs)), successRate: samples.filter(sample => sample.success).length / samples.length });
    }
    for (const [key, samples] of groupBy(measurements.filter(record => record.experiment === 'authorization' && record.success && record.concurrency <= maxConcurrency), record => `${record.backend}|${record.concurrency}`)) {
        const [backend, concurrency] = key.split('|');
        rows.push({ experiment: 'authorization_by_concurrency', backend, operation: `concurrency=${concurrency}`, metric: 'latency_ms', ...summarize(samples.map(sample => sample.latencyMs)), successRate: 1 });
    }
    const componentFields = {
        ledger_lookup_ms: 'ledgerLookupMs',
        replay_audit_persistence_ms: 'replayAuditPersistenceMs',
        gateway_total_ms: 'gatewayTotalMs',
    };
    for (const [metric, field] of Object.entries(componentFields)) {
        for (const [key, samples] of groupBy(measurements.filter(record => record.experiment === 'authorization' && record.success && Number.isFinite(record[field]) && record.concurrency <= maxConcurrency), record => `${record.backend}|${record.concurrency}`)) {
            const [backend, concurrency] = key.split('|');
            rows.push({ experiment: 'authorization_component', backend, operation: `concurrency=${concurrency}`, metric, ...summarize(samples.map(sample => sample[field])), successRate: 1 });
        }
    }
    for (const [key, samples] of groupBy(measurements.filter(record => record.experiment === 'resource' && Number.isFinite(record.cpuPercent)), record => `${record.backend}|${record.target}`)) {
        const [backend, operation] = key.split('|');
        rows.push({ experiment: 'resource', backend, operation, metric: 'cpu_percent', ...summarize(samples.map(sample => sample.cpuPercent)), successRate: null });
    }
    for (const [key, samples] of groupBy(measurements.filter(record => record.experiment === 'resource' && Number.isFinite(record.memoryBytes)), record => `${record.backend}|${record.target}`)) {
        const [backend, operation] = key.split('|');
        rows.push({ experiment: 'resource', backend, operation, metric: 'memory_bytes', ...summarize(samples.map(sample => sample.memoryBytes)), successRate: null });
    }
    const throughput = records.filter(record => record.kind === 'event' && record.event === 'run_end' && record.experiment === 'authorization');
    for (const [key, runs] of groupBy(throughput, record => `${record.backend}|${record.concurrency}`)) {
        const [backend, operation] = key.split('|');
        rows.push({ experiment: 'throughput', backend, operation: `concurrency=${operation}`, metric: 'successful_requests_per_second', ...summarize(runs.map(run => run.throughputRps)), successRate: runs.reduce((sum, run) => sum + run.successes, 0) / runs.reduce((sum, run) => sum + run.requests, 0) });
    }
    const recoveries = records.filter(record => record.kind === 'event' && record.event === 'outage_recovered');
    for (const [backend, runs] of groupBy(recoveries, 'backend')) rows.push({ experiment: 'failure_recovery', backend, operation: 'recovery', metric: 'recovery_ms', ...summarize(runs.map(run => run.recoveryMs)), successRate: runs.filter(run => run.recovered).length / runs.length });
    writeCsv(path.join(output, 'results-table.csv'), rows);

    const colors = { FABRIC: '#2563eb', IOTA: '#0f766e', POSTGRES: '#c2410c' };
    const charts = [
        ['authorization-latency.svg', 'Authorization latency', 'End-to-end POST /api/access latency; bars show p95.', rows.filter(row => row.experiment === 'authorization' && row.metric === 'latency_ms').map(row => ({ label: row.backend, value: row.p95, color: colors[row.backend] })), value => `${value.toFixed(2)} ms`],
        ['throughput.svg', 'Authorization throughput', 'Successful requests per second by configured concurrency.', rows.filter(row => row.experiment === 'throughput').map(row => ({ label: `${row.backend}, ${row.operation}`, value: row.mean, color: colors[row.backend] })), value => `${value.toFixed(2)} req/s`],
        ['lifecycle-latency.svg', 'Device lifecycle latency', 'Mean end-to-end management API latency by backend and operation.', rows.filter(row => row.experiment === 'lifecycle' && row.metric === 'latency_ms').map(row => ({ label: `${row.backend} ${row.operation}`, value: row.mean, color: colors[row.backend] })), value => `${value.toFixed(2)} ms`],
        ['synchronized-registration.svg', 'Synchronized registration timing', 'Mean high-resolution server timing for Fabric, IOTA, PostgreSQL, key persistence, total commit chain, and endpoint latency.', rows.filter(row => row.experiment === 'synchronized_registration' && row.metric === 'latency_ms').map(row => ({ label: row.operation, value: row.mean, color: '#7c3aed' })), value => `${value.toFixed(2)} ms`],
        ['authorization-components.svg', 'Authorization component latency', 'Mean server-side monotonic timing by route and concurrency.', rows.filter(row => row.experiment === 'authorization_component').map(row => ({ label: `${row.backend} ${row.operation} ${row.metric}`, value: row.mean, color: colors[row.backend] })), value => `${value.toFixed(2)} ms`],
        ['failure-recovery.svg', 'Failure recovery time', 'Elapsed time from dependency restart until the first successful authorization.', rows.filter(row => row.experiment === 'failure_recovery').map(row => ({ label: row.backend, value: row.mean, color: colors[row.backend] })), value => `${value.toFixed(0)} ms`],
    ];
    for (const [name, title, subtitle, items, formatter] of charts) {
        fs.writeFileSync(path.join(output, name), barChart(title, items.length ? subtitle : `${subtitle} No matching samples were exported.`, items, formatter));
    }
    const cpuItems = rows.filter(row => row.experiment === 'resource' && row.metric === 'cpu_percent').map(row => ({ label: `${row.backend} ${row.operation}`, value: row.mean, color: colors[row.backend] }));
    const memoryItems = rows.filter(row => row.experiment === 'resource' && row.metric === 'memory_bytes').map(row => ({ label: `${row.backend} ${row.operation}`, value: row.mean, color: colors[row.backend] }));
    fs.writeFileSync(path.join(output, 'cpu-memory.svg'), resourceChart(cpuItems, memoryItems));
    fs.writeFileSync(path.join(output, 'authorization-latency-by-concurrency.svg'), latencyByConcurrencyChart(measurements, maxConcurrency, maxRuns));
    fs.writeFileSync(path.join(output, 'throughput-by-concurrency.svg'), throughputByConcurrencyChart(records, maxConcurrency, maxRuns));
    const concurrencyRows = [
        ...authorizationConcurrencySummary(measurements, maxConcurrency, maxRuns),
        ...throughputConcurrencySummary(records, maxConcurrency, maxRuns),
    ];
    fs.writeFileSync(path.join(output, 'concurrency-summary.csv'), `backend,concurrency,metric,runs,value,ci95_low,ci95_high\n${concurrencyRows.map(row => [row.backend, row.concurrency, row.metric, row.runs, row.value, row.low, row.high].map(csvValue).join(',')).join('\n')}\n`);
    fs.writeFileSync(path.join(output, 'metadata.json'), `${JSON.stringify(records.filter(record => record.kind === 'metadata'), null, 2)}\n`);
    console.log(`Analyzed ${measurements.length} measurements from ${files.length} raw file(s) into ${output}`);
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { quantile, summarize };
