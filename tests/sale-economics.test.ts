import assert from "node:assert/strict";
import test from "node:test";

import {
  applyFeeAdjustments,
  describeSaleEconomics,
  gatewaySaleEconomics,
  hotmartSaleEconomics,
  settlementRetention,
  totalDeducted,
} from "../supabase/functions/_shared/sale-economics.ts";
import { buildContaAzulSale, parseZoutiOrder } from "../supabase/functions/_shared/zouti-order.ts";

// Cobrança real de produção: 12x com tarifa da plataforma e juros de
// parcelamento em que só uma parte é repassada.
const installmentOrder = {
  id: "ord_installments",
  provider: "ZOUTI",
  status: "PAID",
  currency: "BRL",
  created_at: "2026-08-03T10:00:00.000Z",
  updated_at: "2026-08-03T10:00:00.000Z",
  amount_total: 278245,
  amount_total_in_brl: 2782.45,
  amount_subtotal_in_brl: 2847,
  customer_id: "cus_1",
  customer: { name: "Cliente Parcelado", email: "cliente@example.test", document: "12345678901" },
  items: [{ product_id: "prod_1", name: "Academy Pass", quantity: 1, amount_in_brl: 2847 }],
  payment: {
    method: "CREDIT_CARD",
    installments: 12,
    amount_in_brl: 2782.45,
    fee_in_brl: 102.14,
    net_amount_in_brl: 2338.23,
    discount_amount_in_brl: 467,
    interest_amount_in_brl: 402.45,
    interest_transfer_amount_in_brl: 60.37,
    amount_refunded: 0,
  },
};

test("desconta só a tarifa da Zouti e mantém os juros retidos na receita", () => {
  const order = parseZoutiOrder(installmentOrder, "zouti");
  const { economics } = order;

  assert.equal(economics.grossAmount, 2782.45);
  assert.equal(economics.netAmount, 2680.31);
  assert.equal(economics.coverage, "complete");
  assert.equal(totalDeducted(economics.deductions), 102.14);
  assert.deepEqual(economics.deductions.map((item) => [item.code, item.amount]), [
    ["platform_fee", 102.14],
  ]);
  // Os juros retidos ficam descritos e viram taxa na baixa, não descontam a venda.
  assert.deepEqual(economics.disclosures.map((item) => [item.code, item.amount]), [
    ["installment_interest_retained", 342.08],
  ]);
  assert.equal(economics.platformNetAmount, 2338.23);
  assert.equal(settlementRetention(economics), 342.08);
});

test("descreve a composição do valor linha por linha na venda", () => {
  const order = parseZoutiOrder(installmentOrder, "zouti");
  const description = describeSaleEconomics(order.economics).join("\n");

  assert.match(description, /Valor pago pelo cliente: R\$ 2\.782,45/);
  assert.match(description, /\(-\) Tarifa da plataforma Zouti: R\$ 102,14 — 3,67% do valor pago \| 12x/);
  assert.match(description, /\(=\) Valor líquido lançado na Conta Azul: R\$ 2\.680,31/);
  assert.match(description, /Origem do líquido: valor pago menos a tarifa da Zouti/);
  assert.match(description, /RETIDO PELA PLATAFORMA E MANTIDO NA RECEITA/);
  assert.match(
    description,
    /Juros de parcelamento retidos pela plataforma: R\$ 342,08 — Juros cobrados do cliente R\$ 402,45 \(12x\), dos quais R\$ 60,37 foram repassados/,
  );
  assert.match(description, /Valor efetivamente creditado pela plataforma: R\$ 2\.338,23/);

  const sale = buildContaAzulSale(order, {
    customerId: "customer-uuid",
    productIds: ["service-uuid"],
    saleNumber: 962,
    financialAccountId: "account-uuid",
    categoryId: "category-uuid",
    situation: "APROVADO",
  });
  assert.equal(sale.itens[0].valor, 2680.31);
  assert.equal(sale.condicao_pagamento.parcelas[0].valor, 2680.31);
  assert.match(String(sale.condicao_pagamento.parcelas[0].descricao), /líquido R\$ 2\.680,31/);
});

