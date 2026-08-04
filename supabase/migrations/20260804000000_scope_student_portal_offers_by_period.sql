begin;

-- A mesma oferta da Zouti vende continuamente e a turma muda com o calendário:
-- quem comprou em agosto entra na 3ª edição, quem comprar depois entra na
-- seguinte. A edição passa a ser função de (produto, momento da compra), não do
-- produto sozinho.
create extension if not exists btree_gist;

alter table public.student_portal_offers
  drop constraint student_portal_offers_pkey;

alter table public.student_portal_offers
  add column id uuid primary key default gen_random_uuid(),
  add column starts_at timestamptz not null default clock_timestamp(),
  add column ends_at timestamptz;

alter table public.student_portal_offers
  add constraint student_portal_offers_period_order
    check (ends_at is null or ends_at > starts_at);

-- Duas janelas ativas do mesmo produto não podem se sobrepor. Sem isso, uma
-- venda na interseção teria duas edições possíveis e a escolha seria arbitrária.
alter table public.student_portal_offers
  add constraint student_portal_offers_no_overlap
    exclude using gist (
      source_platform with =,
      source_product_id with =,
      tstzrange(starts_at, ends_at) with &&
    ) where (enabled);

comment on column public.student_portal_offers.starts_at is
  'Início da janela, comparado com a data de criação da ordem na origem — não com a data de recebimento do webhook.';
comment on column public.student_portal_offers.ends_at is
  'Fim exclusivo da janela. Nulo mantém a oferta aberta indefinidamente.';

create index student_portal_offers_lookup_idx
  on public.student_portal_offers (source_platform, source_product_id, starts_at desc)
  where enabled;

commit;
