begin;

-- O portal distingue quem tem acesso ao conteúdo gravado (`temReplay` no corpo
-- da matrícula), mas o middleware nunca enviava esse campo: toda matrícula saía
-- daqui como se fosse só ingresso. Quem comprou o formato de aulas entrava na
-- edição com o replay trancado.
--
-- A informação é do produto, não da edição: na mesma turma convivem os dois
-- tipos de compra, então a coluna fica na oferta.
alter table public.student_portal_offers
  add column grants_replay boolean not null default false;

comment on column public.student_portal_offers.grants_replay is
  'Produto libera o conteúdo gravado. Vira `temReplay` no corpo enviado ao portal; uma ordem que casa com mais de uma oferta libera o replay se qualquer uma delas liberar.';

update public.student_portal_offers
set
  grants_replay = true,
  updated_at = clock_timestamp()
where source_platform = 'zouti'
  and source_product_id = 'prod_bnu9ruwkloz9zbiwn504oh';

commit;
