begin;

-- O Academy Pass dá acesso ao portal do Agent Lab independentemente de onde foi
-- vendido, e ele também é vendido na Hotmart. Sem estas linhas, o comprador da
-- Hotmart nunca chegava ao portal: o worker resolvia a oferta pelo produto e não
-- encontrava nenhuma para a plataforma.
--
-- São dois cadastros do mesmo passe na Hotmart. A janela é a mesma da oferta
-- Zouti (20260903230000) para que a turma seja a mesma nas duas plataformas.
insert into public.student_portal_offers (
  source_platform,
  source_product_id,
  edition_code,
  product_label,
  enabled,
  starts_at,
  ends_at,
  grants_replay
) values
  ('hotmart', '7295817', 'agent-lab-3', 'AcademyPass (Hotmart)', true, timestamptz '2026-08-02 00:00:00+00', null, true),
  ('hotmart', '6445569', 'agent-lab-3', 'Academy Pass (Hotmart)', true, timestamptz '2026-08-02 00:00:00+00', null, true)
on conflict do nothing;

commit;
