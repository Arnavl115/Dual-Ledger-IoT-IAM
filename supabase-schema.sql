-- ============================================================
-- IoT IAM Gateway — Supabase schema
-- Run this in the Supabase Dashboard -> SQL Editor
-- (service_role key bypasses RLS, so no policies are required
--  for backend reads/writes.)
-- ============================================================

-- -------------------------------
-- Devices
-- -------------------------------
create table if not exists public.devices (
    id          text primary key,
    public_key  text not null,
    status      text not null default 'ACTIVE',
    created_at  timestamptz not null default now()
);

alter table public.devices enable row level security;

-- -------------------------------
-- Access logs
-- -------------------------------
create table if not exists public.access_logs (
    request_id  text primary key,
    device_id   text,
    endpoint    text,
    status      text,
    route       text,
    hash        text,
    created_at  timestamptz not null default now()
);

alter table public.access_logs enable row level security;

-- Useful index for querying logs by device / status
create index if not exists access_logs_device_idx on public.access_logs (device_id);
create index if not exists access_logs_status_idx on public.access_logs (status);
