-- Archive the exact smoke/contract-validation receipts created during launch.
-- The immutable inbox rows remain available for audit and replay verification.
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
    where state.status not in ('succeeded', 'dead_letter')
      and (
        inbox.body_json ->> 'test' = 'true'
        or inbox.body_json ? 'marker'
        or inbox.source_platform like 'region_probe%'
        or inbox.source_event_type = 'post_deploy_smoke'
      )
    order by state.ingest_sequence, state.destination
  loop
    perform public.fail_integration_job(
      p_destination => job.destination,
      p_message_id => job.message_id,
      p_webhook_id => job.webhook_id,
      p_attempt_number => job.max_attempts,
      p_started_at => clock_timestamp(),
      p_error_code => 'ingress_validation_quarantined',
      p_error_message => 'Archived launch validation receipt; never dispatch downstream.'
    );
  end loop;
end;
$$;
