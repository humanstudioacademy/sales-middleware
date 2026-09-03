begin;

-- O Academy Pass dá acesso ao portal do Agent Lab, mas nunca esteve em
-- `student_portal_offers`. Toda venda em que ele era o único produto elegível
-- parava em `student_portal_skipped_events` com
-- `no_student_portal_offer_mapped`, e o comprador ficava sem acesso — de
-- 02/08/2026 até hoje.
--
-- A janela começa na primeira venda do produto para não deixar ninguém de fora,
-- e fica aberta: quem compra o passe anual entra na turma vigente.
--
-- `grants_replay` é verdadeiro porque o passe é o produto de acesso completo,
-- que inclui o conteúdo gravado. Se o combinado for o contrário, basta
-- `update public.student_portal_offers set grants_replay = false where
-- source_product_id = 'prod_2v522qeto0vd2ocv17jw9b';`.
insert into public.student_portal_offers (
  source_platform,
  source_product_id,
  edition_code,
  product_label,
  enabled,
  starts_at,
  ends_at,
  grants_replay
) values (
  'zouti',
  'prod_2v522qeto0vd2ocv17jw9b',
  'agent-lab-3',
  'Academy Pass',
  true,
  timestamptz '2026-08-02 00:00:00+00',
  null,
  true
)
on conflict do nothing;

commit;
