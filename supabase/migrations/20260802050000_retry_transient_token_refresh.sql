begin;

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
