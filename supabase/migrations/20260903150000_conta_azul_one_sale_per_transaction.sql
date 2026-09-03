begin;

-- Uma transação da origem (ord_... na Zouti, HP... na Hotmart) corresponde a no
-- máximo uma venda na Conta Azul. `conta_azul_orders` é a tabela de vínculo:
-- `(source_platform, external_order_id)` é única, e `conta_azul_sale_id` e
-- `conta_azul_sale_number` também. Esta migration fecha as brechas que ainda
-- permitiam ao processo se perder:
--
-- 1. o número da venda era pedido à Conta Azul e gravado sem olhar os números já
--    reservados localmente; quando uma venda falhava depois de reservar o número
--    (ex.: telefone recusado), a Conta Azul devolvia o mesmo "próximo número"
--    para a ordem seguinte e a chave única local rejeitava para sempre — a fila
--    Zouti ficou travada em retry a partir de 07/08/2026 por isso;
-- 2. nada impedia o vínculo com a venda de ser trocado depois de criado;
-- 3. a Hotmart não tinha mapeamento e o worker descobriria conta/categoria
--    sozinho na primeira venda, sem uma decisão explícita de ativação.

comment on table public.conta_azul_orders is
  'Vínculo 1:1 entre a transação na plataforma de origem (source_platform, external_order_id) e a venda na Conta Azul (conta_azul_sale_id, conta_azul_sale_number). Eventos posteriores da mesma transação atualizam esta linha; nunca criam outra venda.';

-- ---------------------------------------------------------------------------
-- Data de corte por plataforma
-- ---------------------------------------------------------------------------
alter table public.conta_azul_platform_mappings
  add column if not exists sync_orders_created_from timestamptz;

comment on column public.conta_azul_platform_mappings.sync_orders_created_from is
  'Ordens criadas na origem antes deste instante são apenas registradas localmente (last_action = recorded_before_cutover) e nunca criam venda na Conta Azul. Usado para virar de uma integração nativa (que já lançou o passado) para o middleware sem lançar duas vezes.';

-- Mapeamento Hotmart desativado de propósito. Ativar é uma decisão operacional:
-- a integração nativa Hotmart → Conta Azul precisa estar desligada antes, senão
-- a mesma compra é lançada por duas fontes. Ver README, seção "Contrato Hotmart".
insert into public.conta_azul_platform_mappings (
  source_platform,
  financial_account_id,
  financial_account_name,
  category_id,
  category_name,
  enabled,
  resolved_at
) values (
  'hotmart',
  '494bacd8-d9d4-45ce-907f-5977188cbb56',
  'Hotmart - Conta Corrente',
  '61f58af3-619d-4aab-9d4d-91b53ed240cb',
  '1.06 Cursos Online B2C',
  false,
  clock_timestamp()
)
on conflict (source_platform) do nothing;

-- ---------------------------------------------------------------------------
-- Identidade e vínculo imutáveis
-- ---------------------------------------------------------------------------
create or replace function public.guard_conta_azul_order_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.source_platform is distinct from old.source_platform
    or new.external_order_id is distinct from old.external_order_id then
    raise exception 'conta_azul_orders identity is immutable (%/%)',
      old.source_platform, old.external_order_id;
  end if;

  if old.conta_azul_sale_id is not null
    and new.conta_azul_sale_id is distinct from old.conta_azul_sale_id then
    raise exception 'conta_azul_orders.conta_azul_sale_id is immutable once linked (%/%: % -> %)',
      old.source_platform, old.external_order_id, old.conta_azul_sale_id,
      coalesce(new.conta_azul_sale_id, 'null');
  end if;

  if old.conta_azul_sale_id is not null
    and new.conta_azul_sale_number is distinct from old.conta_azul_sale_number then
    raise exception 'conta_azul_orders.conta_azul_sale_number is immutable once the sale is linked (%/%)',
      old.source_platform, old.external_order_id;
  end if;

  return new;
end;
$$;

drop trigger if exists conta_azul_orders_guard_identity on public.conta_azul_orders;
create trigger conta_azul_orders_guard_identity
  before update on public.conta_azul_orders
  for each row
  execute function public.guard_conta_azul_order_identity();

-- ---------------------------------------------------------------------------
-- Reserva atômica do número da venda
-- ---------------------------------------------------------------------------
-- O candidato vem de `/v1/venda/proximo-numero`. O número reservado é o maior
-- entre o candidato e o sucessor do maior número já reservado por outra ordem,
-- então uma ordem que reservou um número e nunca criou a venda não bloqueia as
-- seguintes. Uma ordem já vinculada a uma venda devolve o número que já tem.
create or replace function public.reserve_conta_azul_sale_number(
  p_order_id uuid,
  p_candidate bigint
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_row public.conta_azul_orders%rowtype;
  reserved bigint;
begin
  if p_candidate is null or p_candidate < 1 then
    raise exception 'Sale number candidate must be positive';
  end if;

  perform pg_advisory_xact_lock(hashtext('conta_azul_sale_number'));

  select *
  into current_row
  from public.conta_azul_orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Conta Azul order not found';
  end if;

  if current_row.conta_azul_sale_id is not null then
    return current_row.conta_azul_sale_number;
  end if;

  select greatest(p_candidate, coalesce(max(orders.conta_azul_sale_number), 0) + 1)
  into reserved
  from public.conta_azul_orders as orders
  where orders.id <> p_order_id;

  update public.conta_azul_orders
  set
    conta_azul_sale_number = reserved,
    last_action = case
      when conta_azul_sale_number is not null and conta_azul_sale_number <> reserved
        then 'sale_number_reallocated'
      else 'syncing'
    end,
    updated_at = clock_timestamp()
  where id = p_order_id;

  return reserved;
end;
$$;

revoke all on function public.reserve_conta_azul_sale_number(uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.reserve_conta_azul_sale_number(uuid, bigint)
  to service_role;

commit;
