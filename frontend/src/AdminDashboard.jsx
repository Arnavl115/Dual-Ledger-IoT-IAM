import React, { useState, useEffect, useRef } from 'react';
import {
    ShieldCheck,
    Activity,
    Cpu,
    Database,
    Zap,
    Play,
    Server,
    PlusCircle,
    Menu,
    X,
    ArrowRight
} from 'lucide-react';
import { Chart, registerables } from 'chart.js';

Chart.register(...registerables);

export default function AdminDashboard() {
    // Navigation State
    const [view, setView] = useState('overview');
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

    // Modals State
    const [isStressModalOpen, setIsStressModalOpen] = useState(false);
    const [isAddDeviceModalOpen, setIsAddDeviceModalOpen] = useState(false);

    // Form State
    const [newDeviceId, setNewDeviceId] = useState('');
    const [newDeviceKey, setNewDeviceKey] = useState('');

    // State synced with backend API
    const [activeRoute, setActiveRoute] = useState('FABRIC');
    const [isStressTesting, setIsStressTesting] = useState(false);
    const [devices, setDevices] = useState([]);
    const [liveLogs, setLiveLogs] = useState([]);
    const [tpsData, setTpsData] = useState([]);
    const [ledgerMode, setLedgerMode] = useState('MOCK');
    const [ledgerError, setLedgerError] = useState(null);

    const chartRef = useRef(null);
    const chartInstance = useRef(null);
    const prevStressTesting = useRef(false);

    // Dynamic state polling from API Gateway
    useEffect(() => {
        const fetchState = async () => {
            try {
                const res = await fetch('http://localhost:3000/api/state');
                if (res.ok) {
                    const data = await res.json();
                    setDevices(data.devices || []);
                    setLiveLogs(data.logs || []);
                    setTpsData(data.tpsData || []);
                    setActiveRoute(data.activeRoute || 'FABRIC');
                    setIsStressTesting(data.isStressTesting || false);
                    setLedgerMode(data.ledgerMode || 'MOCK');
                    setLedgerError(data.ledgerError || null);
                }
            } catch (err) {
                console.warn("Gateway backend offline. Retrying connection...", err.message);
            }
        };

        fetchState();
        const interval = setInterval(fetchState, 1000);
        return () => clearInterval(interval);
    }, []);

    // Listen to stress test transitions (true -> false) to trigger report modal
    useEffect(() => {
        if (prevStressTesting.current && !isStressTesting) {
            setIsStressModalOpen(true);
        }
        prevStressTesting.current = isStressTesting;
    }, [isStressTesting]);

    // Backend route switch handler
    const switchRoute = async (route) => {
        try {
            const res = await fetch('http://localhost:3000/api/route', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ route })
            });
            if (res.ok) {
                const data = await res.json();
                setActiveRoute(data.activeRoute);
            }
        } catch (err) {
            console.error("Error switching route:", err);
        }
    };

    // Backend device status toggle
    const toggleDeviceStatus = async (deviceId) => {
        try {
            const res = await fetch('http://localhost:3000/api/devices/toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deviceId })
            });
            if (res.ok) {
                const data = await res.json();
                setDevices(data.devices);
            }
        } catch (err) {
            console.error("Error toggling device status:", err);
        }
    };

    // Backend device registration
    const handleAddDevice = async (e) => {
        e.preventDefault();
        if (!newDeviceId || !newDeviceKey) return;
        try {
            const res = await fetch('http://localhost:3000/api/devices/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: newDeviceId, key: newDeviceKey })
            });
            if (res.ok) {
                const data = await res.json();
                setDevices(data.devices);
                setNewDeviceId('');
                setNewDeviceKey('');
                setIsAddDeviceModalOpen(false);
            }
        } catch (err) {
            console.error("Error registering device:", err);
        }
    };

    // Backend stress test trigger
    const runStressTest = async () => {
        try {
            const res = await fetch('http://localhost:3000/api/stress', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isStressTesting: true })
            });
            if (res.ok) {
                setIsStressTesting(true);
            }
        } catch (err) {
            console.error("Error starting stress test:", err);
        }
    };

    // Chart.js initialization
    useEffect(() => {
        if (chartRef.current && !isStressTesting && tpsData.length > 0) {
            if (chartInstance.current) {
                chartInstance.current.destroy();
            }

            const ctx = chartRef.current.getContext('2d');
            chartInstance.current = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: tpsData.map(d => d.time),
                    datasets: [{
                        label: 'Throughput (TPS)',
                        data: tpsData.map(d => d.tps),
                        borderColor: '#ffffff',
                        borderWidth: 1.5,
                        pointBackgroundColor: '#ffffff',
                        pointBorderColor: '#000000',
                        pointBorderWidth: 1.5,
                        pointRadius: 3,
                        pointHoverRadius: 5,
                        fill: true,
                        backgroundColor: 'rgba(255, 255, 255, 0.02)',
                        tension: 0.3
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            display: false
                        },
                        tooltip: {
                            backgroundColor: '#0a0a0a',
                            titleColor: '#ffffff',
                            bodyColor: '#ffffff',
                            borderColor: '#1e1e1e',
                            borderWidth: 1,
                            cornerRadius: 0,
                            padding: 8,
                            displayColors: false,
                            titleFont: {
                                family: 'Inter',
                                size: 10,
                                weight: 'bold'
                            },
                            bodyFont: {
                                family: 'Inter',
                                size: 11
                            }
                        }
                    },
                    scales: {
                        x: {
                            grid: {
                                color: '#121212',
                                drawBorder: false
                            },
                            ticks: {
                                color: '#525252',
                                font: {
                                    family: 'Inter',
                                    size: 9,
                                    weight: 'bold'
                                }
                            }
                        },
                        y: {
                            grid: {
                                color: '#121212',
                                drawBorder: false
                            },
                            ticks: {
                                color: '#525252',
                                font: {
                                    family: 'Inter',
                                    size: 9,
                                    weight: 'bold'
                                }
                            }
                        }
                    }
                }
            });
        }

        return () => {
            if (chartInstance.current) {
                chartInstance.current.destroy();
            }
        };
    }, [tpsData, isStressTesting]);

    const renderStatCard = (title, icon, value) => {
        if (isStressTesting) {
            return (
                <div className="bg-[#0a0a0a] border border-[#1e1e1e] p-5 flex flex-col justify-between h-32 transition-luxury">
                    <div className="flex justify-between items-start">
                        <span className="text-[10px] font-bold tracking-[0.2em] text-neutral-500 uppercase">{title}</span>
                        {icon}
                    </div>
                    <div className="h-6 w-2/3 skeleton-pulse"></div>
                </div>
            );
        }
        return (
            <div className="bg-[#0a0a0a] border border-[#1e1e1e] hover:border-[#333333] p-5 flex flex-col justify-between h-32 transition-luxury">
                <div className="flex justify-between items-start">
                    <span className="text-[10px] font-bold tracking-[0.2em] text-neutral-500 uppercase">{title}</span>
                    {icon}
                </div>
                <div className="text-2xl font-black tracking-tighter text-white uppercase">{value}</div>
            </div>
        );
    };

    return (
        <div className="min-h-screen bg-black text-neutral-100 flex flex-col md:flex-row font-sans">
            {/* Desktop Fixed Sidebar Navigation */}
            <aside className="hidden md:flex md:w-64 h-screen fixed top-0 left-0 bg-[#0a0a0a] border-r border-[#1e1e1e] p-6 flex-col z-30 justify-between">
                <div>
                    <div className="flex items-center gap-3 mb-8">
                        <div className="w-7 h-7 border border-white flex items-center justify-center text-white font-black text-xs">
                            G
                        </div>
                        <div>
                            <div className="text-[9px] font-bold tracking-[0.2em] text-neutral-500 uppercase font-sans font-bold">SYSTEM GATEWAY</div>
                            <div className="text-white font-black tracking-tighter text-sm">IAM // DUAL-LEDGER</div>
                        </div>
                    </div>

                    <nav className="flex flex-col gap-4">
                        <button
                            onClick={() => setView('overview')}
                            className={`text-left text-xs font-bold tracking-[0.2em] uppercase transition-luxury py-1.5 border-b ${view === 'overview' ? 'text-white border-white' : 'text-neutral-500 border-transparent hover:text-neutral-300'}`}
                        >
                            OVERVIEW
                        </button>
                        <button
                            onClick={() => setView('devices')}
                            className={`text-left text-xs font-bold tracking-[0.2em] uppercase transition-luxury py-1.5 border-b ${view === 'devices' ? 'text-white border-white' : 'text-neutral-500 border-transparent hover:text-neutral-300'}`}
                        >
                            DEVICES
                        </button>
                        <button
                            onClick={() => setView('logs')}
                            className={`text-left text-xs font-bold tracking-[0.2em] uppercase transition-luxury py-1.5 border-b ${view === 'logs' ? 'text-white border-white' : 'text-neutral-500 border-transparent hover:text-neutral-300'}`}
                        >
                            TRAFFIC
                        </button>
                    </nav>

                    <div className="mt-8">
                        <div className="text-[9px] font-bold tracking-[0.2em] text-neutral-500 uppercase mb-2">ACTIVE ROUTE</div>
                        <div className="flex flex-col gap-1.5">
                            <button
                                onClick={() => switchRoute('FABRIC')}
                                className={`w-full py-2 px-3 text-[10px] font-bold tracking-[0.2em] uppercase transition-luxury flex items-center justify-between border ${activeRoute === 'FABRIC' ? 'bg-white text-black border-white' : 'bg-transparent text-neutral-400 border-[#1e1e1e] hover:border-neutral-500 hover:text-white'}`}
                            >
                                <span>FABRIC</span>
                                <Database className="w-3 h-3" />
                            </button>
                            <button
                                onClick={() => switchRoute('IOTA')}
                                className={`w-full py-2 px-3 text-[10px] font-bold tracking-[0.2em] uppercase transition-luxury flex items-center justify-between border ${activeRoute === 'IOTA' ? 'bg-white text-black border-white' : 'bg-transparent text-neutral-400 border-[#1e1e1e] hover:border-neutral-500 hover:text-white'}`}
                            >
                                <span>IOTA TANGLE</span>
                                <Zap className="w-3 h-3" />
                            </button>
                        </div>
                    </div>
                </div>

                <div className="border-t border-[#1e1e1e] pt-4">
                    <div className="flex items-center gap-2 mb-1">
                        <span className={`w-1.5 h-1.5 rounded-full ${ledgerMode === 'FABRIC' ? 'bg-emerald-500' : ledgerError ? 'bg-rose-500' : 'bg-amber-500'} animate-ping`}></span>
                        <span className="text-[9px] font-bold tracking-[0.2em] text-neutral-400 uppercase ml-1">{ledgerMode === 'FABRIC' ? 'LIVE LEDGER' : ledgerError ? 'LEDGER ERROR' : 'MOCK MODE'}</span>
                    </div>
                    {ledgerMode === 'FABRIC' && (
                        <div className="text-[8px] font-mono text-emerald-500/70">FABRIC CHAINCODE: CONNECTED</div>
                    )}
                    {ledgerMode !== 'FABRIC' && !ledgerError && (
                        <div className="text-[8px] font-mono text-amber-500/70">IN-MEMORY STATE ACTIVE</div>
                    )}
                    {ledgerError && (
                        <div className="text-[8px] font-mono text-rose-500/70">FALLBACK: {ledgerError.slice(0, 40)}</div>
                    )}
                    <div className="text-[8px] font-mono text-neutral-600 mt-1">v4.1.2-alpha</div>
                </div>
            </aside>

            {/* Mobile Header */}
            <header className="md:hidden flex justify-between items-center bg-[#0a0a0a] border-b border-[#1e1e1e] p-4 sticky top-0 z-40">
                <div className="flex items-center gap-2">
                    <div className="w-6 h-6 border border-white flex items-center justify-center text-white font-black text-xs">
                        G
                    </div>
                    <span className="text-white font-black tracking-tighter text-xs uppercase">IAM GATEWAY</span>
                </div>
                <button
                    onClick={() => setIsMobileMenuOpen(true)}
                    className="p-1.5 border border-[#1e1e1e] hover:border-[#333333] transition-luxury bg-[#0a0a0a] text-white"
                >
                    <Menu className="w-3.5 h-3.5" />
                </button>
            </header>

            {/* Mobile Drawer Overlay */}
            {isMobileMenuOpen && (
                <div className="fixed inset-0 z-50 bg-black/98 backdrop-blur-md flex flex-col p-8 md:hidden transition-luxury">
                    <div className="flex justify-between items-center mb-10">
                        <div className="text-[10px] font-bold tracking-[0.2em] text-neutral-500 uppercase">SYSTEM MENU</div>
                        <button
                            onClick={() => setIsMobileMenuOpen(false)}
                            className="p-1.5 border border-[#1e1e1e] bg-[#0a0a0a] text-white hover:border-[#333333] transition-luxury"
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                    </div>
                    <div className="flex flex-col h-full justify-between">
                        <div className="space-y-8">
                            <nav className="flex flex-col gap-4">
                                <button
                                    onClick={() => { setView('overview'); setIsMobileMenuOpen(false); }}
                                    className={`text-left text-xs font-bold tracking-[0.2em] uppercase py-1.5 border-b ${view === 'overview' ? 'text-white border-white' : 'text-neutral-500 border-transparent hover:text-neutral-300'}`}
                                >
                                    OVERVIEW
                                </button>
                                <button
                                    onClick={() => { setView('devices'); setIsMobileMenuOpen(false); }}
                                    className={`text-left text-xs font-bold tracking-[0.2em] uppercase py-1.5 border-b ${view === 'devices' ? 'text-white border-white' : 'text-neutral-500 border-transparent hover:text-neutral-300'}`}
                                >
                                    DEVICES
                                </button>
                                <button
                                    onClick={() => { setView('logs'); setIsMobileMenuOpen(false); }}
                                    className={`text-left text-xs font-bold tracking-[0.2em] uppercase py-1.5 border-b ${view === 'logs' ? 'text-white border-white' : 'text-neutral-500 border-transparent hover:text-neutral-300'}`}
                                >
                                    TRAFFIC
                                </button>
                            </nav>
                            <div>
                                <div className="text-[10px] font-bold tracking-[0.2em] text-neutral-500 uppercase mb-3">ACTIVE ROUTE</div>
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => { switchRoute('FABRIC'); setIsMobileMenuOpen(false); }}
                                        className={`flex-1 py-2 px-3 text-xs font-bold tracking-[0.2em] uppercase flex items-center justify-between border ${activeRoute === 'FABRIC' ? 'bg-white text-black border-white' : 'bg-transparent text-neutral-400 border-[#1e1e1e] hover:border-neutral-500 hover:text-white'}`}
                                    >
                                        <span>FABRIC</span>
                                        <Database className="w-3 h-3" />
                                    </button>
                                    <button
                                        onClick={() => { switchRoute('IOTA'); setIsMobileMenuOpen(false); }}
                                        className={`flex-1 py-2 px-3 text-xs font-bold tracking-[0.2em] uppercase flex items-center justify-between border ${activeRoute === 'IOTA' ? 'bg-white text-black border-white' : 'bg-transparent text-neutral-400 border-[#1e1e1e] hover:border-neutral-500 hover:text-white'}`}
                                    >
                                        <span>IOTA</span>
                                        <Zap className="w-3 h-3" />
                                    </button>
                                </div>
                            </div>
                        </div>
                        <div className="border-t border-[#1e1e1e] pt-4 mt-6">
                            <div className="flex items-center gap-2">
                                <span className={`w-1.5 h-1.5 rounded-full ${ledgerMode === 'FABRIC' ? 'bg-emerald-500' : ledgerError ? 'bg-rose-500' : 'bg-amber-500'}`}></span>
                                <span className="text-[10px] font-bold tracking-[0.2em] text-neutral-400 uppercase">{ledgerMode === 'FABRIC' ? 'LIVE LEDGER' : ledgerError ? 'LEDGER ERROR' : 'MOCK MODE'}</span>
                            </div>
                            {ledgerError && (
                                <div className="text-[8px] font-mono text-rose-500/70 mt-1">FALLBACK: {ledgerError.slice(0, 40)}</div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Main Content Area */}
            <main className="flex-1 md:ml-64 bg-black min-h-screen p-6 md:p-10 overflow-y-auto">
                {view === 'overview' && (
                    <div>
                        <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
                            <div>
                                <span className="text-[10px] font-bold tracking-[0.2em] text-neutral-500 uppercase">CONSOLE // OVERVIEW</span>
                                <h1 className="text-2xl md:text-3xl font-black tracking-tighter text-white uppercase mt-1">
                                    SYSTEM DASHBOARD
                                </h1>
                            </div>
                            <div>
                                <button
                                    onClick={runStressTest}
                                    disabled={isStressTesting}
                                    className={`py-2.5 px-5 text-[10px] font-bold tracking-[0.2em] uppercase transition-luxury flex items-center gap-2 border rounded-full ${isStressTesting ? 'bg-transparent text-neutral-600 border-[#1e1e1e] cursor-not-allowed' : 'bg-white text-black border-white hover:bg-black hover:text-white hover:border-white'}`}
                                >
                                    <Play className="w-3 h-3 fill-current" />
                                    {isStressTesting ? 'TESTING...' : 'RUN STRESS TEST (UC5)'}
                                </button>
                            </div>
                        </div>

                        {/* Ledger Backend Status Banner */}
                        {ledgerMode !== 'FABRIC' && (
                            <div className={`mb-8 p-4 border flex items-center justify-between gap-4 ${ledgerError ? 'border-rose-950 bg-rose-950/10' : 'border-amber-950 bg-amber-950/10'}`}>
                                <div className="flex items-center gap-3">
                                    <Database className={`w-4 h-4 flex-shrink-0 ${ledgerError ? 'text-rose-400' : 'text-amber-400'}`} />
                                    <div>
                                        <div className={`text-[8px] font-bold tracking-[0.2em] uppercase ${ledgerError ? 'text-rose-400' : 'text-amber-400'}`}>
                                            {ledgerError ? 'LEDGER BACKEND ERROR' : 'SIMULATION MODE ACTIVE'}
                                        </div>
                                        <div className="text-xs font-bold text-white tracking-tight uppercase mt-0.5">
                                            {ledgerError
                                                ? `FABRIC NETWORK UNREACHABLE — RUNNING ON MOCK STATE`
                                                : `FABRIC INTEGRATION DISABLED — RUNNING ON IN-MEMORY STATE`}
                                        </div>
                                        {ledgerError && (
                                            <div className="text-[9px] font-mono text-neutral-500 mt-1">REASON: {ledgerError}</div>
                                        )}
                                    </div>
                                </div>
                                {!ledgerError && (
                                    <span className="text-[8px] font-bold tracking-[0.2em] text-neutral-500 uppercase whitespace-nowrap">
                                        SET FABRIC_ENABLED=true ON GATEWAY
                                    </span>
                                )}
                            </div>
                        )}

                        {/* Stat Cards */}
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                            {renderStatCard("01 // Active Ledger", <Server className="w-3.5 h-3.5 text-neutral-400" />, `${activeRoute} // ${ledgerMode}`)}
                            {renderStatCard("02 // Latency (AVG)", <Activity className="w-3.5 h-3.5 text-neutral-400" />, "12.4 ms")}
                            {renderStatCard(
                                "03 // Live Devices",
                                <Cpu className="w-3.5 h-3.5 text-neutral-400" />,
                                devices.length > 0 ? `${devices.filter(d => d.status === 'ACTIVE').length} / ${devices.length}` : "0 / 0"
                            )}
                        </div>

                        {/* Chart Section */}
                        <div className="bg-[#0a0a0a] border border-[#1e1e1e] hover:border-[#333333] transition-luxury p-6 mb-8">
                            <div className="flex justify-between items-center mb-6">
                                <span className="text-[10px] font-bold tracking-[0.2em] text-neutral-500 uppercase">04 // THROUGHPUT ANALYSIS</span>
                                <div className="flex items-center gap-1.5">
                                    <span className="w-1.5 h-1.5 rounded-full bg-white"></span>
                                    <span className="text-[10px] font-bold tracking-[0.2em] text-white uppercase">LIVE TPS</span>
                                </div>
                            </div>
                            <div className="h-48 w-full relative">
                                {isStressTesting ? (
                                    <div className="absolute inset-0 skeleton-pulse"></div>
                                ) : (
                                    <canvas ref={chartRef}></canvas>
                                )}
                            </div>
                        </div>

                        {/* Split Previews */}
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                            {/* Device Preview */}
                            <div className="bg-[#0a0a0a] border border-[#1e1e1e] hover:border-[#333333] transition-luxury p-6 flex flex-col justify-between min-h-[220px]">
                                <div>
                                    <div className="flex justify-between items-center mb-4">
                                        <span className="text-[10px] font-bold tracking-[0.2em] text-neutral-500 uppercase">05 // DEVICE REGISTRY</span>
                                        <button
                                            onClick={() => setView('devices')}
                                            className="text-[10px] font-bold tracking-[0.2em] text-white uppercase hover:text-neutral-400 flex items-center gap-1 transition-luxury"
                                        >
                                            VIEW ALL <ArrowRight className="w-3 h-3" />
                                        </button>
                                    </div>
                                    {isStressTesting ? (
                                        <div className="space-y-3">
                                            <div className="h-10 skeleton-pulse"></div>
                                            <div className="h-10 skeleton-pulse"></div>
                                        </div>
                                    ) : (
                                        <div className="space-y-2">
                                            {devices.slice(0, 3).map(device => (
                                                <div key={device.id} className="flex justify-between items-center py-2.5 border-b border-[#121212] last:border-b-0">
                                                    <div>
                                                        <div className="text-xs font-bold text-white tracking-tight">{device.id}</div>
                                                        <div className="text-[9px] font-mono text-neutral-500 mt-0.5">{device.key}</div>
                                                    </div>
                                                    <span className={`px-2 py-0.5 text-[8px] font-bold tracking-[0.15em] border uppercase ${device.status === 'ACTIVE'
                                                            ? 'text-emerald-400 border-emerald-950 bg-emerald-950/20'
                                                            : 'text-rose-400 border-rose-950 bg-rose-950/20'
                                                        }`}>
                                                        {device.status}
                                                    </span>
                                                </div>
                                            ))}
                                            {devices.length === 0 && (
                                                <div className="text-xs text-neutral-500 py-4 text-center uppercase tracking-wider">NO DEVICES SYNCED</div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Logs Preview */}
                            <div className="bg-[#0a0a0a] border border-[#1e1e1e] hover:border-[#333333] transition-luxury p-6 flex flex-col justify-between min-h-[220px]">
                                <div>
                                    <div className="flex justify-between items-center mb-4">
                                        <span className="text-[10px] font-bold tracking-[0.2em] text-neutral-500 uppercase">06 // SECURITY AUDIT TRAIL</span>
                                        <button
                                            onClick={() => setView('logs')}
                                            className="text-[10px] font-bold tracking-[0.2em] text-white uppercase hover:text-neutral-400 flex items-center gap-1 transition-luxury"
                                        >
                                            VIEW LOGS <ArrowRight className="w-3 h-3" />
                                        </button>
                                    </div>
                                    {isStressTesting ? (
                                        <div className="space-y-3">
                                            <div className="h-10 skeleton-pulse"></div>
                                            <div className="h-10 skeleton-pulse"></div>
                                        </div>
                                    ) : (
                                        <div className="space-y-2">
                                            {liveLogs.slice(0, 3).map(log => (
                                                <div key={log.id} className="flex justify-between items-center py-2.5 border-b border-[#121212] last:border-b-0">
                                                    <div>
                                                        <div className="text-xs font-bold text-white tracking-tight">{log.id} // {log.deviceId}</div>
                                                        <div className="text-[9px] font-mono text-neutral-500 mt-0.5">{log.hash}</div>
                                                    </div>
                                                    <div className="flex items-center gap-3">
                                                        <span className="text-[8px] font-mono text-neutral-400">{log.route}</span>
                                                        <span className={`px-2 py-0.5 text-[8px] font-bold tracking-[0.15em] border uppercase ${log.status === 'GRANTED'
                                                                ? 'text-emerald-400 border-emerald-950 bg-emerald-950/20'
                                                                : log.status === 'REVOKED'
                                                                    ? 'text-rose-400 border-rose-950 bg-rose-950/20'
                                                                    : 'text-amber-400 border-amber-950 bg-amber-950/20'
                                                            }`}>
                                                            {log.status}
                                                        </span>
                                                    </div>
                                                </div>
                                            ))}
                                            {liveLogs.length === 0 && (
                                                <div className="text-xs text-neutral-500 py-4 text-center uppercase tracking-wider">AWAITING REQUEST STREAM</div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {view === 'devices' && (
                    <div>
                        <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
                            <div>
                                <span className="text-[10px] font-bold tracking-[0.2em] text-neutral-500 uppercase">CONSOLE // MANAGEMENT</span>
                                <h1 className="text-2xl md:text-3xl font-black tracking-tighter text-white uppercase mt-1">
                                    DEVICE INVENTORY
                                </h1>
                            </div>
                            <div>
                                <button
                                    onClick={() => setIsAddDeviceModalOpen(true)}
                                    className="py-2.5 px-5 text-[10px] font-bold tracking-[0.2em] uppercase transition-luxury flex items-center gap-2 border border-white bg-white text-black hover:bg-black hover:text-white hover:border-white rounded-full"
                                >
                                    <PlusCircle className="w-3.5 h-3.5" />
                                    REGISTER DEVICE
                                </button>
                            </div>
                        </div>

                        <div className="bg-[#0a0a0a] border border-[#1e1e1e] p-6">
                            {isStressTesting ? (
                                <div className="space-y-4">
                                    <div className="h-12 skeleton-pulse"></div>
                                    <div className="h-12 skeleton-pulse"></div>
                                    <div className="h-12 skeleton-pulse"></div>
                                </div>
                            ) : (
                                <div className="space-y-4 overflow-x-auto">
                                    <div className="min-w-[650px]">
                                        <div className="grid grid-cols-12 text-[10px] font-bold tracking-[0.2em] text-neutral-500 uppercase pb-4 border-b border-[#1e1e1e] mb-2">
                                            <div className="col-span-3">Device ID</div>
                                            <div className="col-span-5">Public Identity Key</div>
                                            <div className="col-span-2">Security Status</div>
                                            <div className="col-span-2 text-right">Actions</div>
                                        </div>
                                        {devices.map((device) => (
                                            <div key={device.id} className="grid grid-cols-12 items-center py-3 border-b border-[#121212] last:border-b-0 hover:border-neutral-700 transition-luxury">
                                                <div className="col-span-3 flex items-center gap-2">
                                                    <div className="w-1.5 h-1.5 rounded-full bg-neutral-700"></div>
                                                    <span className="text-xs font-bold text-white tracking-tight">{device.id}</span>
                                                </div>
                                                <div className="col-span-5 text-xs font-mono text-neutral-400">{device.key}</div>
                                                <div className="col-span-2">
                                                    <span className={`px-2.5 py-1 text-[8px] font-bold tracking-[0.15em] border uppercase ${device.status === 'ACTIVE'
                                                            ? 'text-emerald-400 border-emerald-950 bg-emerald-950/20'
                                                            : 'text-rose-400 border-rose-950 bg-rose-950/20'
                                                        }`}>
                                                        {device.status}
                                                    </span>
                                                </div>
                                                <div className="col-span-2 text-right">
                                                    <button
                                                        onClick={() => toggleDeviceStatus(device.id)}
                                                        className={`py-1.5 px-4 text-[8px] font-bold tracking-[0.2em] uppercase transition-luxury border rounded-full ${device.status === 'ACTIVE'
                                                                ? 'bg-transparent text-rose-400 border-rose-950 hover:bg-rose-950/30'
                                                                : 'bg-transparent text-emerald-400 border-emerald-950 hover:bg-emerald-950/30'
                                                            }`}
                                                    >
                                                        {device.status === 'ACTIVE' ? 'REVOKE' : 'ACTIVATE'}
                                                    </button>
                                                </div>
                                            </div>
                                        ))}
                                        {devices.length === 0 && (
                                            <div className="text-xs text-neutral-500 py-8 text-center uppercase tracking-wider">NO DEVICES SYNCED</div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {view === 'logs' && (
                    <div>
                        <div className="mb-8">
                            <span className="text-[10px] font-bold tracking-[0.2em] text-neutral-500 uppercase">CONSOLE // SECURITY RECORDS</span>
                            <h1 className="text-2xl md:text-3xl font-black tracking-tighter text-white uppercase mt-1">
                                TRAFFIC STREAM
                            </h1>
                        </div>

                        <div className="bg-[#0a0a0a] border border-[#1e1e1e] p-6">
                            <div className="mb-6 flex justify-between items-center">
                                <span className="text-[10px] font-bold tracking-[0.2em] text-neutral-500 uppercase">07 // REAL-TIME IAM ROUTING LEDGER</span>
                                <div className="flex items-center gap-4">
                                    <span className="text-[10px] font-bold tracking-[0.2em] text-neutral-400 uppercase">LEDGER: {activeRoute}</span>
                                    <span className={`text-[10px] font-bold tracking-[0.2em] uppercase ${ledgerMode === 'FABRIC' ? 'text-emerald-400' : ledgerError ? 'text-rose-400' : 'text-amber-400'}`}>
                                        BACKEND: {ledgerMode === 'FABRIC' ? 'FABRIC' : ledgerError ? 'ERROR' : 'MOCK'}
                                    </span>
                                </div>
                            </div>

                            {isStressTesting ? (
                                <div className="space-y-4">
                                    <div className="h-10 skeleton-pulse"></div>
                                    <div className="h-10 skeleton-pulse"></div>
                                    <div className="h-10 skeleton-pulse"></div>
                                    <div className="h-10 skeleton-pulse"></div>
                                </div>
                            ) : (
                                <div className="overflow-x-auto">
                                    <table className="w-full text-left min-w-[750px]">
                                        <thead>
                                            <tr className="border-b border-[#1e1e1e] text-[10px] font-bold tracking-[0.2em] text-neutral-500 uppercase">
                                                <th className="pb-4">Request ID</th>
                                                <th className="pb-4">Device ID</th>
                                                <th className="pb-4">Endpoint</th>
                                                <th className="pb-4">Route Ledger</th>
                                                <th className="pb-4">Status</th>
                                                <th className="pb-4">Transaction Hash</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-[#121212]">
                                            {liveLogs.map((log) => (
                                                <tr key={log.id} className="group hover:bg-[#050505] transition-luxury">
                                                    <td className="py-3 font-mono text-xs text-neutral-400">{log.id}</td>
                                                    <td className="py-3 text-xs font-bold text-white tracking-tight">{log.deviceId}</td>
                                                    <td className="py-3 text-xs font-mono text-neutral-400">{log.endpoint}</td>
                                                    <td className="py-3 text-xs font-bold text-neutral-300">{log.route}</td>
                                                    <td className="py-3">
                                                        <span className={`px-2 py-0.5 text-[8px] font-bold tracking-[0.15em] border uppercase ${log.status === 'GRANTED'
                                                                ? 'text-emerald-400 border-emerald-950 bg-emerald-950/20'
                                                                : log.status === 'REVOKED'
                                                                    ? 'text-rose-400 border-rose-950 bg-rose-950/20'
                                                                    : 'text-amber-400 border-amber-950 bg-amber-950/20'
                                                            }`}>
                                                            {log.status}
                                                        </span>
                                                    </td>
                                                    <td className="py-3 font-mono text-[10px] text-neutral-500 group-hover:text-neutral-300 transition-luxury">{log.hash}</td>
                                                </tr>
                                            ))}
                                            {liveLogs.length === 0 && (
                                                <tr>
                                                    <td colSpan="6" className="text-xs text-neutral-500 py-8 text-center uppercase tracking-wider">AWAITING REQUEST STREAM</td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </main>

            {/* Custom Modal: Add Device */}
            {isAddDeviceModalOpen && (
                <div className="fixed inset-0 z-50 bg-black/98 backdrop-blur-md flex items-center justify-center p-4 transition-luxury">
                    <div className="bg-[#0a0a0a] border border-[#1e1e1e] hover:border-[#333333] transition-luxury p-6 max-w-sm w-full relative">
                        <button
                            onClick={() => setIsAddDeviceModalOpen(false)}
                            className="absolute top-4 right-4 text-neutral-500 hover:text-white transition-luxury p-1 border border-[#1e1e1e] bg-black"
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                        <div className="mb-6">
                            <span className="text-[9px] font-bold tracking-[0.2em] text-neutral-500 uppercase">ADD NEW IDENTITY</span>
                            <h3 className="text-lg font-black tracking-tighter text-white uppercase mt-1">REGISTER DEVICE</h3>
                        </div>
                        <form onSubmit={handleAddDevice} className="space-y-4">
                            <div>
                                <label className="block text-[9px] font-bold tracking-[0.2em] text-neutral-500 uppercase mb-1.5">Device ID</label>
                                <input
                                    type="text"
                                    value={newDeviceId}
                                    onChange={(e) => setNewDeviceId(e.target.value)}
                                    placeholder="DEV_TEMP_04"
                                    className="w-full bg-black border border-[#1e1e1e] text-white p-3 text-xs tracking-wider focus:outline-none focus:border-white transition-luxury uppercase"
                                    required
                                />
                            </div>
                            <div>
                                <label className="block text-[9px] font-bold tracking-[0.2em] text-neutral-500 uppercase mb-1.5">Identity Key (HEX)</label>
                                <input
                                    type="text"
                                    value={newDeviceKey}
                                    onChange={(e) => setNewDeviceKey(e.target.value)}
                                    placeholder="0xAF32...B89C"
                                    className="w-full bg-black border border-[#1e1e1e] text-white p-3 text-xs tracking-wider focus:outline-none focus:border-white transition-luxury"
                                    required
                                />
                            </div>
                            <div className="pt-4 flex gap-3">
                                <button
                                    type="button"
                                    onClick={() => setIsAddDeviceModalOpen(false)}
                                    className="flex-1 py-3 border border-[#1e1e1e] text-[10px] font-bold tracking-[0.2em] uppercase hover:bg-neutral-900 transition-luxury rounded-full"
                                >
                                    CANCEL
                                </button>
                                <button
                                    type="submit"
                                    className="flex-1 py-3 bg-white text-black text-[10px] font-bold tracking-[0.2em] uppercase hover:bg-black hover:text-white hover:border-white border border-transparent transition-luxury rounded-full"
                                >
                                    REGISTER
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Custom Modal: Stress Test Complete Report */}
            {isStressModalOpen && (
                <div className="fixed inset-0 z-50 bg-black/98 backdrop-blur-md flex items-center justify-center p-4 transition-luxury">
                    <div className="bg-[#0a0a0a] border border-[#1e1e1e] hover:border-[#333333] transition-luxury p-8 max-w-lg w-full relative">
                        <button
                            onClick={() => setIsStressModalOpen(false)}
                            className="absolute top-4 right-4 text-neutral-500 hover:text-white transition-luxury p-1 border border-[#1e1e1e] bg-black"
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                        <div className="mb-6">
                            <span className="text-[9px] font-bold tracking-[0.2em] text-neutral-500 uppercase">UC5 // PERFORMANCE REPORT</span>
                            <h3 className="text-xl font-black tracking-tighter text-white uppercase mt-1">STRESS TEST COMPLETE</h3>
                        </div>

                        <div className="space-y-4 mb-6">
                            <div className="p-4 border border-emerald-950 bg-emerald-950/10 text-emerald-400 flex items-center gap-2">
                                <ShieldCheck className="w-4 h-4 flex-shrink-0" />
                                <div>
                                    <div className="text-[8px] font-bold tracking-[0.2em] uppercase">SYSTEM LEVEL</div>
                                    <div className="text-xs font-bold font-mono">GATEWAY STABLE UNDER HIGH LOAD (185 TPS)</div>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div className="border border-[#1e1e1e] p-4">
                                    <span className="text-[9px] font-bold tracking-[0.2em] text-neutral-500 uppercase">PEAK THROUGHPUT</span>
                                    <div className="text-lg font-bold text-white mt-1">185 TPS</div>
                                </div>
                                <div className="border border-[#1e1e1e] p-4">
                                    <span className="text-[9px] font-bold tracking-[0.2em] text-neutral-500 uppercase">CONFIRMATION RATE</span>
                                    <div className="text-lg font-bold text-white mt-1">100.00%</div>
                                </div>
                            </div>

                            <div className="border border-[#1e1e1e] p-4 space-y-2">
                                <span className="text-[9px] font-bold tracking-[0.2em] text-neutral-500 uppercase">ROUTE METRICS</span>
                                <div className="flex justify-between text-xs font-mono">
                                    <span className="text-neutral-400">HYPERLEDGER FABRIC:</span>
                                    <span className="text-white">14.2 MS (AVG LATENCY)</span>
                                </div>
                                <div className="flex justify-between text-xs font-mono">
                                    <span className="text-neutral-400">IOTA TANGLE:</span>
                                    <span className="text-white">8.9 MS (AVG LATENCY)</span>
                                </div>
                            </div>
                        </div>

                        <button
                            onClick={() => setIsStressModalOpen(false)}
                            className="w-full py-3 bg-white text-black text-[10px] font-bold tracking-[0.2em] uppercase hover:bg-black hover:text-white hover:border-white border border-transparent transition-luxury rounded-full"
                        >
                            CLOSE REPORT
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}