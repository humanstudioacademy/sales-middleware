begin;

-- Sobrou um único recibo com corpo `{"test": true}`, recebido em 08/08/2026 pela
-- plataforma `zolt`, que nunca teve adaptador. Ele não é venda nem evento
-- auxiliar de nenhuma origem real, e os workers só reclamam plataformas
-- configuradas, então ele ficaria pendente para sempre em todos os destinos.
--
-- Mesmo tratamento dado aos ensaios de carga: o recibo continua imutável na
-- inbox e a referência de fila é arquivada para nunca ser despachada.
do $$
declare
  job record;
begin
  for job in
    select
      state.destination,
      state.message_id,
      state.webhook_id,
      configured.max_attempts
    from public.integration_processing_state as state
    join public.webhook_inbox as inbox on inbox.id = state.webhook_id
    join public.integration_destinations as configured on configured.destination = state.destination
    where inbox.source_platform = 'zolt'
      and inbox.body_json = '{"test": true}'::jsonb
      and state.status not in ('succeeded', 'dead_letter')
    order by state.ingest_sequence, state.destination
  loop
    perform public.fail_integration_job(
      p_destination => job.destination,
      p_message_id => job.message_id,
      p_webhook_id => job.webhook_id,
      p_attempt_number => job.max_attempts,
      p_started_at => clock_timestamp(),
      p_error_code => 'test_payload_quarantined',
      p_error_message => 'Corpo de teste sem plataforma de origem; arquivado para nunca ser despachado.'
    );
  end loop;
end;
$$;

commit;
