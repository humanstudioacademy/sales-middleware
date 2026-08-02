begin;

create table public.oauth_authorization_states (
  state_sha256 text primary key,
  provider text not null,
  redirect_uri text not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz,

  constraint oauth_authorization_states_hash_format
    check (state_sha256 ~ '^[0-9a-f]{64}$'),
  constraint oauth_authorization_states_provider
    check (provider in ('conta_azul')),
  constraint oauth_authorization_states_expiry
    check (expires_at > created_at)
);

create index oauth_authorization_states_expiry_idx
  on public.oauth_authorization_states (expires_at)
  where consumed_at is null;

create table public.conta_azul_connections (
  id uuid primary key default gen_random_uuid(),
  external_account_id text unique,
  status text not null default 'active',
  encrypted_access_token_base64 text not null,
  access_token_iv_base64 text not null,
  encrypted_refresh_token_base64 text not null,
  refresh_token_iv_base64 text not null,
  encryption_algorithm text not null default 'AES-256-GCM',
  encryption_key_version integer not null default 1,
  access_token_expires_at timestamptz not null,
  granted_scope text,
  refresh_lease_token uuid,
  refresh_lease_until timestamptz,
  last_refreshed_at timestamptz,
  last_verified_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),

  constraint conta_azul_connections_status
    check (status in ('active', 'refreshing', 'error', 'revoked')),
  constraint conta_azul_connections_key_version
    check (encryption_key_version > 0),
  constraint conta_azul_connections_lease_consistency
    check (
      (refresh_lease_token is null and refresh_lease_until is null)
      or (refresh_lease_token is not null and refresh_lease_until is not null)
    )
);

create unique index conta_azul_single_usable_connection_idx
  on public.conta_azul_connections ((true))
  where status in ('active', 'refreshing');

create table public.conta_azul_sale_links (
  webhook_id uuid primary key references public.webhook_inbox(id),
  conta_azul_sale_id text not null unique,
  request_fingerprint text not null unique,
  sale_number text,
  created_at timestamptz not null default clock_timestamp(),

  constraint conta_azul_sale_links_fingerprint_format
    check (request_fingerprint ~ '^[0-9a-f]{64}$')
);

create table public.integration_worker_leases (
  destination text primary key references public.integration_destinations(destination),
  lease_token uuid,
  lease_until timestamptz,
  updated_at timestamptz not null default clock_timestamp(),

  constraint integration_worker_leases_consistency
    check (
      (lease_token is null and lease_until is null)
      or (lease_token is not null and lease_until is not null)
    )
);

insert into public.integration_worker_leases (destination)
values ('conta_azul');

alter table public.oauth_authorization_states enable row level security;
alter table public.conta_azul_connections enable row level security;
alter table public.conta_azul_sale_links enable row level security;
alter table public.integration_worker_leases enable row level security;

revoke all on table public.oauth_authorization_states from anon, authenticated, service_role;
revoke all on table public.conta_azul_connections from anon, authenticated, service_role;
revoke all on table public.conta_azul_sale_links from anon, authenticated, service_role;
revoke all on table public.integration_worker_leases from anon, authenticated, service_role;

grant select, insert, update, delete on table public.oauth_authorization_states to service_role;
grant select, insert, update on table public.conta_azul_connections to service_role;
grant select, insert on table public.conta_azul_sale_links to service_role;

