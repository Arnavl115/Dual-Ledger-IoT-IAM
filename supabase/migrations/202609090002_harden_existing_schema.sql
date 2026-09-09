-- Upgrade databases created from the former unversioned supabase-schema.sql.
alter table public.devices
    add column if not exists updated_at timestamptz;

update public.devices
set created_at = coalesce(created_at, now()),
    updated_at = coalesce(updated_at, created_at, now())
where created_at is null or updated_at is null;

update public.access_logs
set device_id = coalesce(device_id, 'UNKNOWN'),
    endpoint = coalesce(endpoint, '/api/v1/unknown'),
    status = coalesce(status, 'DENIED'),
    route = coalesce(route, 'GATEWAY'),
    hash = coalesce(hash, 'N/A'),
    created_at = coalesce(created_at, now());

alter table public.access_logs drop constraint if exists access_logs_not_null_check;
alter table public.access_logs add constraint access_logs_not_null_check check (
    device_id is not null and endpoint is not null and status is not null
    and route is not null and hash is not null and created_at is not null
) not valid;
alter table public.access_logs validate constraint access_logs_not_null_check;

alter table public.devices
    alter column status set default 'ACTIVE',
    alter column status set not null,
    alter column created_at set default now(),
    alter column created_at set not null,
    alter column updated_at set default now(),
    alter column updated_at set not null;

alter table public.access_logs
    alter column device_id set not null,
    alter column endpoint set not null,
    alter column status set not null,
    alter column route set not null,
    alter column hash set not null,
    alter column created_at set default now(),
    alter column created_at set not null;
alter table public.access_logs drop constraint access_logs_not_null_check;

alter table public.devices drop constraint if exists devices_status_check;
alter table public.devices
    add constraint devices_status_check check (status in ('ACTIVE', 'REVOKED')) not valid;
alter table public.devices validate constraint devices_status_check;

alter table public.devices drop constraint if exists devices_timestamps_check;
alter table public.devices
    add constraint devices_timestamps_check check (
        created_at not in ('infinity'::timestamptz, '-infinity'::timestamptz)
        and updated_at not in ('infinity'::timestamptz, '-infinity'::timestamptz)
        and updated_at >= created_at
    ) not valid;
alter table public.devices validate constraint devices_timestamps_check;

alter table public.access_logs drop constraint if exists access_logs_status_check;
alter table public.access_logs
    add constraint access_logs_status_check check (status in ('GRANTED', 'DENIED', 'REVOKED', 'REGISTERED')) not valid;
alter table public.access_logs validate constraint access_logs_status_check;

alter table public.access_logs drop constraint if exists access_logs_route_check;
alter table public.access_logs
    add constraint access_logs_route_check check (route in ('FABRIC', 'IOTA', 'POSTGRES', 'MEMORY', 'GATEWAY', 'FABRIC+IOTA')) not valid;
alter table public.access_logs validate constraint access_logs_route_check;

alter table public.access_logs drop constraint if exists access_logs_required_fields_check;
alter table public.access_logs
    add constraint access_logs_required_fields_check check (
        request_id is not null and length(btrim(request_id)) > 0
        and device_id is not null and length(btrim(device_id)) > 0
        and endpoint is not null and length(btrim(endpoint)) > 0
        and hash is not null and length(btrim(hash)) > 0
    ) not valid;
alter table public.access_logs validate constraint access_logs_required_fields_check;

alter table public.access_logs drop constraint if exists access_logs_timestamp_check;
alter table public.access_logs
    add constraint access_logs_timestamp_check check (
        created_at not in ('infinity'::timestamptz, '-infinity'::timestamptz)
    ) not valid;
alter table public.access_logs validate constraint access_logs_timestamp_check;

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

drop trigger if exists devices_set_updated_at on public.devices;
create trigger devices_set_updated_at
before update on public.devices
for each row execute function public.set_updated_at();

drop index if exists public.access_logs_device_idx;
drop index if exists public.access_logs_status_idx;
create index if not exists access_logs_created_at_idx
    on public.access_logs (created_at desc, request_id desc);
