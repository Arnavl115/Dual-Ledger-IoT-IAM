import React, { useState } from 'react';
import { ShieldCheck, Lock, Mail, Eye, EyeOff, ArrowRight, Loader2 } from 'lucide-react';
import { supabase } from './lib/supabase';

export default function Login() {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const handleLogin = async (e) => {
        e.preventDefault();
        if (!email || !password) {
            setError('Enter your email and password.');
            return;
        }

        setLoading(true);
        setError('');

        const { error: authError } = await supabase.auth.signInWithPassword({
            email: email.trim(),
            password,
        });

        setLoading(false);

        if (authError) {
            setError(
                authError.message === 'Invalid login credentials'
                    ? 'Invalid email or password.'
                    : authError.message
            );
        }
    };

    return (
        <div className="min-h-screen bg-black text-neutral-100 flex items-center justify-center p-4 font-sans">
            <div className="w-full max-w-sm">
                {/* Header */}
                <div className="flex items-center gap-3 mb-8 justify-center">
                    <div className="w-9 h-9 border border-white flex items-center justify-center text-white font-black text-sm">
                        G
                    </div>
                    <div>
                        <div className="text-[9px] font-bold tracking-[0.2em] text-neutral-500 uppercase">SYSTEM GATEWAY</div>
                        <div className="text-white font-black tracking-tighter text-lg uppercase">IAM // DUAL-LEDGER</div>
                    </div>
                </div>

                {/* Glass Card */}
                <div className="bg-[#0a0a0a] border border-[#1e1e1e] hover:border-[#333333] transition-luxury p-8">
                    <div className="flex items-center gap-2 mb-2">
                        <ShieldCheck className="w-4 h-4 text-emerald-400" />
                        <span className="text-[9px] font-bold tracking-[0.2em] text-neutral-500 uppercase">AUTHORIZED ACCESS</span>
                    </div>
                    <h1 className="text-2xl font-black tracking-tighter text-white uppercase mb-1">
                        ADMIN LOGIN
                    </h1>
                    <p className="text-[10px] font-mono text-neutral-500 mb-6 tracking-wider">
                        AUTHENTICATE TO CONSOLE // SECURE
                    </p>

                    <form onSubmit={handleLogin} className="space-y-4">
                        <div>
                            <label className="block text-[9px] font-bold tracking-[0.2em] text-neutral-500 uppercase mb-1.5">
                                Email
                            </label>
                            <div className="relative">
                                <Mail className="w-3.5 h-3.5 text-neutral-600 absolute left-3 top-1/2 -translate-y-1/2" />
                                <input
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    placeholder="admin@example.com"
                                    autoComplete="email"
                                    className="w-full bg-black border border-[#1e1e1e] text-white pl-9 pr-3 py-3 text-xs tracking-wider focus:outline-none focus:border-white transition-luxury"
                                    required
                                />
                            </div>
                        </div>

                        <div>
                            <label className="block text-[9px] font-bold tracking-[0.2em] text-neutral-500 uppercase mb-1.5">
                                Password
                            </label>
                            <div className="relative">
                                <Lock className="w-3.5 h-3.5 text-neutral-600 absolute left-3 top-1/2 -translate-y-1/2" />
                                <input
                                    type={showPassword ? 'text' : 'password'}
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    placeholder="••••••••••"
                                    autoComplete="current-password"
                                    className="w-full bg-black border border-[#1e1e1e] text-white pl-9 pr-9 py-3 text-xs tracking-wider focus:outline-none focus:border-white transition-luxury"
                                    required
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowPassword((v) => !v)}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-600 hover:text-white transition-luxury"
                                    aria-label="Toggle password visibility"
                                >
                                    {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                                </button>
                            </div>
                        </div>

                        {error && (
                            <div className="p-3 border border-rose-950 bg-rose-950/10 text-rose-400 text-[10px] font-bold tracking-wider uppercase">
                                {error}
                            </div>
                        )}

                        <button
                            type="submit"
                            disabled={loading}
                            className={`w-full py-3 flex items-center justify-center gap-2 text-[10px] font-bold tracking-[0.2em] uppercase transition-luxury rounded-full border ${
                                loading
                                    ? 'bg-transparent text-neutral-600 border-[#1e1e1e] cursor-not-allowed'
                                    : 'bg-white text-black border-white hover:bg-black hover:text-white hover:border-white'
                            }`}
                        >
                            {loading ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                                <>
                                    AUTHENTICATE
                                    <ArrowRight className="w-3.5 h-3.5" />
                                </>
                            )}
                        </button>
                    </form>
                </div>

                <div className="text-center mt-6 text-[8px] font-mono text-neutral-600 uppercase tracking-[0.2em]">
                    Secured by Supabase Auth
                </div>
            </div>
        </div>
    );
}
