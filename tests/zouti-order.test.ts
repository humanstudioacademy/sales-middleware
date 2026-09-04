import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContaAzulPerson,
  buildContaAzulSale,
  classifyOrderTransition,
  classifyInboundCommerceEvent,
  contaAzulAddress,
  contaAzulMobilePhone,
  contaAzulPaymentMethod,
  contaAzulSku,
  desiredOrderAction,
  isCancelledSaleSituation,
  normalizeOrderStatus,
  parseZoutiOrder,
  reconcileCustomerMatchIds,
  saleObservationsBelongToOrder,
  settlementComposition,
} from "../supabase/functions/_shared/zouti-order.ts";

test("recognizes an already cancelled Conta Azul sale idempotently", () => {
  assert.equal(isCancelledSaleSituation("CANCELADO"), true);
  assert.equal(isCancelledSaleSituation(" cancelado "), true);
  assert.equal(isCancelledSaleSituation("APROVADO"), false);
  assert.equal(isCancelledSaleSituation(null), false);
});

test("recognizes the durable Zouti order marker in Conta Azul observations", () => {
  assert.equal(saleObservationsBelongToOrder("Pedido Zouti: ord_123", "ord_123"), true);
  assert.equal(saleObservationsBelongToOrder("HumanOS | ordem ord_123", "ord_123"), true);
  assert.equal(saleObservationsBelongToOrder("Pedido Zouti: ord_other", "ord_123"), false);
});

test("omits phones Conta Azul would reject instead of failing the sale", () => {
  assert.equal(contaAzulMobilePhone("11999999999"), "11999999999");
  assert.equal(contaAzulMobilePhone("999999999"), "999999999");
  assert.equal(contaAzulMobilePhone("1133334444"), null);
  assert.equal(contaAzulMobilePhone("542214358187"), null);
  assert.equal(contaAzulMobilePhone("351910677536"), null);
  assert.equal(contaAzulMobilePhone(null), null);

  const foreign = parseZoutiOrder({
    ...paidPayload,
    customer: { ...paidPayload.customer, phone: "+351 910 677 536" },
  }, "zouti");
  const person = buildContaAzulPerson(foreign);
  assert.equal(person.telefone_celular, undefined);
  assert.match(String(person.observacao), /telefone informado: 351910677536/);
});

test("omits address fields Conta Azul would reject instead of losing the customer", () => {
  // Endereço estrangeiro: sigla de país vira nome, CEP e UF de fora ficam fora.
  assert.deepEqual(
    contaAzulAddress({
      postalCode: "1925",
      street: "-",
      number: null,
      complement: null,
      neighborhood: null,
      city: "Buenos Aires",
      state: "Buenos Aires",
      country: "AR",
    }),
    { logradouro: "-", cidade: "Buenos Aires", pais: "Argentina" },
  );

  // Brasileiro completo passa inteiro, com a UF em maiúsculas.
  assert.deepEqual(
    contaAzulAddress({
      postalCode: "04533-010",
      street: "Rua Tabapuã",
      number: "281",
      complement: "112",
      neighborhood: "Itaim Bibi",
      city: "São Paulo",
      state: "sp",
      country: "BR",
    }),
    {
      cep: "04533010",
      logradouro: "Rua Tabapuã",
      numero: "281",
      complemento: "112",
      bairro: "Itaim Bibi",
      cidade: "São Paulo",
      estado: "SP",
      pais: "Brasil",
    },
  );

  // CEP fora do formato brasileiro é descartado em vez de derrubar o cadastro.
  const semCep = contaAzulAddress({
    postalCode: "123",
    street: null,
    number: null,
    complement: null,
    neighborhood: null,
    city: "Curitiba",
    state: "PR",
    country: "BR",
  });
  assert.equal(semCep?.cep, undefined);
  assert.equal(semCep?.estado, "PR");

  // País desconhecido e sem cidade não vira endereço nenhum.
  assert.equal(
    contaAzulAddress({
      postalCode: null,
      street: null,
      number: null,
      complement: null,
      neighborhood: null,
      city: null,
      state: null,
      country: "ZZ",
    }),
    null,
  );
  assert.equal(contaAzulAddress(null), null);
});

