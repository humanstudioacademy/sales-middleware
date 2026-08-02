begin;

alter table public.conta_azul_deferred_events
  add column status text not null default 'pending',
  add column next_attempt_at timestamptz,
  add column resolved_at timestamptz,
  add constraint conta_azul_deferred_events_status
    check (status in ('pending', 'processing', 'resolved', 'ignored', 'failed'));

create index conta_azul_deferred_events_status_idx
  on public.conta_azul_deferred_events (status, ingest_sequence)
  where status in ('pending', 'failed');

commit;
