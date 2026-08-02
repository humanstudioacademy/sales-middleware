create or replace function middleware_recent_ingress(p_recent_limit integer default 50)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(recent) order by recent.ingest_sequence desc), '[]'::jsonb)
  from (
    select
      inbox.ingest_sequence,
      inbox.received_at,
      inbox.received_at_epoch_ms,
      inbox.source_platform,
      inbox.source_event_type,
      inbox.body_size_bytes,
      inbox.body_is_json,
      inbox.body_json ->> 'status' as source_status
    from public.webhook_inbox as inbox
    order by inbox.ingest_sequence desc
    limit least(greatest(p_recent_limit, 0), 100)
  ) as recent;
$$;

revoke all on function middleware_recent_ingress(integer) from public, anon, authenticated;
grant execute on function middleware_recent_ingress(integer) to service_role;
