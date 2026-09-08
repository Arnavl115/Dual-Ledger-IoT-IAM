import { useState } from 'react';
import { AlertCircle, ArrowRight, Check, Eye, EyeOff, KeyRound, LoaderCircle, ShieldCheck } from 'lucide-react';
import { supabase } from './lib/supabase';

export default function Login() {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const handleLogin = async (event) => {
        event.preventDefault();
        if (!email.trim() || !password) {
            setError('Enter your email and password.');
            return;
        }
        setLoading(true);
        setError('');
        const { error: authError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (authError) setError(authError.message === 'Invalid login credentials' ? 'The email or password is incorrect.' : authError.message);
        setLoading(false);
    };

    return (
        <main className="login-page">
            <section className="login-context" aria-label="Product information">
                <div className="login-brand"><strong>Dual Ledger IoT IAM</strong></div>
                <div className="login-context__copy">
                    <span className="eyebrow">Dual-ledger identity control</span>
                    <h1>One clear view of every trusted device.</h1>
                    <p>Authorize signed edge requests against Hyperledger Fabric or IOTA from a single operational console.</p>
                </div>
                <ul className="trust-list">
                    <li><Check /> P-256 signed device requests</li>
                    <li><Check /> Authoritative on-ledger identity state</li>
                    <li><Check /> Durable access decision history</li>
                </ul>
            </section>

            <section className="login-panel">
                <div className="login-card">
                    <div className="login-card__icon"><ShieldCheck /></div>
                    <span className="eyebrow">Administrator access</span>
                    <h2>Sign in to the console</h2>
                    <p>Use your authorized Supabase administrator account.</p>
                    <form onSubmit={handleLogin} className="form-stack" aria-describedby={error ? 'login-error' : undefined}>
                        <div className="field"><label htmlFor="login-email">Email address</label><input id="login-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="admin@example.com" autoComplete="email" autoFocus required aria-invalid={Boolean(error)} /></div>
                        <div className="field"><label htmlFor="login-password">Password</label><div className="password-field"><KeyRound aria-hidden="true" /><input id="login-password" type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" autoComplete="current-password" required aria-invalid={Boolean(error)} /><button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}</button></div></div>
                        {error && <div id="login-error" className="inline-error" role="alert" aria-live="assertive"><AlertCircle aria-hidden="true" /> {error}</div>}
                        <button className="button button--primary button--full" type="submit" disabled={loading}>{loading ? <LoaderCircle className="spin" /> : <ArrowRight />}{loading ? 'Signing in' : 'Sign in securely'}</button>
                    </form>
                    <div className="login-card__footer"><ShieldCheck /> Authentication managed by Supabase</div>
                </div>
            </section>
        </main>
    );
}
