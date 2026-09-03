import assert from "node:assert/strict";
import test from "node:test";

import { classifyCommerceEvent, parseCommerceOrder } from "../supabase/functions/_shared/commerce-order.ts";
import {
  classifyHotmartEvent,
  isHotmartSandboxPayload,
  normalizeHotmartStatus,
  parseHotmartOrder,
} from "../supabase/functions/_shared/hotmart-order.ts";
import {
  buildContaAzulPerson,
  buildContaAzulSale,
  classifyOrderTransition,
  contaAzulPaymentMethod,
  contaAzulSku,
  desiredOrderAction,
  saleObservationsBelongToOrder,
} from "../supabase/functions/_shared/zouti-order.ts";

function hotmartEvent(event: string, status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `evt-${event.toLowerCase()}`,
    event,
    version: "2.0.0",
    creation_date: 1785680478242,
    data: {
      product: {
        id: 7295817,
        name: "AcademyPass",
        ucode: "d9df6720-28ff-4f42-8280-738372bedb45",
        product_format_id: 8,
        is_physical_product: false,
      },
      buyer: {
        name: "Comprador Exemplo",
        email: "Comprador@Example.test",
        document: "123.456.789-01",
        document_type: "CPF",
        checkout_phone_code: "41",
        checkout_phone: "41999998888",
        address: {
          address: "Rua Exemplo",
          number: "10",
          neighborhood: "Centro",
          city: "Curitiba",
          state: "PR",
          zipcode: "80000-000",
          country: "Brasil",
          country_iso: "BR",
        },
      },
      producer: { name: "Human Academy", document: "00000000000100", legal_nature: "Pessoa Jurídica" },
      commissions: [
        { value: 160.43, source: "MARKETPLACE", currency_value: "BRL" },
        { value: 2686.53, source: "PRODUCER", currency_value: "BRL" },
      ],
      purchase: {
        transaction: "HP1821650288",
        status,
        order_date: 1785680465000,
        approved_date: 1785680467000,
        price: { value: 2846.96, currency_value: "BRL" },
        full_price: { value: 3430.08, currency_value: "BRL" },
        original_offer_price: { value: 2846.96, currency_value: "BRL" },
        payment: { type: "CREDIT_CARD", installments_number: 12 },
        offer: { code: "iscvy6s8", name: "NEWHUMAN26 - ACADEMYPASS - ANUAL" },
        origin: { src: "lp", sck: "topo" },
        order_bump: { is_order_bump: false },
        business_model: "I",
        checkout_country: { iso: "BR", name: "Brasil" },
        recurrence_number: 1,
      },
      subscription: {
        plan: { id: 1276872, name: "APASS ANUAL" },
        status: "ACTIVE",
        subscriber: { code: "5QDJ8WXJ" },
      },
      affiliates: [{ name: "", affiliate_code: "" }],
      ...overrides,
    },
  };
}

test("maps Hotmart purchase situations onto the shared lifecycle", () => {
  assert.equal(normalizeHotmartStatus("APPROVED"), "paid");
  assert.equal(normalizeHotmartStatus("COMPLETED"), "paid");
  assert.equal(normalizeHotmartStatus("CANCELED"), "cancelled");
  assert.equal(normalizeHotmartStatus("REFUNDED"), "refunded");
  assert.equal(normalizeHotmartStatus("CHARGEBACK"), "chargeback");
  assert.equal(normalizeHotmartStatus("BILLET_PRINTED"), "pending");
  assert.equal(normalizeHotmartStatus("DELAYED"), "pending");
  assert.equal(normalizeHotmartStatus("EXPIRED"), "rejected");
  assert.equal(normalizeHotmartStatus("DISPUTE"), "unknown");
});

