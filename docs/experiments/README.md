# Experimental Evaluation

This directory defines a reproducible workflow for producing the paper's latency, throughput, lifecycle, failure-recovery, and resource figures. It intentionally contains no fabricated measurements. Raw and analyzed output is written under ignored `results/` directories.

## Publication Artifacts Available From Code

- [`../architecture.svg`](../architecture.svg): publication-sized system architecture.
- [`../access-request-sequence.svg`](../access-request-sequence.svg): access decision sequence derived from `POST /api/access` in `gateway.js`.
- [`../dual-ledger-registration.svg`](../dual-ledger-registration.svg): simulator registration and reverse-order compensation flow derived from `deviceStore.registerSimulatorDevice`.

## Controlled Setup

Use the same machine state, gateway build, ledger state, request count, warm-up, sample interval, and network topology for every backend. Run Fabric, IOTA, and PostgreSQL as separate profiles; do not compare a local Fabric network with a remote IOTA endpoint without reporting that topology as a limitation.

1. Copy `benchmark.example.json` to an ignored machine-specific location such as `results/config/fabric.json`.
2. Fill every `REPLACE_WITH_*` and `null` hardware/network field from the actual test environment.
3. Start the gateway with only the backend under test selected. For PostgreSQL, disable Fabric and IOTA so PostgreSQL is the active fallback.
4. Set `BENCHMARK_ADMIN_TOKEN` in the shell. Do not put credentials in JSON.
5. For throughput runs only, set `ACCESS_RATE_LIMIT_MAX` high enough not to cap the experiment, restart the gateway, and report the value. Keep the production default of 120 otherwise.
6. Execute at least 30 independent runs per backend/configuration when inferential comparisons are required. Randomize backend run order where practical.

The runner captures OS, CPU model, logical CPU count, RAM, Node version, hostname, supplied network fields, and the exact effective benchmark configuration in each JSONL file. Container names and `gatewayPid` enable one-second CPU and memory measurements through `docker stats` and the host process API.

## Authorization And Throughput

The runner creates a temporary P-256 device, registers its public key, warms the path, sends unique signed requests, and deletes the device. Concurrency and steady-state duration are configurable either in JSON or on the command line.

```bash
BENCHMARK_ADMIN_TOKEN=... npm run benchmark -- --config results/config/fabric.json --mode access --concurrency 1 --duration 60
BENCHMARK_ADMIN_TOKEN=... npm run benchmark -- --config results/config/fabric.json --mode access --concurrency 8 --duration 60 --output results/raw/fabric-c8-run01.jsonl
```

Repeat the concurrency series, for example `1, 2, 4, 8, 16, 32`, for each backend. Authorization latency uses every steady-state end-to-end sample. Throughput is successful responses divided by measured wall-clock run duration; rate-limited and failed responses remain in the raw data and success-rate calculation.

## Lifecycle Latency

Each iteration creates a unique device and times `register`, `revoke`, `activate`, `rotate`, and `delete` in order. A failed operation aborts the iteration rather than silently contaminating subsequent samples.

```bash
BENCHMARK_ADMIN_TOKEN=... npm run benchmark -- --config results/config/fabric.json --mode lifecycle
```

## Synchronized Registration Timing

Run the gateway with Fabric, IOTA, and PostgreSQL enabled. The synchronized profile uses simulator-managed registration and records high-resolution server durations for the sequential Fabric (`T_F`), IOTA (`T_I`), PostgreSQL (`T_P`), and local key-store (`T_K`) stages, their total commit chain (`T_total`), and end-to-end endpoint latency.

```bash
BENCHMARK_ADMIN_TOKEN=... npm run benchmark -- --config results/config/synchronized.json --mode synchronized --output results/final-raw/synchronized-registration.jsonl
```

The analyzer includes these measurements in `results-table.csv` and generates `synchronized-registration.svg`.

## Failure Recovery

Outage commands are supplied by the operator because deployment names differ. The runner records a healthy baseline, executes the stop command, probes during the outage, executes the start command, and measures time to the first successful authorization. It attempts an emergency restart in `finally` if the experiment aborts.

```bash
BENCHMARK_ADMIN_TOKEN=... npm run benchmark -- --config results/config/fabric.json --mode outage --allow-outage
```

`--allow-outage` is mandatory. Review commands before running them. Use a disposable environment, never production. For PostgreSQL, target the database container/service; for Fabric, target the authoritative peer or ordering dependency specified in the paper; for IOTA, use a controlled local node or a network fault proxy rather than attempting to stop public infrastructure.

## Analysis

```bash
npm run benchmark:analyze -- --input results/raw --output results/analysis
```

The analyzer emits:

- `authorization-latency.svg`
- `throughput.svg`
- `lifecycle-latency.svg`
- `failure-recovery.svg`
- `cpu-memory.svg`
- `results-table.csv` with sample count, mean, median, p95, p99, minimum, maximum, population standard deviation, and success rate
- `metadata.json` containing the captured experimental environments

SVGs are generated directly and remain editable publication vectors. The table and figures should be regenerated from archived raw JSONL, not edited by hand.

## Required Hardware And Network Fields

The following cannot be inferred safely from source code and must describe the machine that actually ran the final experiment:

| Field | Required value |
| --- | --- |
| CPU | Model, sockets/cores/logical processors, imposed CPU limits |
| Memory | Physical RAM and container/VM memory limits |
| Storage | Device type, filesystem, and relevant volume placement |
| OS/runtime | OS/kernel, Docker version, Node version |
| Topology | Which components are local, containerized, virtualized, or remote |
| Network | Link type, nominal bandwidth, measured RTT to gateway and backend, loss shaping |
| Ledger | Fabric topology/consensus and IOTA node/network identifiers |
| Database | PostgreSQL/Supabase location, version, pool size, and connection path |
| Controls | Power mode, background-load policy, warm-up, run order, repetitions |

## Abstract And Conclusion

Write these only after final analysis. Report the principal comparison with units and uncertainty/sample count, the throughput saturation point, the most expensive lifecycle operation, observed outage recovery, and peak or mean resource cost. Do not generalize beyond the measured topology, and distinguish failed-closed behavior from recovery speed.
