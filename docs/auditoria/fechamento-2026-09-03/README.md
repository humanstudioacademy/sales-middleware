# Fechamento de agosto e setembro de 2026

Auditoria e correções feitas em 03/09/2026 nas duas frentes do middleware:
lançamento na Conta Azul e matrícula no portal do Agent Lab.

## 1. Conta Azul — Zouti

Reconciliação de toda transação Zouti criada entre 01/08 e 30/09, comparando o
último evento recebido de cada pedido com o que existe na Conta Azul.

| Situação final na Zouti | Transações | Com venda | Correto porque |
|---|---|---|---|
| Paga | 458 | 458 | toda venda paga está lançada |
| Reembolsada | 35 | 27 canceladas | as 8 sem venda foram reembolsadas integralmente, saldo zero |
| Aguardando pagamento | 16 | 0 | não houve receita |
| Não paga | 76 | 0 | não houve receita |

Contagem confirmada do lado da Conta Azul pela API: 328 vendas em agosto e 130
em setembro, exatamente a mesma quantidade de pedidos pagos.

Sem duplicidade: 659 linhas de pedido, 659 identificadores distintos, 486
vendas, 486 UUIDs distintos e 486 números distintos. A relação é sempre um
para um, garantida por chave única e por gatilho que impede trocar a venda
vinculada depois de criada.

### Correção de caixa

A baixa informava como taxa apenas a tarifa do gateway (`payment.fee`). A Zouti
também retém a maior parte dos juros do parcelamento: o líquido que ela repassa
é o valor cobrado menos a tarifa **e** menos a diferença entre
`interest_amount` e `interest_transfer_amount`. Como a Conta Azul calcula o
valor recebido como bruto menos taxa, o caixa ficava maior que o dinheiro que
entrou.

- 185 vendas afetadas (159 em agosto, 26 em setembro)
- R$ 47.721,31 de caixa a mais
- Corrigido no código e todas as 185 baixas refeitas

Depois da correção, o caixa registrado na Conta Azul:

| Mês | Vendas | Recebido | Pago pelos clientes |
|---|---|---|---|
| Agosto | 328 | R$ 459.581,36 | R$ 521.536,13 |
| Setembro | 130 | R$ 31.153,86 | R$ 34.557,15 |

Confrontando venda a venda com o líquido informado pela Zouti, 452 das 458
batem ao centavo. As 6 restantes são pagamentos divididos, e a diferença é
exatamente o valor das partes cuja tarifa a Zouti não informa: R$ 7.651,40 em
agosto e R$ 44,90 em setembro. Está tudo em
`03-pagamento-dividido-tarifa-pendente.csv`; assim que a tarifa real for
registrada em `platform_fee_adjustments`, a baixa passa a refleti-la.

### Pedidos reembolsados sem venda lançada

Três pedidos foram pagos e depois reembolsados integralmente sem que a venda
chegasse a ser criada, porque o evento de pagamento ficou preso em dead-letter e,
quando foi reprocessado, o pedido já constava reembolsado. O efeito financeiro é
zero e a auditoria local registra os dois momentos.

`ord_6iuoqgkrm4xyfiwxxjqrdt`, `ord_b2uy63tbyygxwory0o68nq`,
`ord_cu5sdf8kexrt34hk71ebp6`.

## 2. Conta Azul — Hotmart

Agosto e setembro da Hotmart **não** foram lançados pelo middleware: o corte
está em 03/09 17:50, quando o app SquadHub foi removido. Todo o período está na
Conta Azul pelos lançamentos que o SquadHub criou, e 57 transações têm
lançamento em dobro porque ele reagia tanto ao evento de compra aprovada quanto
ao de compra concluída.

Nenhuma das parcelas criadas pelo SquadHub tem baixa ou conciliação, então
excluí-las não desfaz trabalho do financeiro.

O que esses lançamentos fazem com o resultado de agosto e setembro:

| Problema | Ocorrências | Valor |
|---|---|---|
| Transação lançada em dobro | 57 | R$ 1.025.244,57 |
| Reembolso ou chargeback nunca revertido | 20 | R$ 50.706,72 |
| Total lançado pelo SquadHub no período | 152 | R$ 2.125.198,09 |

O segundo item é o mais silencioso: o SquadHub lançava a receita na compra e
nunca reagia ao reembolso, então 20 compras devolvidas continuam na Conta Azul
como valor a receber. O middleware trata isso sozinho — cancela a venda e
estorna a baixa quando o reembolso chega.

- `01-excluir-na-conta-azul.csv` — os 152 lançamentos a excluir, por cliente,
  com competência, valor, quantidade de parcelas e o código da transação.
