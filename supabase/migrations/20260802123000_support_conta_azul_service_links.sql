alter table public.conta_azul_product_links
  add column conta_azul_item_kind text not null default 'product';

alter table public.conta_azul_product_links
  add constraint conta_azul_product_links_item_kind
  check (conta_azul_item_kind in ('product', 'service'));

comment on column public.conta_azul_product_links.conta_azul_item_kind is
  'Conta Azul catalog kind. New Zouti mappings use an existing service and never create inventory products.';
