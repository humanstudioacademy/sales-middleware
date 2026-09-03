# Conciliação Hotmart × Conta Azul (SquadHub) — 03/09/2026

Leitura feita pela API da Conta Azul (somente GET) sobre a conta
"Hotmart - Conta Corrente", competência a partir de 01/07/2026. O código da
transação (`HP…`) foi lido da nota de cada parcela, onde o SquadHub o gravava.

- `reconciliacao-transacoes-middleware.csv`: uma linha por transação paga que o
  middleware recebeu (112). `situation`: `lancado` (1 lançamento no SquadHub),
  `duplicado` (2 lançamentos: um por PURCHASE_APPROVED e outro por
  PURCHASE_COMPLETE), `faltando`.
- `lancamentos-em-dobro-para-excluir.csv`: para cada `HP…` com mais de um
  lançamento, o id do lançamento a manter (o mais antigo) e os ids a excluir.
  Cobre também transações anteriores à inbox do middleware.
- `lancamentos-squadhub-fora-do-middleware.csv`: referências que o SquadHub
  lançou e que o middleware nunca recebeu (compras anteriores a 02/08/2026).

Nada foi alterado na Conta Azul. As transações do middleware já lançadas pelo
SquadHub estão em `conta_azul_external_postings`, então o worker nunca cria
venda para elas, com qualquer data de corte.
