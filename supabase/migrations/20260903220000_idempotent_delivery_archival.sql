begin;

-- `integration_deliveries` guarda o desfecho final por (destino, webhook) e tem
-- duas chaves: a primária (destino, message_id) e a única (destino, webhook_id).
-- O arquivamento só tratava conflito na primária. Ao reprocessar um item que já
-- havia sido arquivado como dead-letter, o redrive dá uma mensagem nova à fila,
-- então a primária não colide, mas a única colide — e a conclusão falhava com
-- 23505 em loop, travando o FIFO da plataforma inteira.
--
-- O desfecho final passa a ser sobrescrito: um webhook que estava em
-- dead-letter e depois teve sucesso fica registrado como sucesso, e os
-- contadores acompanham a mudança. `integration_attempts` continua append-only
-- com todas as tentativas, então nada de auditoria se perde.

create or replace function public.complete_integration_job(
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
  previous_outcome text;
  counter_shard smallint;
begin
  queue_name := public.private_queue_name(p_destination);
  if queue_name is null then
    raise exception 'Unknown integration destination';
  end if;

  insert into public.integration_attempts (
    destination, message_id, webhook_id, attempt_number, outcome, started_at, http_status
  ) values (
    p_destination, p_message_id, p_webhook_id, p_attempt_number, 'succeeded', p_started_at, p_http_status
  );

  select delivery.outcome
  into previous_outcome
  from public.integration_deliveries as delivery
  where delivery.destination = p_destination
    and delivery.webhook_id = p_webhook_id;

  insert into public.integration_deliveries (
    destination, message_id, webhook_id, outcome, attempts, last_http_status
  ) values (
    p_destination, p_message_id, p_webhook_id, 'succeeded', p_attempt_number, p_http_status
  )
  on conflict (destination, webhook_id) do update
  set
    message_id = excluded.message_id,
    outcome = excluded.outcome,
    attempts = excluded.attempts,
    completed_at = clock_timestamp(),
    last_http_status = excluded.last_http_status,
    last_error_code = null,
    last_error_message = null;

  counter_shard := (get_byte(uuid_send(p_webhook_id), 0) % 64)::smallint;

  if previous_outcome is null then
    update public.integration_delivery_counters
    set succeeded_count = succeeded_count + 1, updated_at = clock_timestamp()
    where destination = p_destination and shard = counter_shard;
  elsif previous_outcome = 'dead_letter' then
    update public.integration_delivery_counters
    set
      succeeded_count = succeeded_count + 1,
      dead_letter_count = greatest(0, dead_letter_count - 1),
      updated_at = clock_timestamp()
    where destination = p_destination and shard = counter_shard;
  end if;

  archived := pgmq.archive(queue_name, p_message_id);
  if not archived then
    raise exception 'Queue message was not found or was already archived';
  end if;

  return true;
end;
$$;

revoke all on function public.complete_integration_job(text, bigint, uuid, integer, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.complete_integration_job(text, bigint, uuid, integer, timestamptz, integer)
  to service_role;

commit;
