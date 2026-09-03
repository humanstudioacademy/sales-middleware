begin;

-- O destino `student_portal` foi criado em 20260803000000 sem backfill. O
-- gatilho de ingresso só enfileira o que entra depois dele, então todos os
-- webhooks anteriores — sequências 1388 a 3111 — nunca tiveram item nessa fila
-- e nunca chegaram ao portal do aluno. É por isso que compradores de agosto
-- ficaram sem acesso mesmo com a oferta cadastrada: não havia o que processar.
--
-- Este backfill enfileira exatamente os webhooks que ficaram de fora. Nenhuma
-- regra de negócio é antecipada aqui: quem decide matrícula, edição e janela
-- continua sendo o worker, que aplica as mesmas regras de sempre e registra
-- como pulado o que não se aplica.
--
-- Recibos de ensaio de carga e o corpo de teste sem plataforma ficam de fora,
-- para não ressuscitar o que foi posto em quarentena de propósito.
--
-- Idempotente: `not exists` impede criar um segundo item para o mesmo webhook.
do $$
declare
  pendente record;
  fila text;
  nova_mensagem bigint;
begin
  select configured.queue_name into fila
  from public.integration_destinations as configured
  where configured.destination = 'student_portal';

  if fila is null then
    raise exception 'Destino student_portal não encontrado';
  end if;

  for pendente in
    select inbox.*
    from public.webhook_inbox as inbox
    where not exists (
        select 1
        from public.integration_processing_state as state
        where state.webhook_id = inbox.id
          and state.destination = 'student_portal'
      )
      and inbox.source_platform not like 'load\_test%'
      and inbox.body_json is distinct from '{"test": true}'::jsonb
    order by inbox.ingest_sequence
  loop
    select sent.message_id
    into nova_mensagem
    from pgmq.send(
      fila,
      jsonb_build_object(
        'schema_version', 2,
        'destination', 'student_portal',
        'webhook_id', pendente.id,
        'ingest_sequence', pendente.ingest_sequence,
        'source', pendente.source,
        'received_at', pendente.received_at,
        'received_at_epoch_ms', pendente.received_at_epoch_ms,
        'source_platform', pendente.source_platform,
        'source_event_type', pendente.source_event_type,
        'source_event_id', pendente.source_event_id,
        'body_sha256', pendente.body_sha256
      ),
      0
    ) as sent(message_id);

    insert into public.integration_processing_state (
      destination, webhook_id, message_id, ingest_sequence, status, enqueued_at, next_attempt_at
    ) values (
      'student_portal', pendente.id, nova_mensagem, pendente.ingest_sequence,
      'pending', pendente.received_at, pendente.received_at
    );
  end loop;
end;
$$;

select count(*) as enfileirados
from public.integration_processing_state
where destination = 'student_portal' and status = 'pending';

commit;