test("prefixes catalog SKUs by platform so links never collide", () => {
  assert.equal(contaAzulSku("prod_abc123"), "ZO00000000PRODABC123");
  assert.equal(contaAzulSku("prod_abc123", "zouti"), "ZO00000000PRODABC123");
  assert.equal(contaAzulSku("7295817", "hotmart"), "HM000000000007295817");
});

test("reconciles customer matches across document, email and phone", () => {
  assert.equal(reconcileCustomerMatchIds([["person-1"], ["person-1"], []]), "person-1");
  assert.equal(reconcileCustomerMatchIds([[], [], []]), null);
  assert.throws(
    () => reconcileCustomerMatchIds([["person-1"], ["person-2"], []]),
    /identity conflict/,
  );
});

const paidPayload = {
  id: "ord_example_123",
  provider: "ZOUTI",
  status: "PAID",
  currency: "BRL",
  created_at: "2026-08-02T10:00:00.000Z",
  updated_at: "2026-08-02T10:00:00.000Z",
  amount_total: 9790,
  amount_total_in_brl: 97.9,
  amount_subtotal: 9700,
  amount_subtotal_in_brl: 97,
  payment_type: "ONE_TIME",
  order_session_id: "session_example_123",
  customer_id: "cus_example_123",
  customer: {
    name: "Cliente Exemplo",
    document: "123.456.789-01",
    email: "cliente@example.test",
    phone: "+55 11 99999-9999",
  },
  shipping_address: {
    line1: "Rua Exemplo",
    line2: "123",
    line3: "Sala 1",
    neighborhood: "Centro",
    city: "São Paulo",
    state: "SP",
    country: "BR",
    postal_code: "01001-000",
  },
  items: [{
    product_id: "prod_example_123456789",
    name: "Curso Exemplo",
    description: "Curso online",
    type: "SKU",
    quantity: 1,
    amount: 9700,
    amount_in_brl: 97,
  }],
  payment: {
    method: "PIX",
    installments: 1,
    amount: 9790,
    amount_in_brl: 97.9,
    net_amount: 9500,
    net_amount_in_brl: 95,
    fee: 290,
    fee_in_brl: 2.9,
    interest_amount: 90,
    interest_amount_in_brl: 0.9,
    interest_transfer_amount: 0,
    interest_transfer_amount_in_brl: 0,
  },
  split_payments: [
    { role: "PAYMENT_0", method: "CREDIT_CARD", amount: 5000 },
    { role: "PAYMENT_1", method: "PIX", amount: 4790 },
  ],
  utm_data: {
    utm_source: "instagram",
    utm_medium: "paid_social",
    utm_campaign: "academy_pass",
  },
};

test("parses a Zouti order and normalizes monetary/customer fields", () => {
  const order = parseZoutiOrder(paidPayload, "zouti");
  assert.equal(order.externalOrderId, "ord_example_123");
  assert.equal(order.normalizedStatus, "paid");
  assert.equal(order.totalAmount, 97.9);
  assert.equal(order.customer.document, "12345678901");
  assert.equal(order.customer.phone, "11999999999");
  assert.equal(order.items[0].unitAmount, 97);
  assert.equal(order.subtotalAmount, 97);
  assert.equal(order.interestAmount, 0.9);
  assert.equal(order.paymentType, "ONE_TIME");
  assert.equal(order.attribution.utm_campaign, "academy_pass");
  assert.equal(contaAzulPaymentMethod(order), "OUTRO");
});