create or replace function acquire_integration_worker_lease(
  p_destination text,
  p_lease_token uuid,
  p_lease_seconds integer default 55
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed integer;
begin
  update public.integration_worker_leases
  set
    lease_token = p_lease_token,
    lease_until = clock_timestamp()
      + make_interval(secs => least(greatest(p_lease_seconds, 10), 300)),
    updated_at = clock_timestamp()
  where destination = p_destination
    and (lease_until is null or lease_until < clock_timestamp());

  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

revoke all on function acquire_integration_worker_lease(text, uuid, integer)
  from public, anon, authenticated;
grant execute on function acquire_integration_worker_lease(text, uuid, integer)
  to service_role;

create or replace function release_integration_worker_lease(
  p_destination text,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed integer;
begin
  update public.integration_worker_leases
  set lease_token = null, lease_until = null, updated_at = clock_timestamp()
  where destination = p_destination
    and lease_token = p_lease_token;

  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

revoke all on function release_integration_worker_lease(text, uuid)
  from public, anon, authenticated;
grant execute on function release_integration_worker_lease(text, uuid)
  to service_role;

create or replace function consume_conta_azul_oauth_state(p_state_sha256 text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  matched_redirect_uri text;
begin
  update public.oauth_authorization_states
  set consumed_at = clock_timestamp()
  where state_sha256 = p_state_sha256
    and provider = 'conta_azul'
    and consumed_at is null
    and expires_at > clock_timestamp()
  returning redirect_uri into matched_redirect_uri;

  return matched_redirect_uri;
end;
$$;

revoke all on function consume_conta_azul_oauth_state(text) from public, anon, authenticated;
grant execute on function consume_conta_azul_oauth_state(text) to service_role;

create or replace function acquire_conta_azul_refresh_lease(
  p_connection_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer default 30
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed integer;
begin
  update public.conta_azul_connections
  set
    status = 'refreshing',
    refresh_lease_token = p_lease_token,
    refresh_lease_until = clock_timestamp()
      + make_interval(secs => least(greatest(p_lease_seconds, 10), 120)),
    updated_at = clock_timestamp()
  where id = p_connection_id
    and status in ('active', 'refreshing')
    and (refresh_lease_until is null or refresh_lease_until < clock_timestamp());

  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

revoke all on function acquire_conta_azul_refresh_lease(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function acquire_conta_azul_refresh_lease(uuid, uuid, integer)
  to service_role;

create or replace function finish_conta_azul_token_refresh(
  p_connection_id uuid,
  p_lease_token uuid,
  p_encrypted_access_token_base64 text,
  p_access_token_iv_base64 text,
  p_encrypted_refresh_token_base64 text,
  p_refresh_token_iv_base64 text,
  p_access_token_expires_at timestamptz,
  p_granted_scope text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed integer;
begin
  update public.conta_azul_connections
  set
    status = 'active',
    encrypted_access_token_base64 = p_encrypted_access_token_base64,
    access_token_iv_base64 = p_access_token_iv_base64,
    encrypted_refresh_token_base64 = p_encrypted_refresh_token_base64,
    refresh_token_iv_base64 = p_refresh_token_iv_base64,
    access_token_expires_at = p_access_token_expires_at,
    granted_scope = coalesce(p_granted_scope, granted_scope),
    refresh_lease_token = null,
    refresh_lease_until = null,
    last_refreshed_at = clock_timestamp(),
    last_error_code = null,
    last_error_message = null,
    updated_at = clock_timestamp()
  where id = p_connection_id
    and refresh_lease_token = p_lease_token;

  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

revoke all on function finish_conta_azul_token_refresh(
  uuid, uuid, text, text, text, text, timestamptz, text
) from public, anon, authenticated;
grant execute on function finish_conta_azul_token_refresh(
  uuid, uuid, text, text, text, text, timestamptz, text
) to service_role;

create or replace function fail_conta_azul_token_refresh(
  p_connection_id uuid,
  p_lease_token uuid,
  p_error_code text,
  p_error_message text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed integer;
begin
  update public.conta_azul_connections
  set
    status = case
      when p_error_code = 'token_refresh_terminal' then 'error'
      else 'active'
    end,
    refresh_lease_token = null,
    refresh_lease_until = null,
    last_error_code = left(p_error_code, 200),
    last_error_message = left(p_error_message, 2000),
    updated_at = clock_timestamp()
  where id = p_connection_id
    and refresh_lease_token = p_lease_token;

  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

revoke all on function fail_conta_azul_token_refresh(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function fail_conta_azul_token_refresh(uuid, uuid, text, text)
  to service_role;

commit;
