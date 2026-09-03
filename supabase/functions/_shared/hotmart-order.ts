import {
  brazilianPhone,
  type CommerceItem,
  type CommerceOrder,
  type InboundCommerceEvent,
  type NormalizedOrderStatus,
} from "./zouti-order.ts";

/**
 * Adaptador Hotmart (webhook v2.0.0) para o modelo canônico `CommerceOrder`.
 *
 * A identidade de uma venda na Hotmart é o código da transação (`HP...`),
 * presente em `data.purchase.transaction`. Todo evento do ciclo de vida da
 * mesma compra — aprovada, completa (fim da garantia), cancelada, reembolsada,
 * chargeback — carrega o mesmo código, então todos convergem para a mesma
 * linha em `conta_azul_orders` e para a mesma venda na Conta Azul. Um evento
 * nunca vira uma venda nova por si só.
 */

type JsonObject = Record<string, unknown>;

export const HOTMART_PLATFORM = "hotmart";

/** Eventos que descrevem o estado de uma compra e podem mover a venda. */
const ORDER_EVENTS = new Set([
  "PURCHASE_APPROVED",
  "PURCHASE_COMPLETE",
  "PURCHASE_CANCELED",
  "PURCHASE_REFUNDED",
  "PURCHASE_CHARGEBACK",
  "PURCHASE_BILLET_PRINTED",
  "PURCHASE_DELAYED",
  "PURCHASE_EXPIRED",
]);

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function optionalString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredString(value: unknown, name: string): string {
  const parsed = optionalString(value);
  if (!parsed) throw new Error(`Hotmart mapping is incomplete; missing: ${name}`);
  return parsed;
}