test("maps supported lifecycle statuses and protects a settled order from regressions", () => {
  assert.equal(normalizeOrderStatus("REFUSED"), "rejected");
  assert.equal(normalizeOrderStatus("REFUNDED"), "refunded");
  assert.equal(normalizeOrderStatus("CHARGEBACK"), "chargeback");
  assert.equal(normalizeOrderStatus("AWAITING_PAYMENT"), "pending");
  assert.equal(normalizeOrderStatus("UNPAID"), "pending");
  assert.equal(normalizeOrderStatus("something-new"), "unknown");

  const paid = parseZoutiOrder(paidPayload, "zouti");
  const previous = {
    lastIngestSequence: 10,
    lastSourceUpdatedAt: paid.sourceUpdatedAt,
    payloadFingerprint: "a".repeat(64),
    normalizedStatus: "paid" as const,
  };
  const rejected = parseZoutiOrder({
    ...paidPayload,
    status: "REJECTED",
    updated_at: "2026-08-02T11:00:00.000Z",
  }, "zouti");
  const refunded = parseZoutiOrder({
    ...paidPayload,
    status: "REFUNDED",
    updated_at: "2026-08-02T12:00:00.000Z",
  }, "zouti");

  assert.equal(classifyOrderTransition(previous, rejected, 11, "b".repeat(64)), "stale");
  assert.equal(classifyOrderTransition(previous, refunded, 12, "c".repeat(64)), "apply");
  assert.equal(desiredOrderAction(refunded.normalizedStatus, true), "cancel_sale");
  assert.equal(desiredOrderAction(rejected.normalizedStatus, false), "record_only");
});

test("routes only canonical Zouti orders to sale processing", () => {
  assert.equal(classifyInboundCommerceEvent(paidPayload, "zouti").disposition, "process_order");
  assert.deepEqual(classifyInboundCommerceEvent({
    id: "pmt_example_123",
    order_id: "ord_example_123",
    status: "PAID",
  }, "zouti"), {
    disposition: "defer",
    entityKind: "payment",
    externalEntityId: "pmt_example_123",
    relatedOrderId: "ord_example_123",
    sourceStatus: "PAID",
    reason: "auxiliary_event_requires_correlation",
  });
  assert.equal(classifyInboundCommerceEvent({ event: "PURCHASE_APPROVED" }, "hotmart").disposition, "defer");
});

test("allows a chargeback to supersede a refund but never regress it", () => {
  const refunded = parseZoutiOrder({
    ...paidPayload,
    status: "REFUNDED",
    updated_at: "2026-08-02T11:00:00.000Z",
  }, "zouti");
  const chargeback = parseZoutiOrder({
    ...paidPayload,
    status: "DISPUTED",
    updated_at: "2026-08-02T12:00:00.000Z",
  }, "zouti");
  const previous = {
    lastIngestSequence: 20,
    lastSourceUpdatedAt: refunded.sourceUpdatedAt,
    payloadFingerprint: "d".repeat(64),
    normalizedStatus: "refunded" as const,
  };
  assert.equal(classifyOrderTransition(previous, chargeback, 21, "e".repeat(64)), "apply");
  assert.equal(classifyOrderTransition({ ...previous, normalizedStatus: "chargeback" }, refunded, 22, "f".repeat(64)), "stale");
});

test("never reactivates a cancelled order and ignores an identical paid webhook", () => {
  const paid = parseZoutiOrder(paidPayload, "zouti");
  const cancelled = parseZoutiOrder({
    ...paidPayload,
    status: "CANCELLED",
    updated_at: "2026-08-02T12:00:00.000Z",
  }, "zouti");

  assert.equal(classifyOrderTransition({
    lastIngestSequence: 30,
    lastSourceUpdatedAt: paid.sourceUpdatedAt,
    payloadFingerprint: "a".repeat(64),
    normalizedStatus: "paid",
    lastAction: "sale_created",
  }, paid, 31, "a".repeat(64)), "duplicate");

  assert.equal(classifyOrderTransition({
    lastIngestSequence: 40,
    lastSourceUpdatedAt: cancelled.sourceUpdatedAt,
    payloadFingerprint: "b".repeat(64),
    normalizedStatus: "cancelled",
    lastAction: "sale_cancelled",
  }, {
    ...paid,
    sourceUpdatedAt: "2026-08-02T13:00:00.000Z",
  }, 41, "c".repeat(64)), "stale");
});