test("parses a Hotmart purchase keyed by its transaction code", () => {
  const order = parseHotmartOrder(hotmartEvent("PURCHASE_APPROVED", "APPROVED"));
  assert.equal(order.sourcePlatform, "hotmart");
  assert.equal(order.externalOrderId, "HP1821650288");
  assert.equal(order.normalizedStatus, "paid");
  assert.equal(order.totalAmount, 2846.96);
  assert.equal(order.paymentAmount, 3430.08);
  assert.equal(order.interestAmount, 583.12);
  assert.equal(order.netAmount, 2686.53);
  assert.equal(order.feeAmount, 160.43);
  assert.equal(order.currency, "BRL");
  assert.equal(order.installments, 12);
  assert.equal(order.paymentType, "SUBSCRIPTION");
  assert.equal(order.sourceCreatedAt, "2026-08-02T14:21:05.000Z");
  assert.equal(order.sourceUpdatedAt, "2026-08-02T14:21:18.242Z");
  assert.equal(order.customer.sourceId, "doc:12345678901");
  assert.equal(order.customer.document, "12345678901");
  assert.equal(order.customer.email, "comprador@example.test");
  assert.equal(order.customer.phone, "41999998888");
  assert.equal(order.customer.address?.postalCode, "80000000");
  assert.equal(order.customer.address?.country, "BR");
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].sourceId, "7295817");
  assert.equal(order.items[0].unitAmount, 2846.96);
  assert.match(order.items[0].description ?? "", /NEWHUMAN26/);
  assert.equal(order.attribution.subscriber_code, "5QDJ8WXJ");
  assert.equal(order.attribution.offer_code, "iscvy6s8");
  assert.equal(contaAzulPaymentMethod(order), "CARTAO_CREDITO");
  assert.equal(contaAzulSku(order.items[0].sourceId, order.sourcePlatform), "HM000000000007295817");
});

test("converts a foreign-currency Hotmart purchase into BRL from the producer conversion", () => {
  const order = parseHotmartOrder(hotmartEvent("PURCHASE_APPROVED", "APPROVED", {
    purchase: {
      transaction: "HP0902210451",
      status: "APPROVED",
      order_date: 1785680465000,
      price: { value: 686532, currency_value: "ARS" },
      full_price: { value: 686532, currency_value: "ARS" },
      original_offer_price: { value: 2215.19, currency_value: "BRL" },
      payment: { type: "CREDIT_CARD", installments_number: 1 },
      checkout_country: { iso: "AR", name: "Argentina" },
    },
    commissions: [
      { value: 22.8, source: "MARKETPLACE", currency_value: "USD" },
      {
        value: 375.39,
        source: "PRODUCER",
        currency_value: "USD",
        currency_conversion: { conversion_rate: 5.080497, converted_value: 1907.17, converted_to_currency: "BRL" },
      },
    ],
    buyer: {
      name: "Compradora Estrangeira",
      email: "estrangeira@example.test",
      document: "31377655",
      document_type: "",
      checkout_phone_code: "54",
      checkout_phone: "542214358187",
      address: { country: "Argentina", country_iso: "AR", city: "La Plata" },
    },
  }));
  assert.equal(order.currency, "ARS");
  assert.equal(order.totalAmount, 2023);
  assert.equal(order.netAmount, 1907.17);
  assert.equal(order.feeAmount, 115.83);
  assert.equal(order.paymentAmount, null);
  assert.equal(order.customer.document, null);
  assert.equal(order.customer.sourceId, "email:estrangeira@example.test");
  assert.equal(buildContaAzulPerson(order).tipo_pessoa, "Estrangeira");
  assert.equal(buildContaAzulPerson(order).telefone_celular, undefined);
});

test("refuses a foreign-currency purchase without a BRL conversion instead of guessing", () => {
  assert.throws(
    () =>
      parseHotmartOrder(hotmartEvent("PURCHASE_APPROVED", "APPROVED", {
        purchase: {
          transaction: "HP0000000001",
          status: "APPROVED",
          order_date: 1785680465000,
          price: { value: 100, currency_value: "USD" },
        },
        commissions: [{ value: 90, source: "PRODUCER", currency_value: "USD" }],
      })),
    /no BRL conversion/,
  );
});

