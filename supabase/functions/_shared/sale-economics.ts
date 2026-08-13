// Toda venda chega à Conta Azul pelo valor que realmente entra na conta: o
// valor pago pelo cliente menos cada tarifa retida pela plataforma. Este módulo
// concentra esse cálculo para que Zouti e Hotmart usem exatamente a mesma régua
// e para que a composição fique descrita na venda, linha por linha.

type JsonObject = Record<string, unknown>;

export interface SaleDeduction {
  code: string;
  label: string;
  // Positivo desconta do bruto; negativo devolve (ajuste de conciliação).
  amount: number;
  detail: string | null;
}

export type EconomicsCoverage = "complete" | "partial";

export interface SaleEconomics {
  currency: string;
  grossAmount: number;
  deductions: SaleDeduction[];
  netAmount: number;
  coverage: EconomicsCoverage;
  coverageNotes: string[];
  netSource: string;
  // Retenções conhecidas que, por decisão contábil, permanecem na receita em vez
  // de descontar do valor da venda. Elas aparecem descritas e viram taxa na baixa.
  disclosures: SaleDeduction[];
  // O que a plataforma efetivamente credita, quando ela informa.
  platformNetAmount: number | null;
}

export interface FeeAdjustment {
  code: string;
  label: string;
  amount: number;
  detail?: string | null;
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function brl(value: number): string {
  const absolute = Math.abs(value).toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${value < 0 ? "-" : ""}R$ ${absolute}`;
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function percentage(part: number, whole: number): string | null {
  if (whole <= 0) return null;
  return `${(part / whole * 100).toFixed(2).replace(".", ",")}% do valor pago`;
}

export function totalDeducted(deductions: SaleDeduction[]): number {
  return round2(deductions.reduce((sum, item) => sum + item.amount, 0));
}

// A composição precisa fechar exatamente no líquido declarado pela plataforma;
// qualquer sobra vira uma linha explícita em vez de desaparecer no arredondamento.
function reconcile(
  gross: number,
  deductions: SaleDeduction[],
  declaredNet: number | null,
): SaleDeduction[] {
  if (declaredNet === null) return deductions;
  const residual = round2(gross - totalDeducted(deductions) - declaredNet);
  if (Math.abs(residual) < 0.01) return deductions;
  return [...deductions, {
    code: residual > 0 ? "platform_other_retention" : "platform_reconciliation_credit",
    label: residual > 0 ? "Outras retenções da plataforma" : "Ajuste de conciliação da plataforma",
    amount: residual,
    detail: "Diferença entre o valor líquido informado pela plataforma e as tarifas detalhadas",
  }];
}

function build(input: {
  currency: string;
  gross: number;
  deductions: SaleDeduction[];
  declaredNet: number | null;
  coverageNotes: string[];
  netSource: string;
  disclosures?: SaleDeduction[];
  platformNetAmount?: number | null;
}): SaleEconomics {
  const gross = round2(input.gross);
  const deductions = reconcile(gross, input.deductions, input.declaredNet)
    .filter((item) => Math.abs(item.amount) >= 0.01)
    .map((item) => ({ ...item, amount: round2(item.amount) }));
  const netAmount = round2(gross - totalDeducted(deductions));
  return {
    currency: input.currency,
    grossAmount: gross,
    deductions,
    netAmount,
    coverage: input.coverageNotes.length ? "partial" : "complete",
    coverageNotes: input.coverageNotes,
    netSource: input.netSource,
    disclosures: (input.disclosures ?? [])
      .filter((item) => Math.abs(item.amount) >= 0.01)
      .map((item) => ({ ...item, amount: round2(item.amount) })),
    platformNetAmount: input.platformNetAmount === null || input.platformNetAmount === undefined
      ? null
      : round2(input.platformNetAmount),
  };
}

// Diferença entre o valor da venda e o que a plataforma credita. Ela não desconta
// a receita: entra como taxa na baixa, para o saldo bancário fechar.
export function settlementRetention(economics: SaleEconomics): number {
  if (economics.platformNetAmount === null) return 0;
  return Math.max(0, round2(economics.netAmount - economics.platformNetAmount));
}

// Gateways como a Zouti descrevem a cobrança em um único bloco `payment`. Em
// pagamentos divididos esse bloco cobre apenas uma das pernas, então a parte sem
// dados de tarifa permanece bruta e o pedido fica marcado como parcial.
export function gatewaySaleEconomics(input: {
  currency: string;
  platformLabel: string;
  grossAmount: number;
  chargedAmount: number | null;
  feeAmount: number | null;
  interestAmount: number | null;
  interestTransferAmount: number | null;
  refundedAmount: number | null;
  declaredNetAmount: number | null;
  installments: number;
}, adjustments: FeeAdjustment[] = []): SaleEconomics {
  const gross = round2(input.grossAmount);
  const charged = input.chargedAmount === null ? gross : round2(input.chargedAmount);
  const uncovered = round2(gross - charged);
  const coverageNotes: string[] = [];
  if (uncovered >= 0.01) {
    coverageNotes.push(
      `Pagamento dividido: a plataforma informou tarifas apenas para ${brl(charged)} do total. `
        + `${brl(uncovered)} permanecem sem dados de tarifa e entraram pelo valor bruto.`,
    );
  } else if (uncovered <= -0.01) {
    coverageNotes.push(
      `A cobrança informada (${brl(charged)}) é maior que o total do pedido (${brl(gross)}); `
        + "tarifas aplicadas sobre a cobrança informada.",
    );
  }

  const parcelamento = input.installments > 1 ? `${input.installments}x` : "à vista";
  const deductions: SaleDeduction[] = [];
  const fee = input.feeAmount === null ? null : round2(input.feeAmount);
  if (fee !== null && Math.abs(fee) >= 0.01) {
    deductions.push({
      code: "platform_fee",
      label: `Tarifa da plataforma ${input.platformLabel}`,
      amount: fee,
      detail: [percentage(fee, charged), parcelamento].filter(Boolean).join(" | "),
    });
  }

  const refunded = round2(input.refundedAmount ?? 0);
  if (refunded >= 0.01 && refunded < charged - 0.01) {
    deductions.push({
      code: "partial_refund",
      label: "Valor estornado ao cliente",
      amount: refunded,
      detail: "Estorno parcial informado pela plataforma",
    });
  }

  // Os juros de parcelamento retidos pelo gateway ficam na receita por decisão
  // contábil: só a tarifa da plataforma desconta o valor da venda. A retenção
  // continua descrita e vira taxa na baixa, então o banco fecha no valor creditado.
  const interest = round2(input.interestAmount ?? 0);
  const transferred = round2(input.interestTransferAmount ?? 0);
  const retainedInterest = round2(interest - transferred);
  const platformNet = input.declaredNetAmount === null
    ? null
    : round2(input.declaredNetAmount + Math.max(uncovered, 0));
  const saleValue = round2(gross - totalDeducted(deductions));
  // A retenção real é a diferença até o valor creditado; os campos de juros
  // apenas explicam de onde ela vem.
  const retained = platformNet === null ? retainedInterest : Math.max(0, round2(saleValue - platformNet));
  const explainedByInterest = retainedInterest >= 0.01 && Math.abs(retained - retainedInterest) < 0.01;
  const disclosures: SaleDeduction[] = retained >= 0.01
    ? [{
      code: explainedByInterest ? "installment_interest_retained" : "platform_retention",
      label: explainedByInterest
        ? "Juros de parcelamento retidos pela plataforma"
        : `Retenção da ${input.platformLabel} não detalhada`,
      amount: retained,
      detail: explainedByInterest
        ? `Juros cobrados do cliente ${brl(interest)} (${parcelamento})`
          + (transferred >= 0.01 ? `, dos quais ${brl(transferred)} foram repassados` : ", sem repasse")
        : "Diferença entre o valor da venda e o valor creditado pela plataforma",
    }]
    : [];

  return applyFeeAdjustments(build({
    currency: input.currency,
    gross,
    deductions,
    declaredNet: null,
    coverageNotes,
    netSource: fee === null
      ? "valor bruto (plataforma não informou tarifa)"
      : `valor pago menos a tarifa da ${input.platformLabel}`,
    disclosures,
    platformNetAmount: platformNet,
  }), adjustments);
}

interface HotmartCommission {
  source: string;
  value: number;
  currency: string;
  convertedValue: number | null;
  conversionRate: number | null;
}

const HOTMART_OWN_SOURCES = ["PRODUCER", "COPRODUCER", "CO_PRODUCER"];

function hotmartCommissions(value: unknown): HotmartCommission[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const entry = object(raw);
    const amount = finite(entry?.value);
    const source = typeof entry?.source === "string" ? entry.source.trim().toUpperCase() : "";
    if (!entry || amount === null || !source) return [];
    const conversion = object(entry.currency_conversion);
    const convertedTo = typeof conversion?.converted_to_currency === "string"
      ? conversion.converted_to_currency.toUpperCase()
      : null;
    return [{
      source,
      value: amount,
      currency: typeof entry.currency_value === "string" ? entry.currency_value.toUpperCase() : "BRL",
      convertedValue: convertedTo === "BRL" ? finite(conversion?.converted_value) : null,
      conversionRate: convertedTo === "BRL" ? finite(conversion?.conversion_rate) : null,
    }];
  });
}

function commissionLabel(source: string): string {
  return {
    MARKETPLACE: "Tarifa Hotmart",
    AFFILIATE: "Comissão de afiliado",
    COPRODUCER: "Comissão de coprodutor",
    CO_PRODUCER: "Comissão de coprodutor",
  }[source] ?? `Retenção Hotmart (${source})`;
}

// A Hotmart entrega a cadeia inteira no webhook: o cliente paga `full_price`,
// a plataforma retém juros de parcelamento e a tarifa, e credita a comissão do
// produtor. Essa comissão é o valor que entra na conta e vai para a Conta Azul.
export function hotmartSaleEconomics(body: unknown, adjustments: FeeAdjustment[] = []): SaleEconomics {
  const root = object(body);
  const data = object(root?.data) ?? root;
  const purchase = object(data?.purchase);
  if (!purchase) throw new Error("Hotmart mapping is incomplete; missing: purchase");

  const price = object(purchase.price);
  const fullPrice = object(purchase.full_price);
  const priceValue = finite(price?.value);
  if (priceValue === null) throw new Error("Hotmart mapping is incomplete; missing: purchase.price.value");
  const priceCurrency = typeof price?.currency_value === "string" ? price.currency_value.toUpperCase() : "BRL";
  const buyerPaid = Math.max(priceValue, finite(fullPrice?.value) ?? priceValue);

  const commissions = hotmartCommissions(data?.commissions);
  const own = commissions.filter((item) => HOTMART_OWN_SOURCES.includes(item.source));
  if (!own.length) throw new Error("Hotmart mapping is incomplete; missing: commissions.PRODUCER");

  // Venda em moeda estrangeira: a Hotmart converte apenas a comissão creditada,
  // então a cadeia de tarifas não existe em reais e só o líquido é confiável.
  if (priceCurrency !== "BRL") {
    const converted = own.reduce((sum, item) => sum + (item.convertedValue ?? 0), 0);
    if (converted <= 0) {
      throw new Error(`Hotmart sale in ${priceCurrency} has no BRL conversion for the producer commission`);
    }
    const rate = own.find((item) => item.conversionRate !== null)?.conversionRate;
    const retained = commissions
      .filter((item) => !HOTMART_OWN_SOURCES.includes(item.source))
      .map((item) => `${item.currency} ${item.value.toFixed(2)} (${commissionLabel(item.source)})`);
    return applyFeeAdjustments(build({
      currency: "BRL",
      gross: round2(converted),
      deductions: [],
      declaredNet: round2(converted),
      coverageNotes: [
        `Venda cobrada em ${priceCurrency} ${buyerPaid.toFixed(2)}. A Hotmart converteu apenas a comissão`
        + ` creditada${rate ? ` (câmbio ${rate})` : ""}; as tarifas retidas`
        + `${retained.length ? ` — ${retained.join(", ")} — ` : " "}não têm equivalente em reais neste evento.`,
      ],
      netSource: "comissão do produtor convertida pela Hotmart",
      platformNetAmount: round2(converted),
    }), adjustments);
  }

  const deductions: SaleDeduction[] = [];
  const interest = round2(buyerPaid - priceValue);
  const installments = finite(object(purchase.payment)?.installments_number) ?? 1;
  // Os juros do parcelamento nunca entram na comissão do produtor: a Hotmart
  // calcula a comissão sobre o valor da oferta, então eles ficam apenas descritos.
  const disclosures: SaleDeduction[] = interest >= 0.01
    ? [{
      code: "installment_interest_retained",
      label: "Juros de parcelamento retidos pela Hotmart",
      amount: interest,
      detail: `Cliente pagou ${brl(buyerPaid)} em ${installments}x sobre a oferta de ${brl(priceValue)}`,
    }]
    : [];
  for (const commission of commissions) {
    if (HOTMART_OWN_SOURCES.includes(commission.source)) continue;
    deductions.push({
      code: `hotmart_${commission.source.toLowerCase()}`,
      label: commissionLabel(commission.source),
      amount: round2(commission.value),
      detail: percentage(commission.value, priceValue),
    });
  }

  const ourCommission = round2(own.reduce((sum, item) => sum + item.value, 0));
  const fixedFee = round2(priceValue - commissions.reduce((sum, item) => sum + item.value, 0));
  if (fixedFee >= 0.01) {
    deductions.push({
      code: "hotmart_fixed_fee",
      label: "Tarifa fixa Hotmart",
      amount: fixedFee,
      detail: "Diferença entre o valor da oferta e a soma das comissões informadas",
    });
  }

  return applyFeeAdjustments(build({
    currency: "BRL",
    gross: priceValue,
    deductions,
    declaredNet: ourCommission,
    coverageNotes: [],
    netSource: "comissão do produtor informada pela Hotmart",
    disclosures,
    platformNetAmount: ourCommission,
  }), adjustments);
}

// Tarifas que só aparecem no extrato (antecipação, saque, ajustes de
// conciliação) entram por aqui, mantendo a composição fechada no valor final.
export function applyFeeAdjustments(
  economics: SaleEconomics,
  adjustments: FeeAdjustment[],
): SaleEconomics {
  const applicable = adjustments.filter((item) => Math.abs(round2(item.amount)) >= 0.01);
  if (!applicable.length) return economics;
  const deductions = [
    ...economics.deductions,
    ...applicable.map((item) => ({
      code: item.code,
      label: item.label,
      amount: round2(item.amount),
      detail: item.detail ?? "Tarifa conciliada pelo extrato da plataforma",
    })),
  ];
  const adjusted = round2(applicable.reduce((sum, item) => sum + item.amount, 0));
  return {
    ...economics,
    deductions,
    netAmount: round2(economics.grossAmount - totalDeducted(deductions)),
    netSource: `${economics.netSource} + conciliação do extrato`,
    platformNetAmount: economics.platformNetAmount === null
      ? null
      : round2(economics.platformNetAmount - adjusted),
  };
}

export function describeSaleEconomics(economics: SaleEconomics): string[] {
  const lines = [
    "COMPOSIÇÃO DO VALOR",
    `Valor pago pelo cliente: ${brl(economics.grossAmount)}`,
  ];
  for (const deduction of economics.deductions) {
    const sign = deduction.amount >= 0 ? "(-)" : "(+)";
    lines.push(
      `${sign} ${deduction.label}: ${brl(Math.abs(deduction.amount))}`
        + (deduction.detail ? ` — ${deduction.detail}` : ""),
    );
  }
  if (!economics.deductions.length) lines.push("(-) Nenhuma tarifa informada pela plataforma");
  lines.push(
    `(=) Valor líquido lançado na Conta Azul: ${brl(economics.netAmount)}`,
    `Total de tarifas descontadas: ${brl(totalDeducted(economics.deductions))}`,
    `Origem do líquido: ${economics.netSource}`,
  );
  if (economics.disclosures.length) {
    lines.push("", "RETIDO PELA PLATAFORMA E MANTIDO NA RECEITA");
    for (const disclosure of economics.disclosures) {
      lines.push(
        `${disclosure.label}: ${brl(Math.abs(disclosure.amount))}`
          + (disclosure.detail ? ` — ${disclosure.detail}` : ""),
      );
    }
    lines.push("Não desconta o valor da venda; entra como taxa na baixa do recebível.");
  }
  if (economics.platformNetAmount !== null) {
    lines.push(`Valor efetivamente creditado pela plataforma: ${brl(economics.platformNetAmount)}`);
  }
  if (economics.coverage === "partial") {
    lines.push("ATENÇÃO — composição parcial:");
    economics.coverageNotes.forEach((note) => lines.push(`  ${note}`));
  }
  return lines;
}

export function economicsSummaryLine(economics: SaleEconomics): string {
  return `Bruto ${brl(economics.grossAmount)} - tarifas ${brl(totalDeducted(economics.deductions))}`
    + ` = líquido ${brl(economics.netAmount)}`;
}
