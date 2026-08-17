import { getAccessToken } from './supabase';

const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL || 'http://localhost:3000';

// Calls the backend gateway, automatically attaching the Supabase JWT
// as "Authorization: Bearer <token>".
export async function apiFetch(path, options = {}) {
    const token = await getAccessToken();

    const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
    };

    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    return fetch(`${GATEWAY_URL}${path}`, {
        ...options,
        headers,
    });
}

export const apiGet = (path) => apiFetch(path);
export const apiPost = (path, body) =>
    apiFetch(path, {
        method: 'POST',
        body: JSON.stringify(body),
    });
