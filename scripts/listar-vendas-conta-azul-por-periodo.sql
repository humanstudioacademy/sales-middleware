-- Lista tudo que o middleware criou, atualizou ou cancelou na Conta Azul dentro
-- de um período, com o vínculo transação → venda. Serve para auditoria e para
-- uma eventual exclusão em massa na Conta Azul: o número e o UUID da venda são
-- exatamente os que estão lá.
--
-- Uso (pelo pooler, ver memória do projeto):
--   psql "$CONN" -X -v inicio="'2026-09-03 16:35:00+00'" -v fim="'2026-09-04 00:00:00+00'" \
--        -f scripts/listar-vendas-conta-azul-por-periodo.sql
--
-- Ou para CSV:
--   psql "$CONN" -X -A -F ';' -v inicio=... -v fim=... -f scripts/listar-vendas-conta-azul-por-periodo.sql > docs/auditoria/conta-azul-<data>.csv
--
-- `duplicate`, `stale`, `recorded_*` e `cancel_without_sale` não tocam a Conta
-- Azul e ficam fora desta lista de propósito.

select
  events.processed_at,
  orders.source_platform,
  orders.external_order_id,
  events.action,
  events.source_status,
  orders.conta_azul_sale_number,
  orders.conta_azul_sale_id,
  orders.conta_azul_customer_id,
  events.ingest_sequence,
  events.webhook_id
from public.conta_azul_order_events as events
join public.conta_azul_orders as orders on orders.id = events.order_id
where events.processed_at >= :inicio
  and events.processed_at < :fim
  and events.action in (
    'sale_created', 'sale_updated', 'sale_cancelled',
    'sale_refreshed', 'sale_cancelled_refreshed', 'sale_net_recomputed'
  )
order by events.processed_at;
