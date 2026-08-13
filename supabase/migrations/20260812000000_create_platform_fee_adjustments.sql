begin;

-- Tarifas que não chegam no webhook da venda e só aparecem no extrato da
-- plataforma (antecipação, saque, ajustes de conciliação). Cada linha desconta
-- do valor lançado na Conta Azul e é descrita na composição da venda.
create table public.platform_fee_adjustments (
  source_platform text not null,
  external_reference text not null,
  code text not null,
  label text not null,
  amount numeric(14, 2) not null,
  detail text,
  source_document text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),

  primary key (source_platform, external_reference, code),
  constraint platform_fee_adjustments_platform_normalized
    check (source_platform = lower(btrim(source_platform)) and source_platform <> ''),
  constraint platform_fee_adjustments_reference_present
    check (btrim(external_reference) <> ''),
  constraint platform_fee_adjustments_code_normalized
    check (code = lower(btrim(code)) and code ~ '^[a-z0-9_]+$'),
  constraint platform_fee_adjustments_label_present
    check (btrim(label) <> ''),
  -- Positivo desconta do bruto; negativo devolve um valor retido a mais.
  constraint platform_fee_adjustments_amount_nonzero
    check (amount <> 0)
);

create index platform_fee_adjustments_reference_idx
  on public.platform_fee_adjustments (source_platform, external_reference);

comment on table public.platform_fee_adjustments is
  'Tarifas de extrato aplicadas ao valor líquido enviado à Conta Azul.';
comment on column public.platform_fee_adjustments.external_reference is
  'Identificador da transação na plataforma: ord_... na Zouti, HP... na Hotmart.';

alter table public.platform_fee_adjustments enable row level security;
revoke all on table public.platform_fee_adjustments from anon, authenticated, service_role;
grant select, insert, update, delete on table public.platform_fee_adjustments to service_role;

commit;