test("não deduz tarifa desconhecida em pagamento dividido e marca a venda como parcial", () => {
  const order = parseZoutiOrder({
    ...installmentOrder,
    id: "ord_split",
    amount_total_in_brl: 2591.58,
    is_split_payment: true,
    split_payments: [
      { role: "PAYMENT_0", method: "CREDIT_CARD", amount: 163335 },
      { role: "PAYMENT_1", method: "CREDIT_CARD", amount: 95823 },
    ],
    payment: {
      method: "CREDIT_CARD",
      installments: 6,
      amount_in_brl: 958.23,
      fee_in_brl: 38.39,
      net_amount_in_brl: 853.34,
      interest_amount_in_brl: 78.23,
      interest_transfer_amount_in_brl: 11.73,
    },
  }, "zouti");
  const { economics } = order;

  // Só a tarifa de R$ 38,39 da perna informada desconta; a outra perna fica bruta.
  assert.equal(economics.grossAmount, 2591.58);
  assert.equal(economics.netAmount, 2553.19);
  assert.equal(totalDeducted(economics.deductions), 38.39);
  assert.equal(economics.platformNetAmount, 2486.69);
  assert.equal(economics.coverage, "partial");
  assert.match(economics.coverageNotes[0], /tarifas apenas para R\$ 958,23/);
  assert.match(describeSaleEconomics(economics).join("\n"), /ATENÇÃO — composição parcial/);
});

test("registra como retenção o que a plataforma deixa de creditar sem detalhar", () => {
  const economics = gatewaySaleEconomics({
    currency: "BRL",
    platformLabel: "Zouti",
    grossAmount: 1000,
    chargedAmount: 1000,
    feeAmount: 50,
    interestAmount: 0,
    interestTransferAmount: 0,
    refundedAmount: 0,
    declaredNetAmount: 930,
    installments: 1,
  });

  assert.equal(economics.netAmount, 950);
  assert.deepEqual(economics.deductions.map((item) => [item.code, item.amount]), [
    ["platform_fee", 50],
  ]);
  // A plataforma credita menos que o valor da venda; a diferença vira taxa na baixa.
  assert.equal(economics.platformNetAmount, 930);
  assert.equal(settlementRetention(economics), 20);
  assert.deepEqual(economics.disclosures.map((item) => [item.code, item.amount]), [
    ["platform_retention", 20],
  ]);
  assert.match(
    describeSaleEconomics(economics).join("\n"),
    /Retenção da Zouti não detalhada: R\$ 20,00/,
  );
});

test("mantém o bruto quando a plataforma não informa tarifa alguma", () => {
  const economics = gatewaySaleEconomics({
    currency: "BRL",
    platformLabel: "Zouti",
    grossAmount: 500,
    chargedAmount: null,
    feeAmount: null,
    interestAmount: null,
    interestTransferAmount: null,
    refundedAmount: null,
    declaredNetAmount: null,
    installments: 1,
  });

  assert.equal(economics.netAmount, 500);
  assert.equal(economics.deductions.length, 0);
  assert.match(describeSaleEconomics(economics).join("\n"), /Nenhuma tarifa informada pela plataforma/);
});

// Evento real da Hotmart: o cliente paga full_price em 12x, a Hotmart retém os
// juros e a tarifa, e credita a comissão do produtor.
const hotmartApproved = {
  event: "PURCHASE_APPROVED",
  version: "2.0.0",
  data: {
    purchase: {
      transaction: "HP1974106610",
      price: { value: 2679, currency_value: "BRL" },
      full_price: { value: 3324.84, currency_value: "BRL" },
      payment: { type: "CREDIT_CARD", installments_number: 12 },
    },
    commissions: [
      { value: 151.02, source: "MARKETPLACE", currency_value: "BRL" },
      { value: 2526.98, source: "PRODUCER", currency_value: "BRL" },
    ],
  },
};

test("lança a comissão do produtor da Hotmart, não o valor pago pelo cliente", () => {
  const economics = hotmartSaleEconomics(hotmartApproved);

  // A comissão da Hotmart sai do valor da oferta, não do total parcelado.
  assert.equal(economics.grossAmount, 2679);
  assert.equal(economics.netAmount, 2526.98);
  assert.equal(economics.coverage, "complete");
  assert.deepEqual(economics.deductions.map((item) => [item.code, item.amount]), [
    ["hotmart_marketplace", 151.02],
    ["hotmart_fixed_fee", 1],
  ]);
  assert.deepEqual(economics.disclosures.map((item) => [item.code, item.amount]), [
    ["installment_interest_retained", 645.84],
  ]);
  assert.equal(settlementRetention(economics), 0);
  assert.match(
    describeSaleEconomics(economics).join("\n"),
    /\(-\) Tarifa Hotmart: R\$ 151,02 — 5,64% do valor pago/,
  );
});

