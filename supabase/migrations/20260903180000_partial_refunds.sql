begin;

-- Reembolso parcial deixa de ser tratado como reembolso total. Ele vira o
-- estado `partially_refunded`: a venda continua aprovada e baixada na Conta
-- Azul e o mesmo registro recebe a anotação do valor devolvido e do valor
-- mantido. Só reembolso total, cancelamento e chargeback cancelam a venda.

alter table public.conta_azul_orders
  drop constraint conta_azul_orders_status;
alter table public.conta_azul_orders
  add constraint conta_azul_orders_status
  check (normalized_status in (
    'pending', 'paid', 'rejected', 'cancelled', 'refunded', 'partially_refunded', 'chargeback', 'unknown'
  ));

alter table public.conta_azul_order_events
  drop constraint conta_azul_order_events_status;
alter table public.conta_azul_order_events
  add constraint conta_azul_order_events_status
  check (normalized_status in (
    'pending', 'paid', 'rejected', 'cancelled', 'refunded', 'partially_refunded', 'chargeback', 'unknown'
  ));

-- O portal do aluno lê o mesmo modelo. Um reembolso parcial não revoga acesso
-- (só reversões terminais revogam), mas o estado precisa ser aceito na tabela.
alter table public.student_portal_enrollments
  drop constraint student_portal_enrollments_status;
alter table public.student_portal_enrollments
  add constraint student_portal_enrollments_status
  check (normalized_status in (
    'pending', 'paid', 'rejected', 'cancelled', 'refunded', 'partially_refunded', 'chargeback', 'unknown'
  ));

alter table public.student_portal_enrollment_events
  drop constraint student_portal_enrollment_events_status;
alter table public.student_portal_enrollment_events
  add constraint student_portal_enrollment_events_status
  check (normalized_status in (
    'pending', 'paid', 'rejected', 'cancelled', 'refunded', 'partially_refunded', 'chargeback', 'unknown'
  ));

alter table public.conta_azul_orders
  add column if not exists refunded_amount numeric(14, 2);
alter table public.conta_azul_orders
  add constraint conta_azul_orders_refunded_amount_nonnegative
  check (refunded_amount is null or refunded_amount >= 0);

comment on column public.conta_azul_orders.refunded_amount is
  'Valor devolvido ao comprador segundo o último evento da origem. Null quando a plataforma não informa (Hotmart).';

commit;
