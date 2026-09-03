begin;

-- Transações que já foram lançadas na Conta Azul por outra fonte (o app
-- SquadHub, entre jul e 03/09/2026, ou um lançamento manual). O worker nunca
-- cria venda para uma transação listada aqui, mesmo com a data de corte da
-- plataforma anterior ao pagamento: a ordem fica registrada com
-- `last_action = recorded_external_posting` e apontando para o evento
-- financeiro que já existe. É a garantia de "um registro por transação"
-- também para o que foi lançado antes do middleware assumir.
create table public.conta_azul_external_postings (
  source_platform text not null,
  external_order_id text not null,
  posted_by text not null,
  conta_azul_event_id text,
  conta_azul_reference text,
  amount numeric(14, 2),
  competence_date date,
  duplicate_event_ids text[] not null default '{}',
  note text,
  created_at timestamptz not null default clock_timestamp(),

  primary key (source_platform, external_order_id),
  constraint conta_azul_external_postings_platform_normalized
    check (source_platform = lower(btrim(source_platform)) and source_platform <> ''),
  constraint conta_azul_external_postings_reference_present
    check (btrim(external_order_id) <> ''),
  constraint conta_azul_external_postings_posted_by_present
    check (btrim(posted_by) <> '')
);

comment on table public.conta_azul_external_postings is
  'Transações já lançadas na Conta Azul por outra fonte (SquadHub, manual). O worker nunca cria venda para elas. duplicate_event_ids lista lançamentos repetidos da mesma transação, para exclusão pelo financeiro.';

alter table public.conta_azul_external_postings enable row level security;
revoke all on table public.conta_azul_external_postings from anon, authenticated, service_role;
grant select, insert, update, delete on table public.conta_azul_external_postings to service_role;

commit;
