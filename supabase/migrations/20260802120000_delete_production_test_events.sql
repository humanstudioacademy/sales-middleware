begin;

create temporary table test_webhook_ids on commit drop as
select id, ingest_sequence
from public.webhook_inbox
where source_platform like 'load_test%'
   or source_platform like 'region_probe%'
   or (
     source_platform = 'zolt'
     and ingest_sequence in (1, 2, 3, 5, 7, 1387)
   );

do $$
declare
  configured record;
begin
  for configured in
    select destination, queue_name
    from public.integration_destinations
  loop
    execute format(
      'delete from pgmq.%I as queue where queue.msg_id in (
        select state.message_id
        from public.integration_processing_state as state
        join test_webhook_ids as test on test.id = state.webhook_id
        where state.destination = $1
      )',
      'q_' || configured.queue_name
    ) using configured.destination;

    execute format(
      'delete from pgmq.%I as archive where archive.msg_id in (
        select state.message_id
        from public.integration_processing_state as state
        join test_webhook_ids as test on test.id = state.webhook_id
        where state.destination = $1
      )',
      'a_' || configured.queue_name
    ) using configured.destination;
  end loop;
end;
$$;

delete from public.conta_azul_order_events
where webhook_id in (select id from test_webhook_ids);

delete from public.conta_azul_deferred_events
where webhook_id in (select id from test_webhook_ids);

delete from public.conta_azul_orders
where last_webhook_id in (select id from test_webhook_ids);

delete from public.conta_azul_sale_links
where webhook_id in (select id from test_webhook_ids);

delete from public.integration_attempts
where webhook_id in (select id from test_webhook_ids);

delete from public.integration_deliveries
where webhook_id in (select id from test_webhook_ids);

delete from public.integration_processing_state
where webhook_id in (select id from test_webhook_ids);

delete from public.webhook_inbox
where id in (select id from test_webhook_ids);

update public.ingest_counters as counter
set
  event_count = (
    select count(*)
    from public.webhook_inbox as inbox
    where (get_byte(uuid_send(inbox.id), 0) % 64)::smallint = counter.shard
  ),
  updated_at = clock_timestamp();

update public.integration_delivery_counters as counter
set
  succeeded_count = (
    select count(*)
    from public.integration_deliveries as delivery
    where delivery.destination = counter.destination
      and delivery.outcome = 'succeeded'
      and (get_byte(uuid_send(delivery.webhook_id), 0) % 64)::smallint = counter.shard
  ),
  dead_letter_count = (
    select count(*)
    from public.integration_deliveries as delivery
    where delivery.destination = counter.destination
      and delivery.outcome = 'dead_letter'
      and (get_byte(uuid_send(delivery.webhook_id), 0) % 64)::smallint = counter.shard
  ),
  updated_at = clock_timestamp();

commit;
