-- Reprocessa no destino `student_portal` os webhooks que foram registrados como
-- `no_student_portal_offer_mapped` mas cujo produto passou a ter oferta
-- cadastrada depois (caso do Academy Pass, cadastrado em 20260903230000).
--
-- O worker encerra sem agir quando o webhook já está em
-- `student_portal_skipped_events`, então a linha de "pulado" é removida antes de
-- reenfileirar. As matrículas já concedidas não são tocadas: o portal é
-- idempotente e responde `novo: false` se o aluno já existir.
--
--   psql "$CONN" -X -v ON_ERROR_STOP=1 -f scripts/redrive-student-portal-skipped.sql
--
-- Idempotente: rodar de novo não encontra mais nada a reprocessar.

begin;

create temporary table elegiveis on commit drop as
select
  skipped.webhook_id,
  inbox.ingest_sequence,
  inbox.received_at,
  inbox.received_at_epoch_ms,
  inbox.source,
  inbox.source_platform,
  inbox.source_event_type,
  inbox.source_event_id,
  inbox.body_sha256
from public.student_portal_skipped_events as skipped
join public.webhook_inbox as inbox on inbox.id = skipped.webhook_id
where skipped.reason = 'no_student_portal_offer_mapped'
  and exists (
    select 1
    from jsonb_array_elements(inbox.body_json -> 'items') as item
    join public.student_portal_offers as offer
      on offer.source_product_id = item ->> 'product_id'
     and lower(offer.source_platform) = lower(inbox.source_platform)
    where offer.enabled
      and inbox.body_json ->> 'created_at' >= to_char(offer.starts_at at time zone 'UTC', 'YYYY-MM-DD')
      and (offer.ends_at is null or inbox.body_json ->> 'created_at' < to_char(offer.ends_at at time zone 'UTC', 'YYYY-MM-DD'))
  );

delete from public.student_portal_skipped_events
where webhook_id in (select webhook_id from elegiveis);

with enfileirados as (
  select
    elegiveis.webhook_id,
    (
      select sent.message_id
      from pgmq.send(
        'sales_student_portal',
        jsonb_build_object(
          'schema_version', 2,
          'destination', 'student_portal',
          'webhook_id', elegiveis.webhook_id,
          'ingest_sequence', elegiveis.ingest_sequence,
          'source', elegiveis.source,
          'received_at', elegiveis.received_at,
          'received_at_epoch_ms', elegiveis.received_at_epoch_ms,
          'source_platform', elegiveis.source_platform,
          'source_event_type', elegiveis.source_event_type,
          'source_event_id', elegiveis.source_event_id,
          'body_sha256', elegiveis.body_sha256
        ),
        0
      ) as sent(message_id)
    ) as message_id
  from elegiveis
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

select count(*) as reprocessando from elegiveis;

commit;
