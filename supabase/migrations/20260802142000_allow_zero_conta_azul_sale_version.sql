alter table public.conta_azul_orders
  drop constraint conta_azul_orders_sale_version_positive;

alter table public.conta_azul_orders
  add constraint conta_azul_orders_sale_version_nonnegative
  check (conta_azul_sale_version is null or conta_azul_sale_version >= 0);