test("routes only purchase lifecycle events to sale processing", () => {
  assert.equal(classifyHotmartEvent(hotmartEvent("PURCHASE_APPROVED", "APPROVED")).disposition, "process_order");
  assert.equal(classifyHotmartEvent(hotmartEvent("PURCHASE_COMPLETE", "COMPLETED")).disposition, "process_order");
  assert.equal(classifyHotmartEvent(hotmartEvent("PURCHASE_REFUNDED", "REFUNDED")).disposition, "process_order");
  assert.equal(classifyHotmartEvent(hotmartEvent("PURCHASE_CANCELED", "CANCELED")).disposition, "process_order");
  assert.equal(classifyHotmartEvent(hotmartEvent("PURCHASE_BILLET_PRINTED", "BILLET_PRINTED")).disposition, "process_order");

  const dispute = classifyHotmartEvent(hotmartEvent("PURCHASE_PROTEST", "DISPUTE"));
  assert.equal(dispute.disposition, "defer");
  assert.deepEqual(dispute, {
    disposition: "defer",
    entityKind: "purchase_dispute",
    externalEntityId: "HP1821650288",
    relatedOrderId: "HP1821650288",
    sourceStatus: "DISPUTE",
    reason: "dispute_awaits_terminal_event",
  });

  const cart = classifyHotmartEvent({ event: "PURCHASE_OUT_OF_SHOPPING_CART", data: { buyer: {}, product: { id: 1 } } });
  assert.equal(cart.disposition, "defer");
  assert.equal(cart.entityKind, "abandoned_cart");

  const cancellation = classifyHotmartEvent({
    event: "SUBSCRIPTION_CANCELLATION",
    data: { subscription: { subscriber: { code: "ABC" } }, product: { id: 1 } },
  });
  assert.equal(cancellation.disposition, "defer");
  assert.equal(cancellation.entityKind, "subscription_event");
  assert.equal(cancellation.externalEntityId, "ABC");

  const club = classifyHotmartEvent({ event: "CLUB_MODULE_COMPLETED", data: {} });
  assert.equal(club.disposition, "defer");
  assert.equal(club.entityKind, "club_event");

  const unknown = classifyHotmartEvent(hotmartEvent("PURCHASE_SOMETHING_NEW", "APPROVED"));
  assert.equal(unknown.disposition, "defer");
  assert.equal(unknown.reason, "unrecognized_event");

  const incomplete = classifyHotmartEvent({ event: "PURCHASE_APPROVED", data: { purchase: { transaction: "HP1" } } });
  assert.equal(incomplete.disposition, "defer");
  assert.equal(incomplete.entityKind, "incomplete_purchase");
});

test("never processes Hotmart sandbox or test-postback payloads", () => {
  const sandbox = hotmartEvent("PURCHASE_APPROVED", "APPROVED", {
    product: { id: 0, name: "Produto test postback2" },
    purchase: {
      transaction: "HP16015479281022",
      status: "APPROVED",
      order_date: 1511783344000,
      price: { value: 1500, currency_value: "BRL" },
      offer: { code: "test" },
      variants: { sku: "HTM_SANDBOX-01" },
    },
    producer: { name: "Producer Test Name" },
  });
  assert.equal(isHotmartSandboxPayload(sandbox), true);
  assert.equal(classifyHotmartEvent(sandbox).entityKind, "hotmart_sandbox_event");
  assert.equal(isHotmartSandboxPayload(hotmartEvent("PURCHASE_APPROVED", "APPROVED")), false);
  assert.equal(
    isHotmartSandboxPayload(hotmartEvent("PURCHASE_APPROVED", "APPROVED", {
      product: { id: 123456, name: "Produto test postback2 com ç e á" },
    })),
    true,
  );
});