test("keeps a partially refunded sale alive and annotates it instead of cancelling", () => {
  const partial = parseZoutiOrder({
    ...paidPayload,
    updated_at: "2026-08-10T10:00:00.000Z",
    payment: { ...paidPayload.payment, amount_refunded: 5000 },
  }, "zouti");
  assert.equal(partial.normalizedStatus, "partially_refunded");
  assert.equal(partial.refundedAmount, 50);
  assert.equal(desiredOrderAction(partial.normalizedStatus, true), "annotate_sale");
  assert.equal(desiredOrderAction(partial.normalizedStatus, false), "record_only");

  const fullyRefundedWhilePaid = parseZoutiOrder({
    ...paidPayload,
    payment: { ...paidPayload.payment, amount_refunded: paidPayload.payment.amount },
  }, "zouti");
  assert.equal(fullyRefundedWhilePaid.normalizedStatus, "refunded");

  const explicitPartial = parseZoutiOrder({ ...paidPayload, status: "PARTIALLY_REFUNDED" }, "zouti");
  assert.equal(explicitPartial.normalizedStatus, "partially_refunded");

  const paid = parseZoutiOrder(paidPayload, "zouti");
  const paidState = {
    lastIngestSequence: 50,
    lastSourceUpdatedAt: paid.sourceUpdatedAt,
    payloadFingerprint: "a".repeat(64),
    normalizedStatus: "paid" as const,
    lastAction: "sale_created",
  };
  assert.equal(classifyOrderTransition(paidState, partial, 51, "b".repeat(64)), "apply");

  const partialState = {
    ...paidState,
    lastIngestSequence: 51,
    lastSourceUpdatedAt: partial.sourceUpdatedAt,
    payloadFingerprint: "b".repeat(64),
    normalizedStatus: "partially_refunded" as const,
    lastAction: "sale_partially_refunded",
  };
  const paidAgain = parseZoutiOrder({ ...paidPayload, updated_at: "2026-08-11T10:00:00.000Z" }, "zouti");
  const biggerPartial = parseZoutiOrder({
    ...paidPayload,
    updated_at: "2026-08-12T10:00:00.000Z",
    payment: { ...paidPayload.payment, amount_refunded: 7000 },
  }, "zouti");
  const refunded = parseZoutiOrder({
    ...paidPayload,
    status: "REFUNDED",
    updated_at: "2026-08-13T10:00:00.000Z",
    payment: { ...paidPayload.payment, amount_refunded: paidPayload.payment.amount },
  }, "zouti");
  assert.equal(classifyOrderTransition(partialState, paidAgain, 52, "c".repeat(64)), "stale");
  assert.equal(classifyOrderTransition(partialState, biggerPartial, 53, "d".repeat(64)), "apply");
  assert.equal(classifyOrderTransition(partialState, refunded, 54, "e".repeat(64)), "apply");
  assert.equal(desiredOrderAction(refunded.normalizedStatus, true), "cancel_sale");

  const sale = buildContaAzulSale(partial, {
    customerId: "customer-uuid",
    productIds: ["product-uuid"],
    saleNumber: 961,
    financialAccountId: "account-uuid",
    categoryId: null,
    situation: "APROVADO",
  });
  assert.equal(sale.situacao, "APROVADO");
  assert.match(String(sale.observacoes), /REEMBOLSO PARCIAL/);
  assert.match(String(sale.observacoes), /Valor reembolsado: R\$ 50,00/);
  assert.match(String(sale.observacoes), /Valor mantido: R\$ 47,90 de R\$ 97,90/);
  assert.match(String(sale.observacoes_pagamento), /Valor reembolsado: R\$ 50,00/);
});

