-- Archive the launch-time binary/repeated-query capture test. The inbox row is
-- intentionally preserved; only its downstream queue references are terminal.
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
    join public.integration_destinations as configured
      on configured.destination = state.destination
    where state.webhook_id = 'c3f8b84a-f1d2-424a-8ce1-d147bebe5741'::uuid
      and state.status not in ('succeeded', 'dead_letter')
  loop
    perform public.fail_integration_job(
      p_destination => job.destination,
      p_message_id => job.message_id,
      p_webhook_id => job.webhook_id,
      p_attempt_number => job.max_attempts,
      p_started_at => clock_timestamp(),
      p_error_code => 'binary_capture_validation_quarantined',
      p_error_message => 'Archived launch binary capture validation; never dispatch downstream.'
    );
  end loop;
end;
$$;
