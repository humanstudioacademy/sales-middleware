begin;

-- Terceiro destino durável: portal do aluno. A fila recebe todos os webhooks,
-- como Conta Azul e humanOS, e o worker decide a elegibilidade pelo produto
-- vendido. Um evento não elegível é registrado e encerrado, nunca reenviado.
select pgmq.create('sales_student_portal');

insert into public.integration_destinations (
  destination,
  queue_name,
  enqueue_enabled,
  dispatch_enabled
)
values ('student_portal', 'sales_student_portal', true, false);

insert into public.integration_delivery_counters (destination, shard)
select 'student_portal', shard.number::smallint
from generate_series(0, 63) as shard(number);

insert into public.integration_worker_leases (destination)
values ('student_portal')
on conflict (destination) do nothing;

-- Backfill: webhooks já na inbox não entram na fila nova. O trigger de ingresso
-- só enfileira inserts futuros, então a fila começa vazia por decisão explícita.

-- Fonte de verdade da elegibilidade. O produto vendido decide se a venda vira
-- matrícula e em qual edição, sem depender do cadastro da URL na Zouti.
create table public.student_portal_offers (
  source_platform text not null,
  source_product_id text not null,
  edition_code text not null,
  product_label text,
  enabled boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),

  primary key (source_platform, source_product_id),
  constraint student_portal_offers_platform_normalized
    check (source_platform = lower(btrim(source_platform)) and source_platform <> ''),
  constraint student_portal_offers_product_not_blank
    check (length(btrim(source_product_id)) > 0),
  constraint student_portal_offers_edition_format
    check (edition_code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
);

comment on table public.student_portal_offers is
  'Produtos da origem que liberam acesso ao portal do aluno e a edição correspondente.';
comment on column public.student_portal_offers.edition_code is
  'Valor enviado literalmente no campo "edicao" da matrícula, por exemplo agent-lab-3. Uma oferta desativada deixa a venda fora do portal sem apagar o histórico.';

create index student_portal_offers_edition_idx
  on public.student_portal_offers (edition_code)
  where enabled;

-- Estado atual da matrícula. A identidade é (plataforma, ordem, edição): um
-- reenvio da mesma ordem atualiza a mesma matrícula em vez de criar outra.
create table public.student_portal_enrollments (
  id uuid primary key default gen_random_uuid(),
  source_platform text not null,
  external_order_id text not null,
  edition_code text not null,
  source_product_id text not null,
  source_customer_id text,
  student_name text not null,
  student_email text,
  student_phone text,
  access_state text not null default 'pending',
  current_source_status text not null,
  normalized_status text not null,
  last_webhook_id uuid not null references public.webhook_inbox(id),
  last_ingest_sequence bigint not null,
  last_source_updated_at timestamptz,
  payload_fingerprint text not null,
  last_action text not null default 'received',
  last_http_status integer,
  granted_at timestamptz,
  revoked_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),

  constraint student_portal_enrollments_identity
    unique (source_platform, external_order_id, edition_code),
  constraint student_portal_enrollments_access_state
    check (access_state in ('pending', 'granted', 'revoked')),
  constraint student_portal_enrollments_status
    check (normalized_status in (
      'pending', 'paid', 'rejected', 'cancelled', 'refunded', 'chargeback', 'unknown'
    )),
  constraint student_portal_enrollments_fingerprint
    check (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint student_portal_enrollments_http_status
    check (last_http_status is null or last_http_status between 100 and 599),
  constraint student_portal_enrollments_granted_at
    check (access_state <> 'granted' or granted_at is not null)
);

create index student_portal_enrollments_edition_idx
  on public.student_portal_enrollments (edition_code, access_state, updated_at desc);
create index student_portal_enrollments_email_idx
  on public.student_portal_enrollments (student_email)
  where student_email is not null;
create index student_portal_enrollments_ingest_idx
  on public.student_portal_enrollments (last_ingest_sequence desc);

-- Auditoria append-only. A presença do webhook_id encerra o reprocessamento
-- quando um ACK se perde depois da entrega já ter sido feita ao portal.
create table public.student_portal_enrollment_events (
  webhook_id uuid primary key references public.webhook_inbox(id),
  enrollment_id uuid not null references public.student_portal_enrollments(id),
  ingest_sequence bigint not null unique,
  source_status text not null,
  normalized_status text not null,
  payload_fingerprint text not null,
  action text not null,
  portal_http_status integer,
  processed_at timestamptz not null default clock_timestamp(),

  constraint student_portal_enrollment_events_status
    check (normalized_status in (
      'pending', 'paid', 'rejected', 'cancelled', 'refunded', 'chargeback', 'unknown'
    )),
  constraint student_portal_enrollment_events_fingerprint
    check (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint student_portal_enrollment_events_http_status
    check (portal_http_status is null or portal_http_status between 100 and 599)
);

create index student_portal_enrollment_events_enrollment_idx
  on public.student_portal_enrollment_events (enrollment_id, ingest_sequence desc);

-- Eventos que não viram matrícula: outra plataforma, evento auxiliar da Zouti
-- ou venda sem nenhum produto mapeado para o portal.
create table public.student_portal_skipped_events (
  webhook_id uuid primary key references public.webhook_inbox(id),
  ingest_sequence bigint not null unique,
  source_platform text not null,
  entity_kind text not null,
  external_entity_id text,
  related_order_id text,
  source_status text,
  reason text not null,
  payload_fingerprint text not null,
  skipped_at timestamptz not null default clock_timestamp(),

  constraint student_portal_skipped_events_fingerprint
    check (payload_fingerprint ~ '^[0-9a-f]{64}$')
);

create index student_portal_skipped_events_reason_idx
  on public.student_portal_skipped_events (reason, ingest_sequence desc);

alter table public.student_portal_offers enable row level security;
alter table public.student_portal_enrollments enable row level security;
alter table public.student_portal_enrollment_events enable row level security;
alter table public.student_portal_skipped_events enable row level security;

revoke all on table public.student_portal_offers from anon, authenticated, service_role;
revoke all on table public.student_portal_enrollments from anon, authenticated, service_role;
revoke all on table public.student_portal_enrollment_events from anon, authenticated, service_role;
revoke all on table public.student_portal_skipped_events from anon, authenticated, service_role;

grant select, insert, update on table public.student_portal_offers to service_role;
grant select, insert, update on table public.student_portal_enrollments to service_role;
grant select, insert, update on table public.student_portal_enrollment_events to service_role;
grant select, insert, update on table public.student_portal_skipped_events to service_role;

commit;
