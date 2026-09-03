-- Reenfileira, no destino conta_azul, os eventos que foram para dead-letter por
-- "telefone celular inválido" na criação do cliente na Conta Azul (falha
-- corrigida em 03/09/2026: o telefone passou a ser omitido em vez de derrubar a
-- venda).
--
-- NÃO é migration de propósito. Reprocessar cria na Conta Azul as vendas desses
-- pedidos (67 pedidos Zouti pagos entre 04 e 07/08/2026). Antes de rodar,
-- confirmar com o financeiro que eles não foram lançados à mão — senão o replay
-- produz exatamente a duplicidade que se quer evitar.
--
-- Uso (pelo pooler, ver memória do projeto):
--   psql "$CONN" -X -v ON_ERROR_STOP=1 -f scripts/redrive-conta-azul-phone-dead-letters.sql
--
-- Idempotente: só toca linhas ainda em dead_letter com esse erro. O histórico em
-- integration_attempts e integration_deliveries é preservado; o item volta para
-- `pending` com uma mensagem nova na fila e é processado em ordem de ingestão.

begin;

with dead as (
  select
    state.webhook_id,
    state.message_id as old_message_id,
    inbox.ingest_sequence,
    inbox.received_at,
    inbox.received_at_epoch_ms,
    inbox.source,
    inbox.source_platform,
    inbox.source_event_type,
    inbox.source_event_id,
    inbox.body_sha256
  from public.integration_processing_state as state
  join public.webhook_inbox as inbox on inbox.id = state.webhook_id
  where state.destination = 'conta_azul'
    and state.status = 'dead_letter'
    and state.last_error_message ilike '%telefone celular é inválido%'
  order by inbox.ingest_sequence
),
queued as (
  select
    dead.*,
    (
      select sent.message_id
      from pgmq.send(
        'sales_conta_azul',
        jsonb_build_object(
          'schema_version', 2,
          'destination', 'conta_azul',
          'webhook_id', dead.webhook_id,
          'ingest_sequence', dead.ingest_sequence,
          'source', dead.source,
          'received_at', dead.received_at,
          'received_at_epoch_ms', dead.received_at_epoch_ms,
          'source_platform', dead.source_platform,
          'source_event_type', dead.source_event_type,
          'source_event_id', dead.source_event_id,
          'body_sha256', dead.body_sha256
        ),
        0
      ) as sent(message_id)
    ) as message_id
  from dead
)
update public.integration_processing_state as state
set
  message_id = queued.message_id,
  status = 'pending',
  enqueued_at = clock_timestamp(),
  next_attempt_at = clock_timestamp(),
  processing_started_at = null,
  last_attempt_finished_at = null,
  completed_at = null,
  attempt_count = 0,
  last_http_status = null,
  last_error_code = null,
  last_error_message = null,
  updated_at = clock_timestamp()
from queued
where state.destination = 'conta_azul'
  and state.webhook_id = queued.webhook_id;

select count(*) as reenfileirados
from public.integration_processing_state
where destination = 'conta_azul'
  and status = 'pending'
  and attempt_count = 0
  and enqueued_at > clock_timestamp() - interval '1 minute';

commit;
