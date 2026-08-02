begin;

create extension if not exists pgmq;

select pgmq.create('sales_conta_azul');
select pgmq.create('sales_human_os');

create table public.integration_destinations (
  destination text primary key,
  queue_name text not null unique,
  enqueue_enabled boolean not null default true,
  dispatch_enabled boolean not null default false,
  visibility_timeout_seconds integer not null default 60,
  max_attempts integer not null default 15,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),

  constraint integration_destinations_destination_format
    check (destination ~ '^[a-z][a-z0-9_]*$'),
  constraint integration_destinations_queue_format
    check (queue_name ~ '^[a-z][a-z0-9_]*$'),
  constraint integration_destinations_visibility_range
    check (visibility_timeout_seconds between 10 and 3600),
  constraint integration_destinations_attempts_range
    check (max_attempts between 1 and 100)
);

insert into public.integration_destinations (
  destination,
  queue_name,
  enqueue_enabled,
  dispatch_enabled
)
values
  ('conta_azul', 'sales_conta_azul', true, false),
  ('human_os', 'sales_human_os', true, false);

-- Contadores exatos sem COUNT(*) em tabelas que podem crescer dezenas de
-- milhoes de linhas. Os shards evitam uma unica linha quente a 200 eventos/s.
create table public.ingest_counters (
  shard smallint primary key,
  event_count bigint not null default 0,
  updated_at timestamptz not null default clock_timestamp(),
  constraint ingest_counters_shard_range check (shard between 0 and 63),
  constraint ingest_counters_nonnegative check (event_count >= 0)
);

insert into public.ingest_counters (shard)
select generate_series(0, 63)::smallint;

create table public.integration_delivery_counters (
  destination text not null references public.integration_destinations(destination),
  shard smallint not null,
  succeeded_count bigint not null default 0,
  dead_letter_count bigint not null default 0,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (destination, shard),
  constraint integration_delivery_counters_shard_range check (shard between 0 and 63),
  constraint integration_delivery_counters_succeeded_nonnegative check (succeeded_count >= 0),
  constraint integration_delivery_counters_dead_nonnegative check (dead_letter_count >= 0)
);

insert into public.integration_delivery_counters (destination, shard)
select destination.destination, shard.number::smallint
from public.integration_destinations as destination
cross join generate_series(0, 63) as shard(number);

create table public.integration_deliveries (
  destination text not null references public.integration_destinations(destination),
  message_id bigint not null,
  webhook_id uuid not null references public.webhook_inbox(id),
  outcome text not null,
  attempts integer not null,
  completed_at timestamptz not null default clock_timestamp(),
  last_http_status integer,
  last_error_code text,
  last_error_message text,

  primary key (destination, message_id),
  unique (destination, webhook_id),
  constraint integration_deliveries_outcome
    check (outcome in ('succeeded', 'dead_letter')),
  constraint integration_deliveries_attempts_positive
    check (attempts > 0),
  constraint integration_deliveries_http_status
    check (last_http_status is null or last_http_status between 100 and 599)
);

create index integration_deliveries_completed_at_idx
  on public.integration_deliveries (completed_at desc);
create index integration_deliveries_outcome_completed_idx
  on public.integration_deliveries (outcome, completed_at desc);
create index integration_deliveries_webhook_idx
  on public.integration_deliveries (webhook_id);

create table public.integration_attempts (
  id bigint generated always as identity primary key,
  destination text not null references public.integration_destinations(destination),
  message_id bigint not null,
  webhook_id uuid not null references public.webhook_inbox(id),
  attempt_number integer not null,
  outcome text not null,
  started_at timestamptz not null,
  finished_at timestamptz not null default clock_timestamp(),
  http_status integer,
  error_code text,
  error_message text,

  constraint integration_attempts_attempt_positive
    check (attempt_number > 0),
  constraint integration_attempts_outcome
    check (outcome in ('succeeded', 'retry_scheduled', 'dead_letter')),
  constraint integration_attempts_time_order
    check (finished_at >= started_at),
  constraint integration_attempts_http_status
    check (http_status is null or http_status between 100 and 599)
);

create index integration_attempts_message_idx
  on public.integration_attempts (destination, message_id, attempt_number desc);
create index integration_attempts_webhook_idx
  on public.integration_attempts (webhook_id, finished_at desc);

alter table public.integration_destinations enable row level security;
alter table public.ingest_counters enable row level security;
alter table public.integration_delivery_counters enable row level security;
alter table public.integration_deliveries enable row level security;
alter table public.integration_attempts enable row level security;

revoke all on table public.integration_destinations from anon, authenticated, service_role;
revoke all on table public.ingest_counters from anon, authenticated, service_role;
revoke all on table public.integration_delivery_counters from anon, authenticated, service_role;
revoke all on table public.integration_deliveries from anon, authenticated, service_role;
revoke all on table public.integration_attempts from anon, authenticated, service_role;
revoke all on sequence public.integration_attempts_id_seq from anon, authenticated, service_role;

