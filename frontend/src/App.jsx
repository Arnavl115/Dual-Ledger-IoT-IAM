import React, { useEffect, useState } from 'react';
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
            <div className="min-h-screen bg-black flex items-center justify-center">
                <div className="text-[10px] font-bold tracking-[0.3em] text-neutral-500 uppercase">
                    INITIALIZING SECURE SESSION...
                </div>
            </div>
        );
    }

    // Route protection: unauthenticated users see the Login page.
    return session ? <AdminDashboard /> : <Login />;
}

export default App;
