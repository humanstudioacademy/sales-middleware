-- Keep production load-test receipts immutable while ensuring their queue
-- references can never be dispatched to real downstream systems.
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
    join public.webhook_inbox as inbox
      on inbox.id = state.webhook_id
    join public.integration_destinations as configured
      on configured.destination = state.destination
    where inbox.source_platform like 'load_test%'
      and state.status not in ('succeeded', 'dead_letter')
    order by state.ingest_sequence, state.destination
  loop
    perform public.fail_integration_job(
      p_destination => job.destination,
      p_message_id => job.message_id,
      p_webhook_id => job.webhook_id,
      p_attempt_number => job.max_attempts,
      p_started_at => clock_timestamp(),
      p_error_code => 'production_load_test_quarantined',
      p_error_message => 'Archived after ingress capacity validation; never dispatch downstream.'
    );
  end loop;
end;
$$;
