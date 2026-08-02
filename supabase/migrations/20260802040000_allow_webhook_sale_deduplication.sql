begin;

alter table public.conta_azul_sale_links
  drop constraint conta_azul_sale_links_conta_azul_sale_id_key;

alter table public.conta_azul_sale_links
  drop constraint conta_azul_sale_links_request_fingerprint_key;

create index conta_azul_sale_links_sale_id_idx
  on public.conta_azul_sale_links (conta_azul_sale_id);

create index conta_azul_sale_links_fingerprint_idx
  on public.conta_azul_sale_links (request_fingerprint);

create index conta_azul_sale_links_sale_number_idx
  on public.conta_azul_sale_links (sale_number)
  where sale_number is not null;

commit;