test("aplica a tarifa do extrato da Hotmart sobre a comissão creditada", () => {
  const economics = hotmartSaleEconomics({
    event: "PURCHASE_APPROVED",
    data: {
      purchase: {
        transaction: "HP3930457062",
        price: { value: 2990.38, currency_value: "BRL" },
        full_price: { value: 2990.38, currency_value: "BRL" },
        payment: { type: "CREDIT_CARD", installments_number: 1 },
      },
      commissions: [
        { value: 143.35, source: "MARKETPLACE", currency_value: "BRL" },
        { value: 2847.03, source: "PRODUCER", currency_value: "BRL" },
      ],
    },
  }, [{
    code: "hotmart_anticipation_fee",
    label: "Tarifa Hotmart (antecipação)",
    amount: 143.35,
    detail: "Extrato de conciliação HP3930457062",
  }]);

  // Comissão de venda 2.847,03 menos a tarifa do extrato = 2.703,68 recebidos.
  assert.equal(economics.netAmount, 2703.68);
  assert.match(economics.netSource, /conciliação do extrato/);
  assert.match(
    describeSaleEconomics(economics).join("\n"),
    /\(-\) Tarifa Hotmart \(antecipação\): R\$ 143,35 — Extrato de conciliação HP3930457062/,
  );
});

test("usa a conversão da Hotmart para vendas em moeda estrangeira", () => {
  const economics = hotmartSaleEconomics({
    event: "PURCHASE_APPROVED",
    data: {
      purchase: {
        transaction: "HP0902210451",
        price: { value: 686532, currency_value: "ARS" },
        full_price: { value: 686532, currency_value: "ARS" },
        payment: { type: "CREDIT_CARD", installments_number: 1 },
      },
      commissions: [
        { value: 22.8, source: "MARKETPLACE", currency_value: "USD" },
        {
          value: 375.39,
          source: "PRODUCER",
          currency_value: "USD",
          currency_conversion: {
            conversion_rate: 5.080497,
            converted_value: 1907.17,
            converted_to_currency: "BRL",
          },
        },
      ],
    },
  });

  assert.equal(economics.currency, "BRL");
  assert.equal(economics.netAmount, 1907.17);
  assert.equal(economics.coverage, "partial");
  assert.match(economics.coverageNotes[0], /Venda cobrada em ARS 686532,00|Venda cobrada em ARS 686532\.00/);
  assert.match(economics.coverageNotes[0], /câmbio 5\.080497/);
});

test("recusa um evento da Hotmart sem comissão do produtor", () => {
  assert.throws(
    () =>
      hotmartSaleEconomics({
        data: {
          purchase: { price: { value: 100, currency_value: "BRL" } },
          commissions: [{ value: 10, source: "MARKETPLACE", currency_value: "BRL" }],
        },
      }),
    /missing: commissions.PRODUCER/,
  );
});

test("ignora ajustes de centavo e soma os aplicáveis", () => {
  const base = hotmartSaleEconomics(hotmartApproved);
  const adjusted = applyFeeAdjustments(base, [
    { code: "noise", label: "Ruído", amount: 0.004 },
    { code: "withdraw_fee", label: "Tarifa de saque", amount: 2.5 },
  ]);

  assert.equal(adjusted.deductions.length, base.deductions.length + 1);
  assert.equal(adjusted.netAmount, 2524.48);
  assert.equal(adjusted.platformNetAmount, 2524.48);
});

test("recusa uma venda cujo líquido não é positivo", () => {
  const order = parseZoutiOrder({
    ...installmentOrder,
    id: "ord_zero",
    payment: { method: "PIX", installments: 1, amount_in_brl: 2782.45, fee_in_brl: 2782.45, net_amount_in_brl: 0 },
  }, "zouti");

  assert.throws(
    () =>
      buildContaAzulSale(order, {
        customerId: "customer-uuid",
        productIds: ["service-uuid"],
        saleNumber: 1,
        financialAccountId: "account-uuid",
        categoryId: null,
        situation: "APROVADO",
      }),
    /no positive net value after platform fees/,
  );
});
