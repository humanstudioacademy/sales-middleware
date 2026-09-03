begin;

-- A oferta "Agent lab (formato de aulas)" ficou com `grants_replay = false`
-- quando a coluna foi criada, porque a correção mirou só o produto da edição
-- vigente. É o mesmo tipo de produto — quem compra o formato de aulas compra o
-- conteúdo gravado —, então quem comprou por ela entrava na turma sem o replay.
update public.student_portal_offers
set grants_replay = true, updated_at = clock_timestamp()
where source_platform = 'zouti'
  and source_product_id = 'prod_zkkw399kx1v3cgyfmkrgbl'
  and not grants_replay;

commit;
