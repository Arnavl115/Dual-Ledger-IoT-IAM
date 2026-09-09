-- Keep this migration to one statement so PostgreSQL can build without blocking audit writes.
create index concurrently if not exists access_logs_status_created_at_idx
    on public.access_logs (status, created_at desc, request_id desc);
