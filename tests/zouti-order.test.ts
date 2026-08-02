import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContaAzulPerson,
  buildContaAzulSale,
  classifyOrderTransition,
  classifyInboundCommerceEvent,
  contaAzulPaymentMethod,
  desiredOrderAction,
  isCancelledSaleSituation,
  normalizeOrderStatus,
  parseZoutiOrder,
  reconcileCustomerMatchIds,
  saleObservationsBelongToOrder,
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
