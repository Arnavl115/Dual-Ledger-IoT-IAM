import { useEffect, useRef, useState } from 'react';
import {
    Activity,
    AlertCircle,
    ArrowRight,
    Check,
    CircleGauge,
    Cpu,
    Database,
    FileClock,
    LayoutDashboard,
    LoaderCircle,
    LogOut,
    Menu,
    Network,
    Play,
    Plus,
    RefreshCw,
    Server,
    ShieldCheck,
    X,
    Zap,
} from 'lucide-react';
import { Chart, registerables } from 'chart.js';
import { apiGet, apiPost } from './lib/api';
import { supabase } from './lib/supabase';

Chart.register(...registerables);

const NAV_ITEMS = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'devices', label: 'Devices', icon: Cpu },
    { id: 'logs', label: 'Request log', icon: FileClock },
];

function Brand({ compact = false }) {
    return (
        <div className={`brand ${compact ? 'brand--compact' : ''}`}>
            <div className="brand__mark" aria-hidden="true"><Network /></div>
            <div>
                <strong>Trust Gateway</strong>
                {!compact && <span>Dual-ledger identity control</span>}
            </div>
        </div>
    );
}

function StatusBadge({ status }) {
    const tone = status === 'ACTIVE' || status === 'GRANTED' || status === 'REGISTERED'
        ? 'positive'
        : status === 'REVOKED'
            ? 'negative'
            : 'warning';
    return <span className={`status-badge status-badge--${tone}`}>{status}</span>;
}

function EmptyState({ icon: Icon, title, detail }) {
    return (
        <div className="empty-state">
            <Icon aria-hidden="true" />
            <strong>{title}</strong>
            <span>{detail}</span>
        </div>
    );
}

function Modal({ title, eyebrow, onClose, children, size = 'default' }) {
    const panelRef = useRef(null);

    useEffect(() => {
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        if (!panelRef.current?.contains(document.activeElement)) panelRef.current?.focus();
        return () => { document.body.style.overflow = previousOverflow; };
    }, []);

    const handleKeyDown = (event) => {
        if (event.key === 'Escape') onClose();
        if (event.key !== 'Tab') return;
        const controls = panelRef.current?.querySelectorAll(
            'button:not([disabled]), input:not([disabled]), textarea:not([disabled])'
        );
        if (!controls?.length) return;
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    };

    return (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
            <section
                ref={panelRef}
                className={`modal modal--${size}`}
                role="dialog"
                aria-modal="true"
                aria-labelledby="modal-title"
                tabIndex={-1}
                onKeyDown={handleKeyDown}
            >
                <header className="modal__header">
                    <div>
                        <span className="eyebrow">{eyebrow}</span>
                        <h2 id="modal-title">{title}</h2>
                    </div>
                    <button className="icon-button" type="button" onClick={onClose} aria-label="Close dialog">
                        <X />
                    </button>
                </header>
                {children}
            </section>
        </div>
    );
}

function RouteRail({ activeRoute, activeBackend, enabledRoutes, switching, onSwitch }) {
    return (
        <div className="route-rail" aria-label="Ledger route">
            {['FABRIC', 'IOTA'].map((route, index) => {
                const enabled = enabledRoutes.includes(route);
                const selected = activeRoute === route;
                const Icon = route === 'FABRIC' ? Database : Zap;
                return (
                    <div className="route-rail__segment" key={route}>
                        {index > 0 && <span className="route-rail__line" aria-hidden="true" />}
                        <button
                            type="button"
                            className={`route-node ${selected ? 'route-node--selected' : ''}`}
                            onClick={() => onSwitch(route)}
                            disabled={!enabled || Boolean(switching)}
                            aria-pressed={selected}
                            title={enabled ? `Route requests through ${route}` : `${route} is disabled on the gateway`}
                        >
                            <span className="route-node__icon"><Icon /></span>
                            <span>
                                <strong>{route === 'FABRIC' ? 'Hyperledger' : 'IOTA'}</strong>
                                <small>{enabled ? (selected ? 'Selected' : 'Available') : 'Disabled'}</small>
                            </span>
                            {switching === route ? <LoaderCircle className="spin" /> : selected ? <Check /> : null}
                        </button>
                    </div>
                );
            })}
            <p>
                Active reads: <strong>{activeBackend === 'IOTA' ? 'IOTA Tangle' : activeBackend}</strong>
            </p>
        </div>
    );
}