test("approval followed by completion updates the same sale instead of creating another", () => {
  const approved = parseHotmartOrder(hotmartEvent("PURCHASE_APPROVED", "APPROVED"));
  const completed = parseHotmartOrder({
    ...hotmartEvent("PURCHASE_COMPLETE", "COMPLETED"),
    creation_date: 1786612526108,
  });
  assert.equal(approved.externalOrderId, completed.externalOrderId);
  assert.equal(completed.normalizedStatus, "paid");

  const afterApproval = {
    lastIngestSequence: 3342,
    lastSourceUpdatedAt: approved.sourceUpdatedAt,
    payloadFingerprint: "a".repeat(64),
    normalizedStatus: "paid" as const,
    lastAction: "sale_created",
  };
  assert.equal(classifyOrderTransition(afterApproval, completed, 4066, "b".repeat(64)), "apply");
  // Com a venda já vinculada, o resultado é uma atualização da mesma venda.
  assert.equal(desiredOrderAction(completed.normalizedStatus, true), "upsert_sale");

  // Reentrega idêntica do mesmo evento é ignorada.
  assert.equal(
    classifyOrderTransition({ ...afterApproval, lastIngestSequence: 4066, payloadFingerprint: "b".repeat(64), lastAction: "sale_updated" }, completed, 4070, "b".repeat(64)),
    "duplicate",
  );
});

test("refund and chargeback cancel the linked sale and never regress", () => {
  const refunded = parseHotmartOrder({
    ...hotmartEvent("PURCHASE_REFUNDED", "REFUNDED"),
    creation_date: 1785986987648,
  });
  const chargeback = parseHotmartOrder({
    ...hotmartEvent("PURCHASE_CHARGEBACK", "CHARGEBACK"),
    creation_date: 1785990000000,
  });
  const approvedAgain = parseHotmartOrder({
    ...hotmartEvent("PURCHASE_APPROVED", "APPROVED"),
    creation_date: 1785995000000,
  });
  const paidState = {
    lastIngestSequence: 100,
    lastSourceUpdatedAt: "2026-08-02T14:21:18.242Z",
    payloadFingerprint: "a".repeat(64),
    normalizedStatus: "paid" as const,
    lastAction: "sale_created",
  };
  assert.equal(classifyOrderTransition(paidState, refunded, 101, "b".repeat(64)), "apply");
  assert.equal(desiredOrderAction(refunded.normalizedStatus, true), "cancel_sale");
  assert.equal(desiredOrderAction(refunded.normalizedStatus, false), "record_only");

  const refundedState = { ...paidState, lastIngestSequence: 101, lastSourceUpdatedAt: refunded.sourceUpdatedAt, normalizedStatus: "refunded" as const, lastAction: "sale_cancelled" };
  assert.equal(classifyOrderTransition(refundedState, chargeback, 102, "c".repeat(64)), "apply");
  assert.equal(classifyOrderTransition(refundedState, approvedAgain, 103, "d".repeat(64)), "stale");
});

test("a Hotmart partial refund annotates the same sale and flags the unknown amount", () => {
  assert.equal(normalizeHotmartStatus("PARTIALLY_REFUNDED"), "partially_refunded");
  const partial = parseHotmartOrder({
    ...hotmartEvent("PURCHASE_REFUNDED", "PARTIALLY_REFUNDED"),
    creation_date: 1785986987648,
  });
  assert.equal(partial.normalizedStatus, "partially_refunded");
  assert.equal(partial.refundedAmount, null);
  assert.equal(desiredOrderAction(partial.normalizedStatus, true), "annotate_sale");
  assert.equal(desiredOrderAction(partial.normalizedStatus, false), "record_only");

  const paidState = {
    lastIngestSequence: 100,
    lastSourceUpdatedAt: "2026-08-02T14:21:18.242Z",
    payloadFingerprint: "a".repeat(64),
    normalizedStatus: "paid" as const,
    lastAction: "sale_created",
  };
  assert.equal(classifyOrderTransition(paidState, partial, 101, "b".repeat(64)), "apply");

  const sale = buildContaAzulSale(partial, {
    customerId: "customer-uuid",
    productIds: ["service-uuid"],
    saleNumber: 24480,
    financialAccountId: "hotmart-account-uuid",
    categoryId: null,
    situation: "APROVADO",
  });
  assert.equal(sale.situacao, "APROVADO");
  assert.match(String(sale.observacoes), /REEMBOLSO PARCIAL/);
  assert.match(String(sale.observacoes), /não informado pela plataforma/);
});

