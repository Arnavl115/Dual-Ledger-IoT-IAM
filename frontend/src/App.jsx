import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import AdminDashboard from './AdminDashboard';
import Login from './Login';
import { supabase } from './lib/supabase';

function App() {
    const [session, setSession] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        // Load the existing session on mount
        supabase.auth.getSession().then(({ data: { session } }) => {
            setSession(session);
            setLoading(false);
        });

        // Keep session state in sync (login, logout, token refresh)
        const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session);
            setLoading(false);
        });

        return () => {
            authListener?.subscription.unsubscribe();
        };
    }, []);

    if (loading) {
        return (
            <div className="session-loading" role="status" aria-live="polite">
                <LoaderCircle className="spin" />
                <div>
                    <strong>Dual Ledger IoT IAM</strong>
                    <span>Restoring secure session</span>
                </div>
            </div>
        );
    }

    // Route protection: unauthenticated users see the Login page.
    return session ? <AdminDashboard /> : <Login />;
}

export default App;
