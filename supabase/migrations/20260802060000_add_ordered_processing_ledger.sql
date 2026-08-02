begin;

-- O relógio registra quando ocorreu; a sequência define inequivocamente a
-- ordem durável de entrada mesmo quando várias requisições chegam no mesmo ms.
create sequence public.webhook_ingest_sequence_seq as bigint;

alter table public.webhook_inbox
  add column ingest_sequence bigint,
  add column received_at_epoch_ms bigint,
  add column source_platform text,
  add column source_event_type text;

with ordered as (
  select
    inbox.id,
    row_number() over (order by inbox.received_at, inbox.id)::bigint as ingest_sequence
  from public.webhook_inbox as inbox
)
update public.webhook_inbox as inbox
set
  ingest_sequence = ordered.ingest_sequence,
  received_at_epoch_ms = floor(extract(epoch from inbox.received_at) * 1000)::bigint,
  source_platform = coalesce(inbox.sanitized_query_params #>> '{platform,0}', inbox.source),
  source_event_type = inbox.sanitized_query_params #>> '{event,0}'
from ordered
where ordered.id = inbox.id;

create or replace function normalize_webhook_routing_metadata()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.received_at_epoch_ms := floor(extract(epoch from new.received_at) * 1000)::bigint;
  new.source_platform := coalesce(
    nullif(btrim(new.source_platform), ''),
    nullif(btrim(new.sanitized_query_params #>> '{platform,0}'), ''),
    new.source
  );
  new.source_event_type := coalesce(
    nullif(btrim(new.source_event_type), ''),
    nullif(btrim(new.sanitized_query_params #>> '{event,0}'), '')
  );
  return new;
end;
$$;

revoke all on function normalize_webhook_routing_metadata() from public, anon, authenticated;

create trigger normalize_webhook_routing_metadata_before_insert
before insert on public.webhook_inbox
for each row execute function normalize_webhook_routing_metadata();

select setval(
  'public.webhook_ingest_sequence_seq',
  greatest(coalesce((select max(ingest_sequence) from public.webhook_inbox), 0), 1),
  coalesce((select max(ingest_sequence) from public.webhook_inbox), 0) > 0
);

alter table public.webhook_inbox
  alter column ingest_sequence set default nextval('public.webhook_ingest_sequence_seq'),
  alter column ingest_sequence set not null,
  alter column received_at_epoch_ms set not null,
  alter column source_platform set not null;

alter table public.webhook_inbox
  add constraint webhook_inbox_source_platform_not_blank
    check (source_platform is null or length(btrim(source_platform)) > 0),
  add constraint webhook_inbox_source_event_type_not_blank
    check (source_event_type is null or length(btrim(source_event_type)) > 0);

alter sequence public.webhook_ingest_sequence_seq
  owned by public.webhook_inbox.ingest_sequence;

comment on column public.webhook_inbox.ingest_sequence is
  'Global durable ingestion order. Gaps are allowed; values are never reused.';
comment on column public.webhook_inbox.received_at_epoch_ms is
  'Ingress timestamp expressed as Unix epoch milliseconds for integrations.';
comment on column public.webhook_inbox.source_platform is
  'Materialized first platform query parameter for indexed routing; full query remains encrypted.';
comment on column public.webhook_inbox.source_event_type is
  'Materialized first event query parameter for indexed routing; full query remains encrypted.';

create index webhook_inbox_ingest_sequence_idx
  on public.webhook_inbox (ingest_sequence);
create index webhook_inbox_platform_event_sequence_idx
  on public.webhook_inbox (source_platform, source_event_type, ingest_sequence);

revoke all on sequence public.webhook_ingest_sequence_seq from public, anon, authenticated;
grant usage, select on sequence public.webhook_ingest_sequence_seq to service_role;

create table public.integration_processing_state (
  destination text not null references public.integration_destinations(destination),
  webhook_id uuid not null references public.webhook_inbox(id),
  message_id bigint not null,
  ingest_sequence bigint not null,
  status text not null default 'pending',
  enqueued_at timestamptz not null,
  next_attempt_at timestamptz not null,
  processing_started_at timestamptz,
  last_attempt_finished_at timestamptz,
  completed_at timestamptz,
  attempt_count integer not null default 0,
  last_http_status integer,
  last_error_code text,
  last_error_message text,
  updated_at timestamptz not null default clock_timestamp(),

  primary key (destination, webhook_id),
  unique (destination, message_id),
  unique (destination, ingest_sequence),
  constraint integration_processing_state_status
    check (status in ('pending', 'processing', 'retry_wait', 'succeeded', 'dead_letter')),
  constraint integration_processing_state_attempts_nonnegative
    check (attempt_count >= 0),
  constraint integration_processing_state_http_status
    check (last_http_status is null or last_http_status between 100 and 599),
  constraint integration_processing_state_completion
    check (
      (status in ('succeeded', 'dead_letter') and completed_at is not null)
      or (status not in ('succeeded', 'dead_letter') and completed_at is null)
    )
);

comment on table public.integration_processing_state is
  'Current per-destination lifecycle state. Attempt history remains append-only in integration_attempts.';
comment on column public.integration_processing_state.next_attempt_at is
  'Exact scheduled eligibility time for the next delivery attempt.';

create index integration_processing_state_schedule_idx
  on public.integration_processing_state (destination, status, next_attempt_at, ingest_sequence);
create index integration_processing_state_webhook_idx
  on public.integration_processing_state (webhook_id, destination);

alter table public.integration_processing_state enable row level security;
revoke all on table public.integration_processing_state from anon, authenticated, service_role;
grant select, insert, update on table public.integration_processing_state to service_role;

-- Backfill active queue messages created before this ledger existed.
insert into public.integration_processing_state (
  destination, webhook_id, message_id, ingest_sequence, status,
  enqueued_at, next_attempt_at, attempt_count
)
select
  'conta_azul',
  inbox.id,
  queue.msg_id,
  inbox.ingest_sequence,
  case when queue.read_ct > 0 and queue.vt > clock_timestamp() then 'retry_wait' else 'pending' end,
  queue.enqueued_at,
  queue.vt,
  queue.read_ct
from pgmq.q_sales_conta_azul as queue
join public.webhook_inbox as inbox
  on inbox.id = (queue.message ->> 'webhook_id')::uuid;

insert into public.integration_processing_state (
  destination, webhook_id, message_id, ingest_sequence, status,
  enqueued_at, next_attempt_at, attempt_count
)
select
  'human_os',
  inbox.id,
  queue.msg_id,
  inbox.ingest_sequence,
  case when queue.read_ct > 0 and queue.vt > clock_timestamp() then 'retry_wait' else 'pending' end,
  queue.enqueued_at,
  queue.vt,
  queue.read_ct
from pgmq.q_sales_human_os as queue
join public.webhook_inbox as inbox
  on inbox.id = (queue.message ->> 'webhook_id')::uuid;

-- Backfill messages that were already archived as success/dead-letter.
insert into public.integration_processing_state (
  destination, webhook_id, message_id, ingest_sequence, status,
  enqueued_at, next_attempt_at, last_attempt_finished_at, completed_at,
  attempt_count, last_http_status, last_error_code, last_error_message
)
select
  delivery.destination,
  delivery.webhook_id,
  delivery.message_id,
  inbox.ingest_sequence,
  delivery.outcome,
  inbox.received_at,
  delivery.completed_at,
  delivery.completed_at,
  delivery.completed_at,
  delivery.attempts,
  delivery.last_http_status,
  delivery.last_error_code,
  delivery.last_error_message
from public.integration_deliveries as delivery
join public.webhook_inbox as inbox on inbox.id = delivery.webhook_id
on conflict (destination, webhook_id) do update
set
  status = excluded.status,
  last_attempt_finished_at = excluded.last_attempt_finished_at,
  completed_at = excluded.completed_at,
  attempt_count = excluded.attempt_count,
  last_http_status = excluded.last_http_status,
  last_error_code = excluded.last_error_code,
  last_error_message = excluded.last_error_message,
  updated_at = clock_timestamp();

create or replace function enqueue_webhook_for_integrations()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  destination record;
  queued_message_id bigint;
begin
  update public.ingest_counters
  set
    event_count = event_count + 1,
    updated_at = clock_timestamp()
  where shard = (get_byte(uuid_send(new.id), 0) % 64)::smallint;

  for destination in
    select configured.destination, configured.queue_name
    from public.integration_destinations as configured
    where configured.enqueue_enabled
    order by configured.destination
  loop
    select sent.message_id
    into queued_message_id
    from pgmq.send(
      destination.queue_name,
      jsonb_build_object(
        'schema_version', 2,
        'destination', destination.destination,
        'webhook_id', new.id,
        'ingest_sequence', new.ingest_sequence,
        'source', new.source,
        'received_at', new.received_at,
        'received_at_epoch_ms', new.received_at_epoch_ms,
        'source_platform', new.source_platform,
        'source_event_type', new.source_event_type,
        'source_event_id', new.source_event_id,
        'body_sha256', new.body_sha256
      ),
      0
    ) as sent(message_id);

    insert into public.integration_processing_state (
      destination,
      webhook_id,
      message_id,
      ingest_sequence,
      status,
      enqueued_at,
      next_attempt_at
    ) values (
      destination.destination,
      new.id,
      queued_message_id,
      new.ingest_sequence,
      'pending',
      new.received_at,
      new.received_at
    );
  end loop;

  return new;
end;
$$;

revoke all on function enqueue_webhook_for_integrations() from public, anon, authenticated;

drop function public.claim_integration_jobs(text, integer);

create function claim_integration_jobs(
  p_destination text,
  p_batch_size integer default 1
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

  -- Claim only the globally oldest active item. If it is waiting for retry,
  -- nothing newer may pass it. This is deliberate head-of-line blocking.
  execute format(
    $claim$
      with head as (
        select queue.msg_id
        from pgmq.%I as queue
        join public.webhook_inbox as inbox
          on inbox.id = (queue.message ->> 'webhook_id')::uuid
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
  using configured.visibility_timeout_seconds
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

revoke all on function claim_integration_jobs(text, integer) from public, anon, authenticated;
grant execute on function claim_integration_jobs(text, integer) to service_role;

create or replace function sync_processing_state_after_attempt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.integration_processing_state as state
  set
    status = case new.outcome
      when 'succeeded' then 'succeeded'
      when 'dead_letter' then 'dead_letter'
      else 'retry_wait'
    end,
    last_attempt_finished_at = new.finished_at,
    completed_at = case
      when new.outcome in ('succeeded', 'dead_letter') then new.finished_at
      else null
    end,
    attempt_count = greatest(state.attempt_count, new.attempt_number),
    last_http_status = new.http_status,
    last_error_code = new.error_code,
    last_error_message = new.error_message,
    updated_at = new.finished_at
  where state.destination = new.destination
    and state.message_id = new.message_id;

  return new;
end;
$$;

revoke all on function sync_processing_state_after_attempt() from public, anon, authenticated;

create trigger sync_processing_state_after_attempt_insert
after insert on public.integration_attempts
for each row execute function sync_processing_state_after_attempt();

create or replace function fail_integration_job(
  p_destination text,
  p_message_id bigint,
  p_webhook_id uuid,
  p_attempt_number integer,
  p_started_at timestamptz,
  p_http_status integer default null,
  p_error_code text default null,
  p_error_message text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  configured public.integration_destinations%rowtype;
  retry_delay integer;
  retry_at timestamptz;
  archived boolean;
  inserted_count integer;
begin
  select *
  into configured
  from public.integration_destinations
  where integration_destinations.destination = p_destination;

  if not found then
    raise exception 'Unknown integration destination';
  end if;

  if p_attempt_number >= configured.max_attempts then
    insert into public.integration_attempts (
      destination, message_id, webhook_id, attempt_number, outcome,
      started_at, http_status, error_code, error_message
    ) values (
      p_destination, p_message_id, p_webhook_id, p_attempt_number, 'dead_letter',
      p_started_at, p_http_status, left(p_error_code, 200), left(p_error_message, 2000)
    );

    insert into public.integration_deliveries (
      destination, message_id, webhook_id, outcome, attempts,
      last_http_status, last_error_code, last_error_message
    ) values (
      p_destination, p_message_id, p_webhook_id, 'dead_letter', p_attempt_number,
      p_http_status, left(p_error_code, 200), left(p_error_message, 2000)
    )
    on conflict (destination, message_id) do nothing;

    get diagnostics inserted_count = row_count;

    if inserted_count = 1 then
      update public.integration_delivery_counters
      set
        dead_letter_count = dead_letter_count + 1,
        updated_at = clock_timestamp()
      where destination = p_destination
        and shard = (get_byte(uuid_send(p_webhook_id), 0) % 64)::smallint;
    end if;

    archived := pgmq.archive(configured.queue_name, p_message_id);
    if not archived then
      raise exception 'Queue message was not found or was already archived';
    end if;

    return 'dead_letter';
  end if;

  retry_delay := least(3600, (5 * power(2, least(p_attempt_number - 1, 10)))::integer)
    + floor(random() * 5)::integer;
  retry_at := clock_timestamp() + make_interval(secs => retry_delay);

  insert into public.integration_attempts (
    destination, message_id, webhook_id, attempt_number, outcome,
    started_at, http_status, error_code, error_message
  ) values (
    p_destination, p_message_id, p_webhook_id, p_attempt_number, 'retry_scheduled',
    p_started_at, p_http_status, left(p_error_code, 200), left(p_error_message, 2000)
  );

  perform pgmq.set_vt(configured.queue_name, p_message_id, retry_delay);

  update public.integration_processing_state as state
  set
    status = 'retry_wait',
    next_attempt_at = retry_at,
    processing_started_at = null,
    updated_at = clock_timestamp()
  where state.destination = p_destination
    and state.message_id = p_message_id;

  return 'retry_scheduled';
end;
$$;

revoke all on function fail_integration_job(text, bigint, uuid, integer, timestamptz, integer, text, text)
  from public, anon, authenticated;
grant execute on function fail_integration_job(text, bigint, uuid, integer, timestamptz, integer, text, text)
  to service_role;

create or replace function middleware_queue_status(p_recent_limit integer default 20)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  destination record;
  metric record;
  available_count bigint;
  leased_count bigint;
  succeeded_count bigint;
  dead_letter_count bigint;
  processing_count bigint;
  retry_wait_count bigint;
  next_scheduled_at timestamptz;
  oldest_ingest_sequence bigint;
  queues jsonb := '[]'::jsonb;
  inbox_total bigint;
  inbox_last_minute bigint;
  inbox_last_five_minutes bigint;
  latest_ingest_sequence bigint;
  recent_results jsonb;
begin
  select coalesce(sum(counter.event_count), 0)
  into inbox_total
  from public.ingest_counters as counter;

  select
    count(*) filter (where received_at >= clock_timestamp() - interval '1 minute'),
    count(*) filter (where received_at >= clock_timestamp() - interval '5 minutes'),
    max(ingest_sequence)
  into inbox_last_minute, inbox_last_five_minutes, latest_ingest_sequence
  from public.webhook_inbox;

  for destination in
    select configured.*
    from public.integration_destinations as configured
    order by configured.destination
  loop
    select * into metric from pgmq.metrics(destination.queue_name);

    execute format(
      'select count(*) filter (where vt <= clock_timestamp()), count(*) filter (where vt > clock_timestamp()) from pgmq.%I',
      'q_' || destination.queue_name
    ) into available_count, leased_count;

    select
      coalesce(sum(counter.succeeded_count), 0),
      coalesce(sum(counter.dead_letter_count), 0)
    into succeeded_count, dead_letter_count
    from public.integration_delivery_counters as counter
    where counter.destination = destination.destination;

    select
      count(*) filter (where state.status = 'processing'),
      count(*) filter (where state.status = 'retry_wait'),
      min(state.next_attempt_at) filter (where state.status in ('pending', 'retry_wait')),
      min(state.ingest_sequence) filter (where state.status not in ('succeeded', 'dead_letter'))
    into processing_count, retry_wait_count, next_scheduled_at, oldest_ingest_sequence
    from public.integration_processing_state as state
    where state.destination = destination.destination;

    queues := queues || jsonb_build_array(jsonb_build_object(
      'destination', destination.destination,
      'enqueue_enabled', destination.enqueue_enabled,
      'dispatch_enabled', destination.dispatch_enabled,
      'pending', available_count,
      'processing', processing_count,
      'retry_wait', retry_wait_count,
      'in_flight_or_retry_wait', leased_count,
      'active_total', metric.queue_length,
      'succeeded', succeeded_count,
      'dead_letter', dead_letter_count,
      'oldest_pending_age_seconds', metric.oldest_msg_age_sec,
      'oldest_ingest_sequence', oldest_ingest_sequence,
      'next_scheduled_at', next_scheduled_at,
      'total_enqueued', metric.total_messages
    ));
  end loop;

  select coalesce(jsonb_agg(to_jsonb(recent) order by recent.completed_at desc), '[]'::jsonb)
  into recent_results
  from (
    select
      delivery.destination,
      delivery.message_id,
      delivery.webhook_id,
      inbox.ingest_sequence,
      inbox.received_at,
      inbox.received_at_epoch_ms,
      inbox.source_platform,
      inbox.source_event_type,
      delivery.outcome,
      delivery.attempts,
      delivery.completed_at,
      delivery.last_http_status,
      delivery.last_error_code
    from public.integration_deliveries as delivery
    join public.webhook_inbox as inbox on inbox.id = delivery.webhook_id
    order by delivery.completed_at desc
    limit least(greatest(p_recent_limit, 0), 100)
  ) as recent;

  return jsonb_build_object(
    'generated_at', clock_timestamp(),
    'ingest', jsonb_build_object(
      'accepted_total', inbox_total,
      'last_minute', inbox_last_minute,
      'last_five_minutes', inbox_last_five_minutes,
      'latest_ingest_sequence', latest_ingest_sequence
    ),
    'queues', queues,
    'recent_results', recent_results
  );
end;
$$;

revoke all on function middleware_queue_status(integer) from public, anon, authenticated;
grant execute on function middleware_queue_status(integer) to service_role;

commit;
