-- Reentrega ao portal as matrículas concedidas antes de `grants_replay` existir,
-- para que o aluno que comprou o formato gravado receba `temReplay: true`.
--
-- O worker encerra sem agir quando o webhook já está em
-- `student_portal_enrollment_events`, então o registro do último evento da
-- matrícula é removido e o webhook volta para a fila. O reprocessamento grava
-- um registro novo para o mesmo webhook, com a ação atual.
--
-- O portal é idempotente e não dispara e-mail: reenviar um aluno existente
-- apenas atualiza o acesso e responde `novo: false`.
--
--   psql "$CONN" -X -v ON_ERROR_STOP=1 -f scripts/redrive-student-portal-replay.sql
--
-- Idempotente enquanto houver matrícula concedida sem replay; depois não
-- encontra mais nada.

begin;

create temporary table alvos on commit drop as
select
  enrollment.last_webhook_id as webhook_id,
  inbox.ingest_sequence,
  inbox.received_at,
  inbox.received_at_epoch_ms,
  inbox.source,
  inbox.source_platform,
  inbox.source_event_type,
  inbox.source_event_id,
  inbox.body_sha256
from public.student_portal_enrollments as enrollment
join public.webhook_inbox as inbox on inbox.id = enrollment.last_webhook_id
where enrollment.access_state = 'granted'
  and exists (
    select 1
    from public.webhook_inbox as origem
    cross join lateral jsonb_array_elements(origem.body_json -> 'items') as item
    join public.student_portal_offers as offer
      on offer.source_product_id = item ->> 'product_id'
     and lower(offer.source_platform) = lower(enrollment.source_platform)
    where origem.body_json ->> 'id' = enrollment.external_order_id
      and lower(origem.source_platform) = lower(enrollment.source_platform)
      and offer.enabled
      and offer.grants_replay
  );

delete from public.student_portal_enrollment_events
where webhook_id in (select webhook_id from alvos);

with enfileirados as (
  select
    alvos.webhook_id,
    (
      select sent.message_id
      from pgmq.send(
        'sales_student_portal',
        jsonb_build_object(
          'schema_version', 2,
          'destination', 'student_portal',
          'webhook_id', alvos.webhook_id,
          'ingest_sequence', alvos.ingest_sequence,
          'source', alvos.source,
          'received_at', alvos.received_at,
          'received_at_epoch_ms', alvos.received_at_epoch_ms,
          'source_platform', alvos.source_platform,
          'source_event_type', alvos.source_event_type,
          'source_event_id', alvos.source_event_id,
          'body_sha256', alvos.body_sha256
        ),
        0
      ) as sent(message_id)
    ) as message_id
  from alvos
)
update public.integration_processing_state as state
set
  message_id = enfileirados.message_id,
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
from enfileirados
where state.destination = 'student_portal'
  and state.webhook_id = enfileirados.webhook_id;

select count(*) as reentregando from alvos;

commit;
