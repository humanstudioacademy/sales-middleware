drop function public.claim_integration_jobs(text, integer);

create function public.claim_integration_jobs(
  p_destination text,
  p_batch_size integer default 1,
  p_source_platform text default null
)
returns table (
  destination text,
  message_id bigint,
  attempt_number bigint,
  enqueued_at timestamptz,
  lease_until timestamptz,
  webhook_id uuid,
  ingest_sequence bigint,
  source text,
  received_at timestamptz,
  received_at_epoch_ms bigint,
  source_platform text,
  source_event_type text,
  scheduled_for timestamptz,
  processing_started_at timestamptz,
  source_event_id text,
  body_sha256 text,
  body_json jsonb,
  body_is_json boolean,
  encrypted_envelope_base64 text,
  encryption_iv_base64 text,
  encryption_algorithm text,
  encryption_key_version integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  configured public.integration_destinations%rowtype;
  claimed_message_id bigint;
  claimed_attempt_number bigint;
  claimed_enqueued_at timestamptz;
  claimed_lease_until timestamptz;
  claimed_message jsonb;
  attempt_started_at timestamptz;
  scheduled_at timestamptz;
begin
  if p_batch_size is null or p_batch_size < 1 then
    raise exception 'Batch size must be positive';
  end if;

  if p_source_platform is not null and length(btrim(p_source_platform)) = 0 then
    raise exception 'Source platform must not be blank';
  end if;

  select *
  into configured
  from public.integration_destinations
  where integration_destinations.destination = p_destination;

  if not found then
    raise exception 'Unknown integration destination';
  end if;

  if not configured.dispatch_enabled then
    return;
  end if;

  -- Preserve strict ordering inside the selected platform while allowing an
  -- intentionally paused platform (Hotmart) to remain untouched in the same queue.
  execute format(
    $claim$
      with head as (
        select queue.msg_id
        from pgmq.%I as queue
        join public.webhook_inbox as inbox
          on inbox.id = (queue.message ->> 'webhook_id')::uuid
        where $2 is null or lower(inbox.source_platform) = lower($2)
        order by inbox.ingest_sequence, queue.msg_id
        limit 1
      )
      update pgmq.%I as queue
      set
        vt = clock_timestamp() + make_interval(secs => $1),
        read_ct = queue.read_ct + 1
      from head
      where queue.msg_id = head.msg_id
        and queue.vt <= clock_timestamp()
      returning queue.msg_id, queue.read_ct, queue.enqueued_at, queue.vt, queue.message
    $claim$,
    'q_' || configured.queue_name,
    'q_' || configured.queue_name
  )
  using configured.visibility_timeout_seconds, p_source_platform
  into
    claimed_message_id,
    claimed_attempt_number,
    claimed_enqueued_at,
    claimed_lease_until,
    claimed_message;

  if claimed_message_id is null then
    return;
  end if;

  select state.next_attempt_at
  into scheduled_at
  from public.integration_processing_state as state
  where state.destination = p_destination
    and state.message_id = claimed_message_id;

  attempt_started_at := clock_timestamp();

  update public.integration_processing_state as state
  set
    status = 'processing',
    processing_started_at = attempt_started_at,
    attempt_count = claimed_attempt_number,
    updated_at = attempt_started_at
  where state.destination = p_destination
    and state.message_id = claimed_message_id;

  return query
  select
    p_destination,
    claimed_message_id,
    claimed_attempt_number,
    claimed_enqueued_at,
    claimed_lease_until,
    inbox.id,
    inbox.ingest_sequence,
    inbox.source,
    inbox.received_at,
    inbox.received_at_epoch_ms,
    inbox.source_platform,
    inbox.source_event_type,
    scheduled_at,
    attempt_started_at,
    inbox.source_event_id,
    inbox.body_sha256,
    inbox.body_json,
    inbox.body_is_json,
    inbox.encrypted_envelope_base64,
    inbox.encryption_iv_base64,
    inbox.encryption_algorithm,
    inbox.encryption_key_version
  from public.webhook_inbox as inbox
  where inbox.id = (claimed_message ->> 'webhook_id')::uuid;
end;
$$;

revoke all on function public.claim_integration_jobs(text, integer, text)
  from public, anon, authenticated;
grant execute on function public.claim_integration_jobs(text, integer, text)
  to service_role;