function finiteNumber(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Hotmart mapping has invalid ${name}`);
  return parsed;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function epochToIso(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(parsed)) {
    // Hotmart envia epoch em milissegundos; segundos são um valor pequeno demais.
    return new Date(parsed < 1e11 ? parsed * 1000 : parsed).toISOString();
  }
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

/**
 * Situações da compra na Hotmart. `DISPUTE`/`PROTESTED` ficam propositalmente em
 * `unknown`: uma disputa aberta não desfaz a venda; só `CHARGEBACK` ou
 * `REFUNDED` desfazem. O classificador nem chega a processar esses eventos.
 */
export function normalizeHotmartStatus(value: unknown): NormalizedOrderStatus {
  const status = String(value ?? "").trim().toUpperCase();
  if (["APPROVED", "COMPLETED", "COMPLETE"].includes(status)) return "paid";
  if (["CANCELED", "CANCELLED"].includes(status)) return "cancelled";
  if (status === "REFUNDED") return "refunded";
  // A Hotmart sinaliza o parcial só pelo status; o valor devolvido não vem no
  // webhook e fica marcado para conferência no extrato.
  if (status === "PARTIALLY_REFUNDED") return "partially_refunded";
  if (status === "CHARGEBACK") return "chargeback";
  if (["EXPIRED", "BLOCKED", "NO_FUNDS"].includes(status)) return "rejected";
  if (
    [
      "BILLET_PRINTED",
      "PRINTED_BILLET",
      "DELAYED",
      "WAITING_PAYMENT",
      "STARTED",
      "PROCESSING_TRANSACTION",
      "UNDER_ANALISYS",
      "UNDER_ANALYSIS",
      "PRE_ORDER",
      "OVERDUE",
    ].includes(status)
  ) return "pending";
  return "unknown";
}

/**
 * A Hotmart dispõe de um botão "testar postback" e de um sandbox; ambos mandam
 * payloads com produto `0`, oferta `test`, SKU `HTM_SANDBOX-*` ou produtor
 * "Producer Test Name". Nenhum deles pode virar cliente ou venda real.
 */
export function isHotmartSandboxPayload(body: unknown): boolean {
  const root = object(body);
  const data = object(root?.data);
  const product = object(data?.product);
  const purchase = object(data?.purchase);
  const producer = object(data?.producer);
  const offer = object(purchase?.offer);
  const variants = object(purchase?.variants);
  const productId = Number(product?.id);
  return productId === 0
    || (optionalString(offer?.code)?.toLowerCase() === "test")
    || (optionalString(variants?.sku)?.toUpperCase().startsWith("HTM_SANDBOX") ?? false)
    || /producer test name/i.test(optionalString(producer?.name) ?? "")
    || /test postback/i.test(optionalString(product?.name) ?? "");
}

function defer(
  entityKind: string,
  externalEntityId: string | null,
  relatedOrderId: string | null,
  sourceStatus: string | null,
  reason: string,
): InboundCommerceEvent {
  return { disposition: "defer", entityKind, externalEntityId, relatedOrderId, sourceStatus, reason };
}

export function classifyHotmartEvent(body: unknown): InboundCommerceEvent {
  const root = object(body);
  if (!root) return defer("invalid_body", null, null, null, "body_is_not_an_object");

  const event = optionalString(root.event)?.toUpperCase() ?? null;
  const data = object(root.data);
  const purchase = object(data?.purchase);
  const transaction = optionalString(purchase?.transaction);
  const sourceStatus = optionalString(purchase?.status)?.toUpperCase() ?? null;
  const subscriber = optionalString(object(object(data?.subscription)?.subscriber)?.code);

  if (!event) return defer("hotmart_event_without_type", transaction, transaction, sourceStatus, "event_type_missing");
  if (isHotmartSandboxPayload(root)) {
    return defer("hotmart_sandbox_event", transaction, transaction, sourceStatus, "sandbox_or_test_payload");
  }
  if (event === "PURCHASE_PROTEST") {
    return defer("purchase_dispute", transaction, transaction, sourceStatus, "dispute_awaits_terminal_event");
  }
  if (event === "PURCHASE_OUT_OF_SHOPPING_CART") {
    return defer("abandoned_cart", null, null, null, "auxiliary_event_without_transaction");
  }
  if (event.startsWith("SUBSCRIPTION_") || event === "SWITCH_PLAN" || event === "UPDATE_SUBSCRIPTION_CHARGE_DATE") {
    return defer("subscription_event", subscriber, transaction, sourceStatus, "auxiliary_event_requires_correlation");
  }
  if (event.startsWith("CLUB_")) {
    return defer("club_event", subscriber, transaction, null, "membership_area_event");
  }
  if (event === "ORDER_FULFILLMENT") {
    return defer("order_fulfillment", transaction, transaction, sourceStatus, "auxiliary_event_requires_correlation");
  }
  if (!ORDER_EVENTS.has(event)) {
    return defer("hotmart_auxiliary_event", transaction, transaction, sourceStatus, "unrecognized_event");
  }
  if (transaction && purchase && sourceStatus && object(data?.buyer) && object(data?.product)) {
    return { disposition: "process_order", entityKind: "order" };
  }
  return defer("incomplete_purchase", transaction, transaction, sourceStatus, "order_mapping_incomplete");
}

interface HotmartAmounts {
  currency: string;
  totalAmount: number;
  paymentAmount: number | null;
  subtotalAmount: number | null;
  netAmount: number | null;
  feeAmount: number | null;
  interestAmount: number | null;
}

/**
 * O valor lançado é sempre em BRL. Em compras nacionais é o preço da compra; em
 * compras em moeda estrangeira a Hotmart informa as comissões em USD com a
 * conversão para BRL só na parte do produtor, então o bruto em BRL é a soma das
 * comissões convertida pela mesma taxa. Sem essa conversão o mapeamento para
 * com erro visível em vez de chutar um valor.
 */
function resolveAmounts(purchase: JsonObject, commissions: JsonObject[]): HotmartAmounts {
  const price = object(purchase.price);
  const currency = requiredString(price?.currency_value, "data.purchase.price.currency_value").toUpperCase();
  const priceValue = finiteNumber(price?.value, "data.purchase.price.value");
  if (priceValue < 0) throw new Error("Hotmart mapping requires a non-negative price");
  const fullPrice = object(purchase.full_price);
  const originalPrice = object(purchase.original_offer_price);
  const producer = commissions.find((commission) =>
    optionalString(commission.source)?.toUpperCase() === "PRODUCER"
  ) ?? null;

  if (currency === "BRL") {
    const totalAmount = round2(priceValue);
    const producerCurrency = optionalString(producer?.currency_value)?.toUpperCase() ?? null;
    const conversion = object(producer?.currency_conversion);
    const netAmount = producer === null
      ? null
      : producerCurrency === "BRL"
      ? round2(finiteNumber(producer.value, "data.commissions[producer].value"))
      : optionalString(conversion?.converted_to_currency)?.toUpperCase() === "BRL"
      ? round2(finiteNumber(conversion?.converted_value, "data.commissions[producer].currency_conversion.converted_value"))
      : null;
    const paymentAmount = optionalString(fullPrice?.currency_value)?.toUpperCase() === "BRL" && fullPrice?.value !== undefined
      ? round2(finiteNumber(fullPrice.value, "data.purchase.full_price.value"))
      : null;
    const subtotalAmount = optionalString(originalPrice?.currency_value)?.toUpperCase() === "BRL"
        && originalPrice?.value !== undefined
      ? round2(finiteNumber(originalPrice.value, "data.purchase.original_offer_price.value"))
      : null;
    return {
      currency,
      totalAmount,
      paymentAmount,
      subtotalAmount,
      netAmount,
      feeAmount: netAmount === null ? null : round2(Math.max(0, totalAmount - netAmount)),
      interestAmount: paymentAmount !== null && paymentAmount > totalAmount ? round2(paymentAmount - totalAmount) : null,
    };
  }

  const conversion = object(producer?.currency_conversion);
  const rate = Number(conversion?.conversion_rate);
  if (
    !producer || !conversion || !Number.isFinite(rate) || rate <= 0
    || optionalString(conversion.converted_to_currency)?.toUpperCase() !== "BRL"
  ) {
    throw new Error(`Hotmart mapping has no BRL conversion for currency ${currency}`);
  }
  const commissionCurrency = optionalString(producer.currency_value)?.toUpperCase() ?? null;
  let grossInCommissionCurrency = 0;
  for (const commission of commissions) {
    if (optionalString(commission.currency_value)?.toUpperCase() !== commissionCurrency) {
      throw new Error("Hotmart mapping has commissions in mixed currencies");
    }
    grossInCommissionCurrency += finiteNumber(commission.value, "data.commissions[].value");
  }
  const netAmount = round2(finiteNumber(conversion.converted_value, "currency_conversion.converted_value"));
  const totalAmount = round2(Math.max(netAmount, grossInCommissionCurrency * rate));
  return {
    currency,
    totalAmount,
    paymentAmount: null,
    subtotalAmount: null,
    netAmount,
    feeAmount: round2(totalAmount - netAmount),
    interestAmount: null,
  };
}

function buyerDocument(buyer: JsonObject, countryIso: string | null): string | null {
  const digits = optionalString(buyer.document)?.replace(/\D/g, "") || null;
  if (!digits) return null;
  const type = optionalString(buyer.document_type)?.toUpperCase() ?? null;
  if (type === "CPF") return digits.length === 11 ? digits : null;
  if (type === "CNPJ") return digits.length === 14 ? digits : null;
  // Sem tipo declarado, só aceita como documento brasileiro quando o comprador
  // está no Brasil; um DNI argentino de 11 dígitos não pode virar CPF.
  if (!type && countryIso === "BR" && (digits.length === 11 || digits.length === 14)) return digits;
  return null;
}

function buyerPhone(buyer: JsonObject): string | null {
  const phoneDigits = optionalString(buyer.checkout_phone)?.replace(/\D/g, "") ?? "";
  const codeDigits = optionalString(buyer.checkout_phone_code)?.replace(/\D/g, "") ?? "";
  if (!phoneDigits) return null;
  // `checkout_phone` costuma vir já com o DDD (11 dígitos); quando vem só o
  // número, o DDD está em `checkout_phone_code`.
  const combined = codeDigits && !phoneDigits.startsWith(codeDigits) && phoneDigits.length <= 9
    ? `${codeDigits}${phoneDigits}`
    : phoneDigits;
  return brazilianPhone(combined);
}

export function parseHotmartOrder(body: unknown): CommerceOrder {
  const root = object(body);
  if (!root) throw new Error("Webhook body is not a JSON object");
  const data = object(root.data);
  const purchase = object(data?.purchase);
  const buyer = object(data?.buyer);
  const product = object(data?.product);
  if (!purchase) throw new Error("Hotmart mapping is incomplete; missing: data.purchase");
  if (!buyer) throw new Error("Hotmart mapping is incomplete; missing: data.buyer");
  if (!product) throw new Error("Hotmart mapping is incomplete; missing: data.product");

  const transaction = requiredString(purchase.transaction, "data.purchase.transaction");
  const sourceStatus = requiredString(purchase.status, "data.purchase.status").toUpperCase();
  const commissions = Array.isArray(data?.commissions)
    ? data.commissions.map(object).filter((item): item is JsonObject => Boolean(item))
    : [];
  const amounts = resolveAmounts(purchase, commissions);

  const createdAt = epochToIso(purchase.order_date)
    ?? epochToIso(purchase.approved_date)
    ?? epochToIso(root.creation_date);
  if (!createdAt) throw new Error("Hotmart mapping is incomplete; missing: data.purchase.order_date");
  const updatedAt = epochToIso(root.creation_date) ?? createdAt;

  const address = object(buyer.address);
  const countryIso = optionalString(address?.country_iso)?.toUpperCase() ?? null;
  const document = buyerDocument(buyer, countryIso);
  const email = optionalString(buyer.email)?.toLowerCase() ?? null;
  const name = optionalString(buyer.name)
    ?? [optionalString(buyer.first_name), optionalString(buyer.last_name)].filter(Boolean).join(" ").trim();
  if (!name) throw new Error("Hotmart mapping is incomplete; missing: data.buyer.name");

  const payment = object(purchase.payment);
  const offer = object(purchase.offer);
  const origin = object(purchase.origin);
  const orderBump = object(purchase.order_bump);
  const subscription = object(data?.subscription);
  const plan = object(subscription?.plan);
  const subscriber = object(subscription?.subscriber);
  const recurrence = optionalString(purchase.recurrence_number);
  const affiliates = Array.isArray(data?.affiliates)
    ? data.affiliates.map(object).map((affiliate) => optionalString(affiliate?.affiliate_code)).filter(Boolean)
    : [];

  const productId = requiredString(product.id, "data.product.id");
  const item: CommerceItem = {
    sourceId: productId,
    name: requiredString(product.name, "data.product.name"),
    description: [
      optionalString(offer?.name) ?? (optionalString(offer?.code) ? `Oferta ${optionalString(offer?.code)}` : null),
      optionalString(plan?.name) ? `Plano: ${optionalString(plan?.name)}` : null,
      recurrence ? `Recorrência ${recurrence}` : null,
    ].filter(Boolean).join(" | ") || null,
    type: subscription ? "SUBSCRIPTION" : "ONE_TIME",
    quantity: 1,
    unitAmount: amounts.totalAmount,
  };

  const attribution = Object.fromEntries([
    ["offer_code", optionalString(offer?.code)],
    ["coupon_code", optionalString(offer?.coupon_code)],
    ["src", optionalString(origin?.src)],
    ["sck", optionalString(origin?.sck)],
    ["affiliate_code", affiliates.join(",") || null],
    ["subscriber_code", optionalString(subscriber?.code)],
    ["plan_id", optionalString(plan?.id)],
    ["recurrence_number", recurrence],
    ["business_model", optionalString(purchase.business_model)],
    ["checkout_country", optionalString(object(purchase.checkout_country)?.iso)],
    ["parent_transaction", orderBump?.is_order_bump === true ? optionalString(orderBump.parent_purchase_transaction) : null],
    ["hotmart_event", optionalString(root.event)],
  ].filter((entry): entry is [string, string] => Boolean(entry[1])));

  return {
    sourcePlatform: HOTMART_PLATFORM,
    externalOrderId: transaction,
    sourceStatus,
    normalizedStatus: normalizeHotmartStatus(sourceStatus),
    sourceCreatedAt: createdAt,
    sourceUpdatedAt: updatedAt,
    currency: amounts.currency,
    subtotalAmount: amounts.subtotalAmount,
    totalAmount: amounts.totalAmount,
    paymentAmount: amounts.paymentAmount,
    netAmount: amounts.netAmount,
    feeAmount: amounts.feeAmount,
    refundedAmount: null,
    interestAmount: amounts.interestAmount,
    interestTransferAmount: null,
    paymentMethod: optionalString(payment?.type)?.toUpperCase() ?? null,
    paymentType: subscription ? "SUBSCRIPTION" : "ONE_TIME",
    installments: Math.max(1, Math.trunc(Number(payment?.installments_number) || 1)),
    isSplitPayment: false,
    splitPayments: [],
    orderSessionId: null,
    attribution,
    customer: {
      // A Hotmart não expõe um ID estável de comprador no webhook; o documento é
      // a identidade mais estável, seguido do e-mail. A transação é o último
      // recurso para a ordem não ficar sem cliente.
      sourceId: document ? `doc:${document}` : email ? `email:${email}` : `transaction:${transaction}`,
      name,
      document,
      email,
      phone: buyerPhone(buyer),
      address: address
        ? {
          postalCode: optionalString(address.zipcode)?.replace(/\D/g, "") || null,
          street: optionalString(address.address),
          number: optionalString(address.number),
          complement: optionalString(address.complement),
          neighborhood: optionalString(address.neighborhood),
          city: optionalString(address.city),
          state: optionalString(address.state),
          country: countryIso ?? optionalString(address.country),
        }
        : null,
    },
    items: [item],
  };
}