- `02-hotmart-a-relancar.csv` — as 96 transações que o middleware relança em
  seguida, com o resultado esperado de cada uma: 75 vendas aprovadas e 21
  canceladas por reembolso ou chargeback.

Depois da exclusão, o middleware recria tudo no mesmo formato da Zouti: uma
venda por transação, com baixa pelo valor líquido na data em que a Hotmart
pagou, e o código `HP…` no NSU e nas observações.

### Como excluir

A API da Conta Azul não tem exclusão de lançamento financeiro — só de baixa e
de cobrança. A remoção é pela tela, em lote:

Financeiro › Visão de competência › mês **Agosto de 2026** › pesquisar
`Venda Hotmart` › Mais filtros: Conta = Hotmart - Conta Corrente, Origem =
Lançamento Financeiro › aumentar registros por página › marcar o checkbox do
cabeçalho › **Excluir lançamento(s)**. Repetir até acabar (144 lançamentos) e
fazer o mesmo em **Setembro de 2026** (8). Julho não entra no filtro.

### Como relançar, depois da exclusão

Um comando. Ele confere sozinho que não sobrou nenhum lançamento do SquadHub no
período e se recusa a seguir se sobrar:

```
node --env-file=.env scripts/virar-hotmart-para-o-middleware.ts \
  --sequences docs/auditoria/fechamento-2026-09-03/05-sequencias-para-relancar.txt --execute
```

Ele remove as proteções de `conta_azul_external_postings`, recua a data de
corte para 01/08 e sincroniza os 187 eventos das 96 transações em ordem de
ingestão. Resultado esperado: 75 vendas aprovadas e 21 canceladas.

## 3. Portal do Agent Lab

Três causas deixavam comprador sem acesso, as três corrigidas:

0. **A fila do portal nunca recebeu os eventos anteriores à sua criação.** O
   destino foi criado em 03/08, um dia depois de a ingestão começar, e o
   gatilho de ingresso só enfileira o que entra depois dele. Os webhooks das
   sequências 1388 a 3111 — 1.724 recibos — nunca tiveram item nessa fila, e
   por isso não havia o que processar mesmo com a oferta cadastrada. Esta é a
   causa da maior parte dos compradores de agosto sem acesso.

1. **Academy Pass não estava cadastrado como oferta.** Ele dá acesso ao portal,
   mas não existia em `student_portal_offers`. Todo pedido em que era o único
   produto elegível parava como `no_student_portal_offer_mapped`. Vale para as
   duas plataformas: a oferta foi cadastrada para a Zouti e para os dois
   códigos de produto da Hotmart.
2. **O acesso ao conteúdo gravado nunca era enviado.** A coluna `grants_replay`
   existia só no repositório, nunca aplicada em produção, então toda matrícula
   saía com `temReplay: false` e quem comprou o formato de aulas entrava com o
   replay trancado.

Os pedidos pulados foram reprocessados e as matrículas já concedidas foram
reentregues com o acesso correto. O portal é idempotente e não dispara e-mail,
então a reentrega não incomoda quem já tinha acesso.

### Cobertura final

| Origem | Pedidos pagos elegíveis | Com acesso | Sem matrícula |
|---|---|---|---|
| Zouti | 431 | 431 | 0 |
| Hotmart (Academy Pass, desde 02/08) | 41 | 41 | 0 |

As matrículas em `pending` são pedidos que ainda não foram pagos, e as
`revoked` são reembolsos — 16 na Zouti e 14 na Hotmart, todos com o pedido
reembolsado na origem.

## Estado das filas no fechamento

Nenhum item pendente em nenhum destino. Os três únicos registros em dead-letter
são o mesmo recibo de teste da sequência 3858, arquivado de propósito em cada
destino. Nenhuma falha de entrega em aberto.

## 4. Falhas de infraestrutura corrigidas no caminho

- A seleção do próximo item da fila levava cerca de 7 segundos e estourava o
  limite de 8 segundos do PostgREST, então os workers respondiam 503 na maioria
  dos minutos. Reescrita para cerca de 20 milissegundos.
- O número da venda era pedido à Conta Azul e gravado sem olhar os números já
  reservados, então uma reserva que não virou venda travava todas as seguintes.
  Passou a ser reservado no banco.
- O arquivamento do desfecho da entrega colidia na chave única por webhook ao
  reprocessar um item, travando o FIFO da plataforma inteira.
- Telefone recusado pela Conta Azul e documento já pertencente a um contato
  fora do perfil Cliente derrubavam a venda; agora são contornados.
- Desconto maior que o primeiro item gerava item com valor negativo, recusado
  pela Conta Azul.
- Os workers do humanOS e do portal só consumiam a fila da Zouti, então os
  eventos da Hotmart ficariam pendentes para sempre.