test("keeps free bonus items out of the Conta Azul sale and refuses an all-free sale", () => {
  const withBonus = parseZoutiOrder({
    ...paidPayload,
    items: [
      ...paidPayload.items,
      { product_id: "prod_bonus", name: "Bônus", quantity: 1, amount: 0, amount_in_brl: 0 },
    ],
  }, "zouti");
  const sale = buildContaAzulSale(withBonus, {
    customerId: "customer-uuid",
    productIds: ["product-uuid", "bonus-uuid"],
    saleNumber: 1,
    financialAccountId: "account-uuid",
    categoryId: null,
    situation: "APROVADO",
  });
  assert.equal(sale.itens.length, 1);
  assert.equal(sale.itens[0].id, "product-uuid");
  assert.equal(sale.itens[0].valor, 97.9);

  // Desconto maior que o primeiro item: R$ 123,45 cobrados por itens de
  // R$ 49,90 e R$ 197,00. Ratear proporcionalmente mantém os dois positivos.
  const discounted = parseZoutiOrder({
    ...paidPayload,
    amount_total: 12345,
    amount_total_in_brl: 123.45,
    items: [
      { ...paidPayload.items[0], product_id: "prod_a", amount: 4990, amount_in_brl: 49.9 },
      { ...paidPayload.items[0], product_id: "prod_b", amount: 19700, amount_in_brl: 197 },
    ],
  }, "zouti");
  const discountedSale = buildContaAzulSale(discounted, {
    customerId: "c",
    productIds: ["pa", "pb"],
    saleNumber: 2,
    financialAccountId: "a",
    categoryId: null,
    situation: "APROVADO",
  });
  assert.deepEqual(discountedSale.itens.map((item) => item.valor), [24.95, 98.5]);
  assert.equal(discountedSale.condicao_pagamento.parcelas[0].valor, 123.45);

  const free = parseZoutiOrder({
    ...paidPayload,
    amount_total: 0,
    amount_total_in_brl: 0,
    items: [{ ...paidPayload.items[0], amount: 0, amount_in_brl: 0 }],
  }, "zouti");
  assert.equal(free.totalAmount, 0);
  assert.throws(
    () =>
      buildContaAzulSale(free, {
        customerId: "c",
        productIds: ["p"],
        saleNumber: 1,
        financialAccountId: "a",
        categoryId: null,
        situation: "APROVADO",
      }),
    /positive value/,
  );
});

