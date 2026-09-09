-- ============================================================
-- IoT IAM Gateway - final Supabase schema snapshot
-- Apply supabase/migrations in version order for deployments.
-- This file documents the resulting schema for new environments.
-- ============================================================

create table public.devices (
    id          text primary key,
    public_key  text not null,
    status      text not null default 'ACTIVE'
                constraint devices_status_check check (status in ('ACTIVE', 'REVOKED')),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    constraint devices_timestamps_check check (
        created_at not in ('infinity'::timestamptz, '-infinity'::timestamptz)
        and updated_at not in ('infinity'::timestamptz, '-infinity'::timestamptz)
        and updated_at >= created_at
    )
);

create table public.access_logs (
    request_id  text primary key,
    device_id   text not null,
    endpoint    text not null,
    status      text not null
                constraint access_logs_status_check check (status in ('GRANTED', 'DENIED', 'REVOKED', 'REGISTERED')),
    route       text not null
                constraint access_logs_route_check check (route in ('FABRIC', 'IOTA', 'POSTGRES', 'MEMORY', 'GATEWAY', 'FABRIC+IOTA')),
    hash        text not null,
    created_at  timestamptz not null default now(),
    constraint access_logs_required_fields_check check (
        length(btrim(request_id)) > 0
        and length(btrim(device_id)) > 0
        and length(btrim(endpoint)) > 0
        and length(btrim(hash)) > 0
    ),
    constraint access_logs_timestamp_check check (
        created_at not in ('infinity'::timestamptz, '-infinity'::timestamptz)
    )
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

create trigger devices_set_updated_at
before update on public.devices
for each row execute function public.set_updated_at();

alter table public.devices enable row level security;
alter table public.access_logs enable row level security;

create index access_logs_created_at_idx
    on public.access_logs (created_at desc, request_id desc);
create index access_logs_device_created_at_idx
    on public.access_logs (device_id, created_at desc, request_id desc);
create index access_logs_status_created_at_idx
    on public.access_logs (status, created_at desc, request_id desc);
