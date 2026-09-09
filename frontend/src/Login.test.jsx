import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Login from './Login';

const { signInWithPassword } = vi.hoisted(() => ({ signInWithPassword: vi.fn() }));

vi.mock('./lib/supabase', () => ({
    supabase: { auth: { signInWithPassword } },
}));

afterEach(() => {
    cleanup();
    signInWithPassword.mockReset();
});

describe('Login', () => {
    it('validates required credentials and submits normalized values', async () => {
        render(<Login />);
        const form = screen.getByRole('button', { name: 'Sign in securely' }).closest('form');

        fireEvent.submit(form);
        expect(screen.getByRole('alert').textContent).toContain('Enter your email and password.');
        expect(signInWithPassword).not.toHaveBeenCalled();

        signInWithPassword.mockResolvedValue({ error: null });
        fireEvent.change(screen.getByLabelText('Email address'), { target: { value: ' admin@example.com ' } });
        fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-value' } });
        fireEvent.submit(form);

        await waitFor(() => expect(signInWithPassword).toHaveBeenCalledWith({
            email: 'admin@example.com',
            password: 'secret-value',
        }));
    });
});
