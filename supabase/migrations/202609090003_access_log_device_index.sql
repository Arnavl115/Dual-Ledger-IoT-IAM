-- Keep this migration to one statement so PostgreSQL can build without blocking audit writes.
create index concurrently if not exists access_logs_device_created_at_idx
    on public.access_logs (device_id, created_at desc, request_id desc);
