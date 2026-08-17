import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
    console.warn(
        'Supabase credentials missing. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in frontend/.env'
    );
}

export const supabase = createClient(supabaseUrl || 'http://localhost:54321', supabaseAnonKey || 'anon-key');

// Returns the current access token, or null when not logged in.
export async function getAccessToken() {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || null;
}