test("charges the platform's full deduction as the settlement fee", () => {
  // Venda parcelada real: cliente pagou 2782,45, a Zouti reteve 102,14 de
  // tarifa e 342,08 dos juros, e repassou 2338,23.
  const parcelada = parseZoutiOrder({
    ...paidPayload,
    amount_total: 278245,
    amount_total_in_brl: 2782.45,
    payment: {
      method: "CREDIT_CARD",
      installments: 12,
      amount: 278245,
      amount_in_brl: 2782.45,
      fee: 10214,
      fee_in_brl: 102.14,
      net_amount: 233823,
      net_amount_in_brl: 2338.23,
      interest_amount: 40245,
      interest_amount_in_brl: 402.45,
      interest_transfer_amount: 6037,
      interest_transfer_amount_in_brl: 60.37,
    },
    split_payments: null,
  }, "zouti");
  const unica = settlementComposition(parcelada, 2782.45, 1);
  assert.equal(unica.taxa, 444.22);
  assert.equal(unica.liquido, 2338.23);
  assert.equal(Math.round((2782.45 - unica.taxa) * 100) / 100, 2338.23);

  // Rateio proporcional quando a Conta Azul cria mais de uma parcela.
  const metade = settlementComposition(parcelada, 1391.23, 2);
  assert.equal(metade.taxa, 222.11);
  assert.equal(metade.liquido, 1169.12);

  // Sem líquido informado, cai para a tarifa conhecida.
  const semLiquido = parseZoutiOrder({
    ...paidPayload,
    payment: { method: "PIX", installments: 1, amount: 9790, amount_in_brl: 97.9, fee: 290, fee_in_brl: 2.9 },
    split_payments: null,
  }, "zouti");
  assert.equal(semLiquido.netAmount, null);
  assert.deepEqual(settlementComposition(semLiquido, 97.9, 1), { taxa: 2.9, liquido: 95 });

  // A taxa nunca ultrapassa o valor da parcela.
  const gratuito = settlementComposition(parcelada, 0, 1);
  assert.equal(gratuito.taxa, 0);

  // Tarifa de extrato registrada à mão entra na composição.
  assert.equal(settlementComposition(parcelada, 2782.45, 1, 12.5).taxa, 456.72);

  // Pagamento dividido: `payment` descreve só uma das partes, então o líquido
  // dela não vale para a ordem inteira e vale a tarifa conhecida.
  const dividido = parseZoutiOrder({
    ...paidPayload,
    amount_total: 4990,
    amount_total_in_brl: 49.9,
    is_split_payment: true,
    payment: {
      method: "PIX",
      installments: 1,
      amount: 500,
      amount_in_brl: 5,
      fee: 114,
      fee_in_brl: 1.14,
      net_amount: 386,
      net_amount_in_brl: 3.86,
    },
    split_payments: [
      { role: "PAYMENT_0", method: "CREDIT_CARD", amount: 4490 },
      { role: "PAYMENT_1", method: "PIX", amount: 500 },
    ],
  }, "zouti");
  assert.equal(dividido.isSplitPayment, true);
  assert.deepEqual(settlementComposition(dividido, 49.9, 1), { taxa: 1.14, liquido: 48.76 });
  assert.deepEqual(settlementComposition(dividido, 49.9, 1, 2.1), { taxa: 3.24, liquido: 46.66 });
});

test("resumes the same queue delivery after persisting its order row", () => {
  const order = parseZoutiOrder(paidPayload, "zouti");
  assert.equal(classifyOrderTransition({
    lastIngestSequence: 1388,
    lastSourceUpdatedAt: order.sourceUpdatedAt,
    payloadFingerprint: "a".repeat(64),
    normalizedStatus: "paid",
    lastAction: "received",
  }, order, 1388, "a".repeat(64)), "apply");
});

test("builds customer and one balanced Conta Azul sale", () => {
  const order = parseZoutiOrder(paidPayload, "zouti");
  const person = buildContaAzulPerson(order);
  const sale = buildContaAzulSale(order, {
    customerId: "customer-uuid",
    productIds: ["product-uuid"],
    saleNumber: 961,
    financialAccountId: "account-uuid",
    categoryId: "category-uuid",
    situation: "APROVADO",
    version: 0,
    trace: {
      webhookId: "00000000-0000-4000-8000-000000000001",
      ingestSequence: 1388,
      receivedAt: "2026-08-02T10:00:01.123Z",
      eventType: "purchase_approved",
    },
  });

  assert.equal(person.cpf, "12345678901");
  assert.equal(sale.numero, 961);
  assert.equal(sale.id_categoria, "category-uuid");
  assert.equal(sale.situacao, "APROVADO");
  assert.equal(sale.versao, 1);
  assert.equal(sale.itens[0].valor, 97.9);
  assert.match(String(sale.observacoes), /Situação atual: Aprovado\/pago \(PAID\)/);
  assert.match(String(sale.observacoes), /Sequência de ingestão: 1388/);
  assert.match(String(sale.observacoes), /utm_campaign: academy_pass/);
  assert.match(String(sale.observacoes_pagamento), /Taxa da plataforma: R\$ 2,90/);
  assert.match(String(sale.observacoes_pagamento), /Valor líquido: R\$ 95,00/);
  assert.match(String(sale.observacoes_pagamento), /PAYMENT_0: CREDIT_CARD — R\$ 50,00/);
  assert.equal(sale.condicao_pagamento.id_conta_financeira, "account-uuid");
  assert.equal(sale.condicao_pagamento.parcelas.length, 1);
});
