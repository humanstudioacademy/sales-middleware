begin;

create table public.webhook_inbox (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  received_at timestamptz not null default clock_timestamp(),
  request_method text not null,
  request_path text not null,
  body_size_bytes bigint not null,
  body_sha256 text not null,
  content_type text,
  source_event_id text,
  gateway_request_id text,
  edge_execution_id text,
  auth_scheme text not null,
  sanitized_headers jsonb not null default '{}'::jsonb,
  sanitized_query_params jsonb not null default '{}'::jsonb,
  body_is_json boolean not null default false,
  body_json jsonb,
  encrypted_envelope_base64 text not null,
  encryption_iv_base64 text not null,
  encryption_algorithm text not null default 'AES-256-GCM',
  encryption_key_version integer not null default 1,
  ingest_version integer not null default 1,

  constraint webhook_inbox_source_not_blank
    check (length(btrim(source)) > 0),
  constraint webhook_inbox_method_not_blank
    check (length(btrim(request_method)) > 0),
  constraint webhook_inbox_body_size_nonnegative
    check (body_size_bytes >= 0),
  constraint webhook_inbox_sha256_format
    check (body_sha256 ~ '^[0-9a-f]{64}$'),
  constraint webhook_inbox_headers_is_object
    check (jsonb_typeof(sanitized_headers) = 'object'),
  constraint webhook_inbox_query_is_object
    check (jsonb_typeof(sanitized_query_params) = 'object'),
  constraint webhook_inbox_json_consistency
    check (body_is_json or body_json is null),
  constraint webhook_inbox_encryption_key_version_positive
    check (encryption_key_version > 0),
  constraint webhook_inbox_ingest_version_positive
    check (ingest_version > 0)
) partition by hash (id);

-- UUIDs aleatorios distribuem a escrita entre particoes e evitam um unico
-- indice quente durante rajadas de ingestao.
do $partitions$
declare
  partition_number integer;
begin
  for partition_number in 0..15 loop
    execute format(
      'create table public.webhook_inbox_p%s partition of public.webhook_inbox for values with (modulus 16, remainder %s)',
      lpad(partition_number::text, 2, '0'),
      partition_number
    );
  end loop;
end
$partitions$;

comment on table public.webhook_inbox is
  'Append-only inbox. One row represents one authenticated HTTP delivery, including retries.';
comment on column public.webhook_inbox.encrypted_envelope_base64 is
  'Complete normalized HTTP request envelope encrypted with AES-256-GCM.';
comment on column public.webhook_inbox.body_sha256 is
  'SHA-256 of the exact request body bytes; useful for integrity checks, never for dropping retries.';

create index webhook_inbox_received_at_idx
  on public.webhook_inbox (received_at desc);
create index webhook_inbox_source_received_at_idx
  on public.webhook_inbox (source, received_at desc);
create index webhook_inbox_source_event_id_idx
  on public.webhook_inbox (source, source_event_id)
  where source_event_id is not null;
create index webhook_inbox_body_sha256_idx
  on public.webhook_inbox (body_sha256);

alter table public.webhook_inbox enable row level security;

-- A caixa de entrada e append-only. Clientes nunca acessam a tabela e a Edge
-- Function pode apenas inserir e confirmar a linha gravada.
revoke all on table public.webhook_inbox from anon, authenticated, service_role;
grant select, insert on table public.webhook_inbox to service_role;

do $partition_permissions$
declare
  partition_number integer;
begin
  for partition_number in 0..15 loop
    execute format(
      'revoke all on table public.webhook_inbox_p%s from anon, authenticated, service_role',
      lpad(partition_number::text, 2, '0')
    );
  end loop;
end
$partition_permissions$;

commit;
