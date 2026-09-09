-- Initial tracked schema. Supabase records this version in its migration history.
create table if not exists public.devices (
    id          text primary key,
    public_key  text not null,
    status      text not null default 'ACTIVE',
    created_at  timestamptz not null default now()
);

create table if not exists public.access_logs (
    request_id  text primary key,
    device_id   text,
    endpoint    text,
    status      text,
    route       text,
    hash        text,
    created_at  timestamptz not null default now()
);

alter table public.devices enable row level security;
alter table public.access_logs enable row level security;

create index if not exists access_logs_created_at_idx
    on public.access_logs (created_at desc, request_id desc);
create index if not exists access_logs_device_idx on public.access_logs (device_id);
create index if not exists access_logs_status_idx on public.access_logs (status);
