begin;

-- Mesmo motivo da 20260903220000, agora no caminho de dead-letter: um item
-- reprocessado que volte a falhar até o limite precisa sobrescrever o desfecho
-- arquivado em vez de colidir com a chave única (destino, webhook).

CREATE OR REPLACE FUNCTION public.fail_integration_job(p_destination text, p_message_id bigint, p_webhook_id uuid, p_attempt_number integer, p_started_at timestamp with time zone, p_http_status integer DEFAULT NULL::integer, p_error_code text DEFAULT NULL::text, p_error_message text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  configured public.integration_destinations%rowtype;
  retry_delay integer;
  retry_at timestamptz;
  archived boolean;
  previous_outcome text;
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

    select delivery.outcome
    into previous_outcome
    from public.integration_deliveries as delivery
    where delivery.destination = p_destination
      and delivery.webhook_id = p_webhook_id;

    insert into public.integration_deliveries (
      destination, message_id, webhook_id, outcome, attempts,
      last_http_status, last_error_code, last_error_message
    ) values (
      p_destination, p_message_id, p_webhook_id, 'dead_letter', p_attempt_number,
      p_http_status, left(p_error_code, 200), left(p_error_message, 2000)
    )
    on conflict (destination, webhook_id) do update
    set
      message_id = excluded.message_id,
      outcome = excluded.outcome,
      attempts = excluded.attempts,
      completed_at = clock_timestamp(),
      last_http_status = excluded.last_http_status,
      last_error_code = excluded.last_error_code,
      last_error_message = excluded.last_error_message;

    if previous_outcome is null then
      update public.integration_delivery_counters
      set dead_letter_count = dead_letter_count + 1, updated_at = clock_timestamp()
      where destination = p_destination
        and shard = (get_byte(uuid_send(p_webhook_id), 0) % 64)::smallint;
    elsif previous_outcome = 'succeeded' then
      update public.integration_delivery_counters
      set
        dead_letter_count = dead_letter_count + 1,
        succeeded_count = greatest(0, succeeded_count - 1),
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

revoke all on function public.fail_integration_job(text, bigint, uuid, integer, timestamptz, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.fail_integration_job(text, bigint, uuid, integer, timestamptz, integer, text, text)
  to service_role;

commit;
