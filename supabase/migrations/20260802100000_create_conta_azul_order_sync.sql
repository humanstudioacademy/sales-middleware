begin;

create table public.conta_azul_platform_mappings (
  source_platform text primary key,
  financial_account_id text,
  financial_account_name text,
  category_id text,
  category_name text,
  enabled boolean not null default true,
  resolved_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),

  constraint conta_azul_platform_mappings_platform_normalized
    check (source_platform = lower(btrim(source_platform)) and source_platform <> ''),
  constraint conta_azul_platform_mappings_account_pair
    check ((financial_account_id is null) = (financial_account_name is null)),
  constraint conta_azul_platform_mappings_category_pair
    check ((category_id is null) = (category_name is null))
);

insert into public.conta_azul_platform_mappings (
  source_platform,
  financial_account_id,
  financial_account_name,
  category_id,
  category_name,
  resolved_at
) values (
  'zouti',
  '62bf0c39-018d-419c-a799-52e3a07fe15c',
  'Zouti - Conta Corrente',
  '61f58af3-619d-4aab-9d4d-91b53ed240cb',
  '1.06 Cursos Online B2C',
  clock_timestamp()
);

create table public.conta_azul_orders (
  id uuid primary key default gen_random_uuid(),
  source_platform text not null,
  external_order_id text not null,
  source_customer_id text,
  current_source_status text not null,
  normalized_status text not null,
  last_webhook_id uuid not null references public.webhook_inbox(id),
  last_ingest_sequence bigint not null,
  last_source_updated_at timestamptz,
  payload_fingerprint text not null,
  conta_azul_customer_id text,
  conta_azul_sale_id text,
  conta_azul_sale_number bigint,
  conta_azul_sale_version bigint,
  financial_account_id text,
  category_id text,
  last_action text not null default 'received',
  last_synced_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),

  constraint conta_azul_orders_identity unique (source_platform, external_order_id),
  constraint conta_azul_orders_sale_id_unique unique (conta_azul_sale_id),
  constraint conta_azul_orders_sale_number_unique unique (conta_azul_sale_number),
  constraint conta_azul_orders_status
    check (normalized_status in (
      'pending', 'paid', 'rejected', 'cancelled', 'refunded', 'chargeback', 'unknown'
    )),
  constraint conta_azul_orders_fingerprint
    check (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint conta_azul_orders_sale_version_positive
    check (conta_azul_sale_version is null or conta_azul_sale_version > 0),
  constraint conta_azul_orders_sale_number_positive
    check (conta_azul_sale_number is null or conta_azul_sale_number > 0)
);

create index conta_azul_orders_status_idx
  on public.conta_azul_orders (normalized_status, updated_at desc);
create index conta_azul_orders_ingest_idx
  on public.conta_azul_orders (last_ingest_sequence desc);

create table public.conta_azul_order_events (
  webhook_id uuid primary key references public.webhook_inbox(id),
  order_id uuid not null references public.conta_azul_orders(id),
  ingest_sequence bigint not null unique,
  source_status text not null,
  normalized_status text not null,
  payload_fingerprint text not null,
  action text not null,
  conta_azul_http_status integer,
  processed_at timestamptz not null default clock_timestamp(),

  constraint conta_azul_order_events_status
    check (normalized_status in (
      'pending', 'paid', 'rejected', 'cancelled', 'refunded', 'chargeback', 'unknown'
    )),
  constraint conta_azul_order_events_fingerprint
    check (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint conta_azul_order_events_http_status
    check (conta_azul_http_status is null or conta_azul_http_status between 100 and 599)
);

create index conta_azul_order_events_order_idx
  on public.conta_azul_order_events (order_id, ingest_sequence desc);

create table public.conta_azul_deferred_events (
  webhook_id uuid primary key references public.webhook_inbox(id),
  ingest_sequence bigint not null unique,
  source_platform text not null,
  entity_kind text not null,
  external_entity_id text,
  related_order_id text,
  source_status text,
  reason text not null,
  payload_fingerprint text not null,
  deferred_at timestamptz not null default clock_timestamp(),

  constraint conta_azul_deferred_events_fingerprint
    check (payload_fingerprint ~ '^[0-9a-f]{64}$')
);

create index conta_azul_deferred_events_related_order_idx
  on public.conta_azul_deferred_events (source_platform, related_order_id, ingest_sequence)
  where related_order_id is not null;

create table public.conta_azul_customer_links (
  source_platform text not null,
  source_customer_id text not null,
  normalized_document text,
  normalized_email text,
  conta_azul_customer_id text not null,
  request_fingerprint text not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),

  primary key (source_platform, source_customer_id),
  constraint conta_azul_customer_links_fingerprint
    check (request_fingerprint ~ '^[0-9a-f]{64}$')
);

create index conta_azul_customer_links_document_idx
  on public.conta_azul_customer_links (normalized_document)
  where normalized_document is not null;
create index conta_azul_customer_links_email_idx
  on public.conta_azul_customer_links (normalized_email)
  where normalized_email is not null;
create index conta_azul_customer_links_external_idx
  on public.conta_azul_customer_links (conta_azul_customer_id);

create table public.conta_azul_product_links (
  source_platform text not null,
  source_product_id text not null,
  conta_azul_product_id text not null,
  conta_azul_sku text not null,
  request_fingerprint text not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),

  primary key (source_platform, source_product_id),
  constraint conta_azul_product_links_sku_unique unique (conta_azul_sku),
  constraint conta_azul_product_links_fingerprint
    check (request_fingerprint ~ '^[0-9a-f]{64}$')
);

create index conta_azul_product_links_external_idx
  on public.conta_azul_product_links (conta_azul_product_id);

alter table public.conta_azul_platform_mappings enable row level security;
alter table public.conta_azul_orders enable row level security;
alter table public.conta_azul_order_events enable row level security;
alter table public.conta_azul_deferred_events enable row level security;
alter table public.conta_azul_customer_links enable row level security;
alter table public.conta_azul_product_links enable row level security;

revoke all on table public.conta_azul_platform_mappings from anon, authenticated, service_role;
revoke all on table public.conta_azul_orders from anon, authenticated, service_role;
revoke all on table public.conta_azul_order_events from anon, authenticated, service_role;
revoke all on table public.conta_azul_deferred_events from anon, authenticated, service_role;
revoke all on table public.conta_azul_customer_links from anon, authenticated, service_role;
revoke all on table public.conta_azul_product_links from anon, authenticated, service_role;

grant select, insert, update on table public.conta_azul_platform_mappings to service_role;
grant select, insert, update on table public.conta_azul_orders to service_role;
grant select, insert, update on table public.conta_azul_order_events to service_role;
grant select, insert, update on table public.conta_azul_deferred_events to service_role;
grant select, insert, update on table public.conta_azul_customer_links to service_role;
grant select, insert, update on table public.conta_azul_product_links to service_role;

commit;