export default function AdminDashboard() {
    const [view, setView] = useState('overview');
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const [isStressModalOpen, setIsStressModalOpen] = useState(false);
    const [isAddDeviceModalOpen, setIsAddDeviceModalOpen] = useState(false);
    const [newDeviceId, setNewDeviceId] = useState('');
    const [newDeviceKey, setNewDeviceKey] = useState('');
    const [activeRoute, setActiveRoute] = useState('MEMORY');
    const [activeBackend, setActiveBackend] = useState('MEMORY');
    const [enabledRoutes, setEnabledRoutes] = useState([]);
    const [isStressTesting, setIsStressTesting] = useState(false);
    const [stressReport, setStressReport] = useState(null);
    const [devices, setDevices] = useState([]);
    const [liveLogs, setLiveLogs] = useState([]);
    const [logTotal, setLogTotal] = useState(0);
    const [logsLoading, setLogsLoading] = useState(false);
    const [logsError, setLogsError] = useState('');
    const [tpsData, setTpsData] = useState([]);
    const [ledgerError, setLedgerError] = useState('');
    const [gatewayError, setGatewayError] = useState('');
    const [actionError, setActionError] = useState('');
    const [routeSwitching, setRouteSwitching] = useState('');
    const [deviceUpdating, setDeviceUpdating] = useState('');
    const [registering, setRegistering] = useState(false);
    const chartRef = useRef(null);
    const chartInstance = useRef(null);
    const prevStressTesting = useRef(false);

    const isLiveLedger = activeBackend === 'FABRIC' || activeBackend === 'IOTA';
    const isFallback = enabledRoutes.includes(activeRoute) && activeBackend !== activeRoute;
    const activeDevices = devices.filter((device) => device.status === 'ACTIVE').length;
    const peakTps = tpsData.length ? Math.max(...tpsData.map((point) => point.tps)) : 0;
    const currentView = NAV_ITEMS.find((item) => item.id === view);
    const hasOpenModal = isAddDeviceModalOpen || (isStressModalOpen && Boolean(stressReport));

    useEffect(() => {
        const fetchState = async () => {
            try {
                const res = await apiGet('/api/state');
                if (!res.ok) throw new Error(`Gateway returned ${res.status}`);
                const data = await res.json();
                setDevices(data.devices || []);
                setTpsData(data.tpsData || []);
                setActiveRoute(data.activeRoute || data.activeBackend || 'MEMORY');
                setActiveBackend(data.activeBackend || data.ledgerMode || 'MEMORY');
                setEnabledRoutes(data.enabledRoutes || []);
                setIsStressTesting(Boolean(data.isStressTesting));
                setStressReport(data.stressReport || null);
                setLedgerError(data.ledgerError || '');
                setGatewayError('');
            } catch (error) {
                setGatewayError(`Gateway unavailable. Retrying automatically. ${error.message}`);
            }
        };
        fetchState();
        const interval = setInterval(fetchState, 1500);
        return () => clearInterval(interval);
    }, []);

    const fetchAuditLogs = async (offset = 0) => {
        setLogsLoading(true);
        setLogsError('');
        try {
            const res = await apiGet(`/api/logs?limit=100&offset=${offset}`);
            if (!res.ok) throw new Error(`Audit history request failed (${res.status})`);
            const data = await res.json();
            setLiveLogs((current) => offset === 0 ? (data.logs || []) : [...current, ...(data.logs || [])]);
            setLogTotal(data.total || 0);
        } catch (error) {
            setLogsError(error.message);
        } finally {
            setLogsLoading(false);
        }
    };

    useEffect(() => {
        if (view === 'overview' || view === 'logs') fetchAuditLogs();
    }, [view]);

    useEffect(() => {
        if (prevStressTesting.current && !isStressTesting && stressReport) setIsStressModalOpen(true);
        prevStressTesting.current = isStressTesting;
    }, [isStressTesting, stressReport]);

    useEffect(() => {
        if (!isMobileMenuOpen) return undefined;
        const closeOnEscape = (event) => event.key === 'Escape' && setIsMobileMenuOpen(false);
        document.addEventListener('keydown', closeOnEscape);
        return () => document.removeEventListener('keydown', closeOnEscape);
    }, [isMobileMenuOpen]);

    useEffect(() => {
        if (!chartRef.current || isStressTesting || !tpsData.length || view !== 'overview') return undefined;
        chartInstance.current?.destroy();
        chartInstance.current = new Chart(chartRef.current.getContext('2d'), {
            type: 'line',
            data: {
                labels: tpsData.map((point) => point.time),
                datasets: [{
                    data: tpsData.map((point) => point.tps),
                    borderColor: '#adceff',
                    borderWidth: 2,
                    pointBackgroundColor: '#0a0f17',
                    pointBorderColor: '#3131ff',
                    pointBorderWidth: 2,
                    pointRadius: 2,
                    pointHoverRadius: 4,
                    fill: false,
                    tension: 0.25,
                }],
            },
            options: {
                animation: false,
                responsive: true,
                maintainAspectRatio: false,
                interaction: { intersect: false, mode: 'index' },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: '#171d26',
                        titleColor: '#e3eaf6',
                        bodyColor: '#a8b2c0',
                        borderColor: '#545e6e',
                        borderWidth: 1,
                        cornerRadius: 8,
                        padding: 10,
                        displayColors: false,
                        titleFont: { family: 'IBM Plex Sans', size: 12, weight: '600' },
                        bodyFont: { family: 'IBM Plex Mono', size: 11 },
                    },
                },
                scales: {
                    x: {
                        grid: { display: false },
                        border: { display: false },
                        ticks: { color: '#8892a1', maxTicksLimit: 6, font: { family: 'IBM Plex Mono', size: 10 } },
                    },
                    y: {
                        beginAtZero: true,
                        grid: { color: '#253041' },
                        border: { display: false },
                        ticks: { color: '#8892a1', precision: 0, font: { family: 'IBM Plex Mono', size: 10 } },
                    },
                },
            },
        });
        return () => {
            chartInstance.current?.destroy();
            chartInstance.current = null;
        };
    }, [tpsData, isStressTesting, view]);

    const switchRoute = async (route) => {
        if (!enabledRoutes.includes(route) || routeSwitching) return;
        setRouteSwitching(route);
        setActionError('');
        try {
            const res = await apiPost('/api/route', { route });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Route switch failed');
            setActiveRoute(data.activeRoute);
            setActiveBackend(data.activeBackend);
        } catch (error) {
            setActionError(error.message);
        } finally {
            setRouteSwitching('');
        }
    };

    const toggleDeviceStatus = async (deviceId) => {
        setDeviceUpdating(deviceId);
        setActionError('');
        try {
            const res = await apiPost('/api/devices/toggle', { deviceId });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Could not update device status');
            setDevices(data.devices || []);
        } catch (error) {
            setActionError(error.message);
        } finally {
            setDeviceUpdating('');
        }
    };

    const handleAddDevice = async (event) => {
        event.preventDefault();
        if (!newDeviceId.trim() || !newDeviceKey.trim()) return;
        setRegistering(true);
        setActionError('');
        try {
            const res = await apiPost('/api/devices/register', { id: newDeviceId, publicKey: newDeviceKey });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Registration failed');
            setDevices(data.devices || []);
            setNewDeviceId('');
            setNewDeviceKey('');
            setIsAddDeviceModalOpen(false);
        } catch (error) {
            setActionError(error.message);
        } finally {
            setRegistering(false);
        }
    };

    const runStressTest = async () => {
        setActionError('');
        try {
            const res = await apiPost('/api/stress', { isStressTesting: true });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Could not start throughput test');
            setIsStressTesting(true);
        } catch (error) {
            setActionError(error.message);
        }
    };

    const selectView = (nextView) => {
        setView(nextView);
        setIsMobileMenuOpen(false);
        setActionError('');
    };

    const renderNav = () => (
        <nav className="primary-nav" aria-label="Primary navigation">
            {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
                <button
                    type="button"
                    key={id}
                    className={view === id ? 'primary-nav__item primary-nav__item--active' : 'primary-nav__item'}
                    onClick={() => selectView(id)}
                    aria-current={view === id ? 'page' : undefined}
                >
                    <Icon aria-hidden="true" />
                    <span>{label}</span>
                </button>
            ))}
        </nav>
    );

    const renderDeviceRows = (limit) => {
        const rows = typeof limit === 'number' ? devices.slice(0, limit) : devices;
        if (!rows.length) return <EmptyState icon={Cpu} title="No devices registered" detail="Register a device to establish its ledger identity." />;
        return (
            <div className={`device-list ${typeof limit === 'number' ? '' : 'device-list--full'}`}>
                {typeof limit !== 'number' && <div className="device-list__head"><span>Device</span><span>Public identity key</span><span>Status</span><span>Action</span></div>}
                {rows.map((device) => (
                    <div className="device-row" key={device.id}>
                        <div className="device-row__identity">
                            <span className={`presence-dot presence-dot--${device.status === 'ACTIVE' ? 'positive' : 'negative'}`} />
                            <div><strong>{device.id}</strong><small>Ledger identity</small></div>
                        </div>
                        <code title={device.key}>{device.key}</code>
                        <StatusBadge status={device.status} />
                        {!limit && (
                            <button
                                type="button"
                                className={device.status === 'ACTIVE' ? 'button button--danger-subtle button--small' : 'button button--secondary button--small'}
                                onClick={() => toggleDeviceStatus(device.id)}
                                disabled={deviceUpdating === device.id}
                            >
                                {deviceUpdating === device.id && <LoaderCircle className="spin" />}
                                {device.status === 'ACTIVE' ? 'Revoke' : 'Activate'}
                            </button>
                        )}
                    </div>
                ))}
            </div>
        );
    };

    const renderLogRows = (limit) => {
        const rows = typeof limit === 'number' ? liveLogs.slice(0, limit) : liveLogs;
        if (!rows.length && !logsLoading) return <tr className="empty-row"><td colSpan="7"><EmptyState icon={FileClock} title="No requests recorded" detail="Signed device requests will appear here as they arrive." /></td></tr>;
        return rows.map((log) => (
            <tr key={log.id}>
                <td data-label="Request"><code title={log.id}>{log.id}</code></td>
                <td data-label="Device"><strong>{log.deviceId}</strong></td>
                <td data-label="Endpoint"><code>{log.endpoint}</code></td>
                <td data-label="Route"><span className="route-label">{log.route}</span></td>
                <td data-label="Decision"><StatusBadge status={log.status} /></td>
                <td data-label="Signature"><code>{log.hash}</code></td>
                {!limit && <td data-label="Recorded"><time>{log.createdAt ? new Date(log.createdAt).toLocaleString() : 'Current session'}</time></td>}
            </tr>
        ));
    };

    return (
        <div className="app-shell">
            <aside className="sidebar" inert={hasOpenModal ? '' : undefined}>
                <Brand />
                {renderNav()}
                <div className="sidebar__route">
                    <span className="section-label">Request routing</span>
                    <RouteRail
                        activeRoute={activeRoute}
                        activeBackend={activeBackend}
                        enabledRoutes={enabledRoutes}
                        switching={routeSwitching}
                        onSwitch={switchRoute}
                    />
                </div>
                <footer className="sidebar__footer">
                    <div className="connection-state">
                        <span className={`presence-dot presence-dot--${gatewayError ? 'negative' : isLiveLedger ? 'positive' : 'warning'}`} />
                        <div>
                            <strong>{gatewayError ? 'Gateway offline' : isFallback ? 'Fallback active' : isLiveLedger ? 'Ledger connected' : `${activeBackend} mode`}</strong>
                            <span>{gatewayError ? 'Connection retrying' : isFallback ? `${activeRoute} unavailable` : `${activeBackend} is authoritative`}</span>
                        </div>
                    </div>
                    <button className="button button--quiet button--full" type="button" onClick={() => supabase.auth.signOut()}>
                        <LogOut /> Sign out
                    </button>
                </footer>
            </aside>

            <header className="mobile-header" inert={isMobileMenuOpen || hasOpenModal ? '' : undefined}>
                <Brand compact />
                <button className="icon-button" type="button" onClick={() => setIsMobileMenuOpen(true)} aria-label="Open navigation">
                    <Menu />
                </button>
            </header>

            {isMobileMenuOpen && (
                <div className="mobile-drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setIsMobileMenuOpen(false)}>
                    <aside className="mobile-drawer" role="dialog" aria-modal="true" aria-label="Navigation menu">
                        <div className="mobile-drawer__header"><Brand /><button className="icon-button" type="button" onClick={() => setIsMobileMenuOpen(false)} aria-label="Close navigation" autoFocus><X /></button></div>
                        {renderNav()}
                        <div className="mobile-drawer__route">
                            <span className="section-label">Request routing</span>
                            <RouteRail activeRoute={activeRoute} activeBackend={activeBackend} enabledRoutes={enabledRoutes} switching={routeSwitching} onSwitch={(route) => { switchRoute(route); setIsMobileMenuOpen(false); }} />
                        </div>
                        <button className="button button--secondary button--full" type="button" onClick={() => supabase.auth.signOut()}><LogOut /> Sign out</button>
                    </aside>
                </div>
            )}

            <main className="main-content" inert={isMobileMenuOpen || hasOpenModal ? '' : undefined}>
                <header className="page-header">
                    <div>
                        <span className="eyebrow">Identity access management</span>
                        <h1>{currentView?.label}</h1>
                        <p>{view === 'overview' ? 'Monitor trust decisions across your connected ledgers.' : view === 'devices' ? 'Manage registered identities and their access state.' : 'Review durable access decisions and routing history.'}</p>
                    </div>
                    {view === 'overview' && (
                        <button className="button button--primary" type="button" onClick={runStressTest} disabled={isStressTesting}>
                            {isStressTesting ? <LoaderCircle className="spin" /> : <Play />}
                            {isStressTesting ? 'Test running' : 'Run throughput test'}
                        </button>
                    )}
                    {view === 'devices' && (
                        <button className="button button--primary" type="button" onClick={() => setIsAddDeviceModalOpen(true)}>
                            <Plus /> Register device
                        </button>
                    )}
                    {view === 'logs' && (
                        <button className="button button--secondary" type="button" onClick={() => fetchAuditLogs()} disabled={logsLoading}>
                            <RefreshCw className={logsLoading ? 'spin' : ''} /> Refresh
                        </button>
                    )}
                </header>

                {(gatewayError || actionError) && (
                    <div className="notice notice--error" role="alert">
                        <AlertCircle />
                        <div><strong>{gatewayError ? 'Gateway connection lost' : 'Action could not be completed'}</strong><span>{gatewayError || actionError}</span></div>
                        {actionError && <button className="icon-button" type="button" onClick={() => setActionError('')} aria-label="Dismiss error"><X /></button>}
                    </div>
                )}

                {!gatewayError && (!isLiveLedger || ledgerError) && (
                    <div className={`notice ${ledgerError ? 'notice--error' : 'notice--warning'}`} role="status">
                        <AlertCircle />
                        <div>
                            <strong>{isFallback ? `${activeRoute} unavailable, using ${activeBackend}` : `Running in ${activeBackend} mode`}</strong>
                            <span>{ledgerError || 'Enable Fabric or IOTA on the gateway to use a distributed ledger.'}</span>
                        </div>
                    </div>
                )}

                {view === 'overview' && (
                    <div className="view-stack view-enter">
                        <section className="metrics-grid" aria-label="System metrics">
                            <article className="metric-card"><Server /><span>Authoritative backend</span><strong>{activeBackend === 'IOTA' ? 'IOTA Tangle' : activeBackend}</strong><small>{isFallback ? `${activeRoute} selected; fallback active` : 'Serving identity reads'}</small></article>
                            <article className="metric-card"><CircleGauge /><span>Peak throughput</span><strong>{peakTps} <em>TPS</em></strong><small>Current observation window</small></article>
                            <article className="metric-card"><ShieldCheck /><span>Active identities</span><strong>{activeDevices} <em>of {devices.length}</em></strong><small>{devices.length - activeDevices} currently revoked</small></article>
                        </section>

                        <section className="panel throughput-panel">
                            <header className="panel__header">
                                <div><span className="section-label">Throughput</span><h2>Request activity</h2></div>
                                <div className="live-indicator"><span className="presence-dot presence-dot--positive" /> Live TPS</div>
                            </header>
                            <div className="chart-wrap">
                                {isStressTesting ? <div className="loading-block"><LoaderCircle className="spin" /><span>Measuring incoming traffic</span></div> : tpsData.length ? <canvas ref={chartRef} role="img" aria-label="Requests per second over time" /> : <EmptyState icon={Activity} title="No throughput data" detail="Traffic measurements will appear when requests arrive." />}
                            </div>
                        </section>

                        <div className="overview-grid">
                            <section className="panel compact-panel">
                                <header className="panel__header"><div><span className="section-label">Registry</span><h2>Device identities</h2></div><button className="text-button" type="button" onClick={() => selectView('devices')}>View all <ArrowRight /></button></header>
                                {renderDeviceRows(3)}
                            </section>
                            <section className="panel compact-panel">
                                <header className="panel__header"><div><span className="section-label">Audit trail</span><h2>Recent decisions</h2></div><button className="text-button" type="button" onClick={() => selectView('logs')}>View log <ArrowRight /></button></header>
                                {liveLogs.length ? (
                                    <div className="recent-list">
                                        {liveLogs.slice(0, 3).map((log) => (
                                            <div className="recent-row" key={log.id}>
                                                <div><strong>{log.deviceId}</strong><small title={log.id}>{log.endpoint} · {log.id}</small></div>
                                                <div className="recent-row__meta"><span className="route-label">{log.route}</span><StatusBadge status={log.status} /></div>
                                            </div>
                                        ))}
                                    </div>
                                ) : logsLoading ? (
                                    <div className="loading-row"><LoaderCircle className="spin" /> Loading recent decisions</div>
                                ) : (
                                    <EmptyState icon={FileClock} title="No requests recorded" detail="Signed device requests will appear here as they arrive." />
                                )}
                            </section>
                        </div>
                    </div>
                )}

                {view === 'devices' && (
                    <section className="panel view-enter">
                        <header className="panel__header panel__header--bordered">
                            <div><span className="section-label">Ledger registry</span><h2>{devices.length} registered {devices.length === 1 ? 'identity' : 'identities'}</h2></div>
                            <span className="panel__meta">Backend: {activeBackend}</span>
                        </header>
                        {renderDeviceRows()}
                    </section>
                )}

                {view === 'logs' && (
                    <section className="panel view-enter">
                        <header className="panel__header panel__header--bordered">
                            <div><span className="section-label">Durable audit trail</span><h2>{logTotal.toLocaleString()} recorded decisions</h2></div>
                            <div className="panel__meta-group"><span>Selected: {activeRoute}</span><span>Backend: {activeBackend}</span></div>
                        </header>
                        {logsError && <div className="inline-error" role="alert"><AlertCircle /> {logsError}</div>}
                        <div className="table-wrap">
                            <table className="data-table data-table--logs">
                                <thead><tr><th>Request ID</th><th>Device</th><th>Endpoint</th><th>Route</th><th>Decision</th><th>Signature</th><th>Recorded</th></tr></thead>
                                <tbody>{renderLogRows()}</tbody>
                            </table>
                        </div>
                        {logsLoading && !liveLogs.length && <div className="loading-row"><LoaderCircle className="spin" /> Loading audit history</div>}
                        {liveLogs.length < logTotal && (
                            <div className="panel__footer"><button className="button button--secondary" type="button" onClick={() => fetchAuditLogs(liveLogs.length)} disabled={logsLoading}>{logsLoading && <LoaderCircle className="spin" />}Load more <span>{liveLogs.length.toLocaleString()} / {logTotal.toLocaleString()}</span></button></div>
                        )}
                    </section>
                )}
            </main>

            {isAddDeviceModalOpen && (
                <Modal title="Register device" eyebrow="New ledger identity" onClose={() => !registering && setIsAddDeviceModalOpen(false)}>
                    <form onSubmit={handleAddDevice} className="form-stack">
                        <label className="field"><span>Device ID</span><input type="text" value={newDeviceId} onChange={(event) => setNewDeviceId(event.target.value)} placeholder="SmartLock_FrontDoor" minLength={3} maxLength={64} autoFocus required /><small>3–64 letters, numbers, underscores, or hyphens.</small></label>
                        <label className="field"><span>Public key (P-256 PEM)</span><textarea value={newDeviceKey} onChange={(event) => setNewDeviceKey(event.target.value)} placeholder={'-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----'} rows={6} required /><small>Paste the complete SPKI public key created during provisioning.</small></label>
                        {actionError && <div className="inline-error" role="alert"><AlertCircle /> {actionError}</div>}
                        <div className="modal__actions"><button className="button button--secondary" type="button" onClick={() => setIsAddDeviceModalOpen(false)} disabled={registering}>Cancel</button><button className="button button--primary" type="submit" disabled={registering}>{registering && <LoaderCircle className="spin" />}{registering ? 'Registering' : 'Register device'}</button></div>
                    </form>
                </Modal>
            )}

            {isStressModalOpen && stressReport && (
                <Modal title="Throughput report" eyebrow="Measurement complete" onClose={() => setIsStressModalOpen(false)} size="wide">
                    <div className="report-summary"><ShieldCheck /><div><strong>{stressReport.totalRequests} requests measured</strong><span>Observation window: {(stressReport.durationMs / 1000).toFixed(2)} seconds</span></div></div>
                    <div className="report-grid"><article><span>Peak throughput</span><strong>{stressReport.peakTps} TPS</strong></article><article><span>2xx response rate</span><strong>{stressReport.successRate.toFixed(2)}%</strong></article><article><span>Average latency</span><strong>{stressReport.averageLatencyMs.toFixed(2)} ms</strong></article><article><span>P95 latency</span><strong>{stressReport.p95LatencyMs.toFixed(2)} ms</strong></article></div>
                    <div className="report-detail"><div><span>Successful requests</span><strong>{stressReport.successfulRequests}</strong></div><div><span>Non-2xx responses</span><strong>{stressReport.failedRequests}</strong></div>{stressReport.routes.map((route) => <div key={route.route}><span>{route.route}</span><strong>{route.requests} requests · {route.averageLatencyMs.toFixed(2)} ms avg</strong></div>)}</div>
                    <div className="modal__actions"><button className="button button--primary" type="button" onClick={() => setIsStressModalOpen(false)}>Close report</button></div>
                </Modal>
            )}
        </div>
    );
}