create or replace function private_queue_name(p_destination text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select destination.queue_name
  from public.integration_destinations as destination
  where destination.destination = p_destination;
$$;

revoke all on function private_queue_name(text) from public, anon, authenticated;

create or replace function enqueue_webhook_for_integrations()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  destination record;
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
    perform pgmq.send(
      destination.queue_name,
      jsonb_build_object(
        'schema_version', 1,
        'destination', destination.destination,
        'webhook_id', new.id,
        'source', new.source,
        'received_at', new.received_at,
        'source_event_id', new.source_event_id,
        'body_sha256', new.body_sha256
      ),
      0
    );
  end loop;

  return new;
end;
$$;

revoke all on function enqueue_webhook_for_integrations() from public, anon, authenticated;

create trigger enqueue_webhook_after_insert
after insert on public.webhook_inbox
for each row execute function enqueue_webhook_for_integrations();

create or replace function claim_integration_jobs(
  p_destination text,
  p_batch_size integer default 100
)
returns table (
  destination text,
  message_id bigint,
  attempt_number bigint,
  enqueued_at timestamptz,
  lease_until timestamptz,
  webhook_id uuid,
  source text,
  received_at timestamptz,
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
begin
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

  return query
  select
    p_destination,
    message.msg_id,
    message.read_ct::bigint,
    message.enqueued_at,
    message.vt,
    inbox.id,
    inbox.source,
    inbox.received_at,
    inbox.source_event_id,
    inbox.body_sha256,
    inbox.body_json,
    inbox.body_is_json,
    inbox.encrypted_envelope_base64,
    inbox.encryption_iv_base64,
    inbox.encryption_algorithm,
    inbox.encryption_key_version
  from pgmq.read(
    configured.queue_name,
    configured.visibility_timeout_seconds,
    least(greatest(p_batch_size, 1), 500)
  ) as message
  join public.webhook_inbox as inbox
    on inbox.id = (message.message ->> 'webhook_id')::uuid;
end;
$$;

revoke all on function claim_integration_jobs(text, integer) from public, anon, authenticated;
grant execute on function claim_integration_jobs(text, integer) to service_role;

create or replace function complete_integration_job(
  p_destination text,
  p_message_id bigint,
  p_webhook_id uuid,
  p_attempt_number integer,
  p_started_at timestamptz,
  p_http_status integer default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  queue_name text;
  archived boolean;
  inserted_count integer;
begin
  queue_name := public.private_queue_name(p_destination);
  if queue_name is null then
    raise exception 'Unknown integration destination';
  end if;

  insert into public.integration_attempts (
    destination,
    message_id,
    webhook_id,
    attempt_number,
    outcome,
    started_at,
    http_status
  ) values (
    p_destination,
    p_message_id,
    p_webhook_id,
    p_attempt_number,
    'succeeded',
    p_started_at,
    p_http_status
  );

  insert into public.integration_deliveries (
    destination,
    message_id,
    webhook_id,
    outcome,
    attempts,
    last_http_status
  ) values (
    p_destination,
    p_message_id,
    p_webhook_id,
    'succeeded',
    p_attempt_number,
    p_http_status
  )
  on conflict (destination, message_id) do nothing;

  get diagnostics inserted_count = row_count;

  if inserted_count = 1 then
    update public.integration_delivery_counters
    set
      succeeded_count = succeeded_count + 1,
      updated_at = clock_timestamp()
    where destination = p_destination
      and shard = (get_byte(uuid_send(p_webhook_id), 0) % 64)::smallint;
  end if;

  archived := pgmq.archive(queue_name, p_message_id);
  if not archived then
    raise exception 'Queue message was not found or was already archived';
  end if;

  return true;
end;
$$;

revoke all on function complete_integration_job(text, bigint, uuid, integer, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function complete_integration_job(text, bigint, uuid, integer, timestamptz, integer)
  to service_role;

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

  insert into public.integration_attempts (
    destination, message_id, webhook_id, attempt_number, outcome,
    started_at, http_status, error_code, error_message
  ) values (
    p_destination, p_message_id, p_webhook_id, p_attempt_number, 'retry_scheduled',
    p_started_at, p_http_status, left(p_error_code, 200), left(p_error_message, 2000)
  );

  perform pgmq.set_vt(configured.queue_name, p_message_id, retry_delay);
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
  queues jsonb := '[]'::jsonb;
  inbox_total bigint;
  inbox_last_minute bigint;
  inbox_last_five_minutes bigint;
  recent_results jsonb;
begin
  select coalesce(sum(counter.event_count), 0)
  into inbox_total
  from public.ingest_counters as counter;

  select
    count(*) filter (where received_at >= clock_timestamp() - interval '1 minute'),
    count(*) filter (where received_at >= clock_timestamp() - interval '5 minutes')
  into inbox_last_minute, inbox_last_five_minutes
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

    queues := queues || jsonb_build_array(jsonb_build_object(
      'destination', destination.destination,
      'enqueue_enabled', destination.enqueue_enabled,
      'dispatch_enabled', destination.dispatch_enabled,
      'pending', available_count,
      'in_flight_or_retry_wait', leased_count,
      'active_total', metric.queue_length,
      'succeeded', succeeded_count,
      'dead_letter', dead_letter_count,
      'oldest_pending_age_seconds', metric.oldest_msg_age_sec,
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
      delivery.outcome,
      delivery.attempts,
      delivery.completed_at,
      delivery.last_http_status,
      delivery.last_error_code
    from public.integration_deliveries as delivery
    order by delivery.completed_at desc
    limit least(greatest(p_recent_limit, 0), 100)
  ) as recent;

  return jsonb_build_object(
    'generated_at', clock_timestamp(),
    'ingest', jsonb_build_object(
      'accepted_total', inbox_total,
      'last_minute', inbox_last_minute,
      'last_five_minutes', inbox_last_five_minutes
    ),
    'queues', queues,
    'recent_results', recent_results
  );
end;
$$;

revoke all on function middleware_queue_status(integer) from public, anon, authenticated;
grant execute on function middleware_queue_status(integer) to service_role;

commit;