test("pending Hotmart purchases are recorded without touching Conta Azul", () => {
  const billet = parseHotmartOrder(hotmartEvent("PURCHASE_BILLET_PRINTED", "BILLET_PRINTED"));
  assert.equal(billet.normalizedStatus, "pending");
  assert.equal(desiredOrderAction(billet.normalizedStatus, false), "record_only");
  const canceled = parseHotmartOrder(hotmartEvent("PURCHASE_CANCELED", "CANCELED"));
  assert.equal(desiredOrderAction(canceled.normalizedStatus, false), "record_only");
});

test("builds a Conta Azul sale that carries the Hotmart transaction as its durable marker", () => {
  const order = parseHotmartOrder(hotmartEvent("PURCHASE_APPROVED", "APPROVED"));
  const sale = buildContaAzulSale(order, {
    customerId: "customer-uuid",
    productIds: ["service-uuid"],
    saleNumber: 24476,
    financialAccountId: "hotmart-account-uuid",
    categoryId: "category-uuid",
    situation: "APROVADO",
    version: 0,
    trace: {
      webhookId: "00000000-0000-4000-8000-000000000002",
      ingestSequence: 3342,
      receivedAt: "2026-08-02T14:21:18.746Z",
      eventType: null,
    },
  });
  assert.equal(sale.numero, 24476);
  assert.equal(sale.condicao_pagamento.nsu, "HP1821650288");
  assert.equal(sale.condicao_pagamento.tipo_pagamento, "CARTAO_CREDITO");
  assert.equal(sale.itens[0].valor, 2846.96);
  assert.match(String(sale.observacoes), /INTEGRAÇÃO HUMANOS • HOTMART/);
  assert.match(String(sale.observacoes), /Transação Hotmart: HP1821650288/);
  assert.match(String(sale.observacoes), /Produto Hotmart: 7295817/);
  assert.match(String(sale.observacoes_pagamento), /PAGAMENTO HOTMART/);
  assert.match(String(sale.observacoes_pagamento), /Taxa da plataforma: R\$ 160,43/);
  assert.match(String(sale.observacoes_pagamento), /Valor líquido: R\$ 2686,53/);
  assert.equal(saleObservationsBelongToOrder(String(sale.observacoes), "HP1821650288"), true);
  assert.equal(saleObservationsBelongToOrder(String(sale.observacoes), "HP0000000000"), false);
});

test("dispatches by platform through the shared entry point", () => {
  assert.equal(classifyCommerceEvent(hotmartEvent("PURCHASE_APPROVED", "APPROVED"), "hotmart").disposition, "process_order");
  assert.equal(classifyCommerceEvent(hotmartEvent("PURCHASE_APPROVED", "APPROVED"), "HOTMART").disposition, "process_order");
  assert.equal(parseCommerceOrder(hotmartEvent("PURCHASE_APPROVED", "APPROVED"), "hotmart").sourcePlatform, "hotmart");
  assert.equal(classifyCommerceEvent({ id: "pmt_1", status: "PAID" }, "zouti").disposition, "defer");
  assert.throws(() => parseCommerceOrder({}, "kiwify"), /adapter not implemented/);
});
