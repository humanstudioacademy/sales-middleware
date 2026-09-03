export type NormalizedOrderStatus =
  | "pending"
  | "paid"
  | "rejected"
  | "cancelled"
  | "refunded"
  | "partially_refunded"
  | "chargeback"
  | "unknown";

type JsonObject = Record<string, unknown>;

export interface CommerceCustomer {
  sourceId: string;
  name: string;
  document: string | null;
  email: string | null;
  phone: string | null;
  address: {
    postalCode: string | null;
    street: string | null;
    number: string | null;
    complement: string | null;
    neighborhood: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
  } | null;
}

export interface CommerceItem {
  sourceId: string;
  name: string;
  description: string | null;
  type: string | null;
  quantity: number;
  unitAmount: number;
}

export interface CommerceOrder {
  sourcePlatform: string;
  externalOrderId: string;
  sourceStatus: string;
  normalizedStatus: NormalizedOrderStatus;
  sourceCreatedAt: string;
  sourceUpdatedAt: string;
  /** Instante em que a origem confirmou o pagamento; null quando não informado. */
  sourcePaidAt: string | null;
  currency: string;
  subtotalAmount: number | null;
  totalAmount: number;
  paymentAmount: number | null;
  netAmount: number | null;
  feeAmount: number | null;
  /** Valor devolvido ao comprador até este evento; null quando a origem não informa. */
  refundedAmount: number | null;
  interestAmount: number | null;
  interestTransferAmount: number | null;
  paymentMethod: string | null;
  paymentType: string | null;
  installments: number;
  isSplitPayment: boolean;
  splitPayments: Array<{ role: string | null; method: string; amount: number }>;
  orderSessionId: string | null;
  attribution: Record<string, string>;
  customer: CommerceCustomer;
  items: CommerceItem[];
}

export interface ExistingOrderState {
  lastIngestSequence: number;
  lastSourceUpdatedAt: string | null;
  payloadFingerprint: string;
  normalizedStatus: NormalizedOrderStatus;
  lastAction?: string;
}

export type InboundCommerceEvent =
  | { disposition: "process_order"; entityKind: "order" }
  | {
    disposition: "defer";
    entityKind: string;
    externalEntityId: string | null;
    relatedOrderId: string | null;
    sourceStatus: string | null;
    reason: string;
  };

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Zouti mapping is incomplete; missing: ${name}`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function brazilianPhone(value: unknown): string | null {
  let digits = optionalString(value)?.replace(/\D/g, "") ?? "";
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    digits = digits.slice(2);
  }
  return digits || null;
}

/**
 * A Conta Azul só aceita celular como `DD9XXXXXXXX` ou `9XXXXXXXX` e responde
 * 400 para qualquer outra coisa — telefone estrangeiro, fixo ou incompleto.
 * Um telefone inválido não pode derrubar a venda: ele é omitido do cadastro e
 * preservado na observação do cliente.
 */
export function contaAzulMobilePhone(value: string | null | undefined): string | null {
  const digits = value?.replace(/\D/g, "") ?? "";
  if (/^[1-9][1-9]9\d{8}$/.test(digits) || /^9\d{8}$/.test(digits)) return digits;
  return null;
}

export function platformLabel(platform: string): string {
  const normalized = platform.trim().toLowerCase();
  if (normalized === "zouti") return "Zouti";
  if (normalized === "hotmart") return "Hotmart";
  return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : "Origem";
}

/**
 * Marcador durável gravado nas observações da venda. É por ele que uma
 * reexecução após ACK perdido reconhece a venda já criada para a transação.
 * O texto da Zouti é mantido byte a byte porque já existe em produção.
 */
export function orderReferenceLabel(platform: string): string {
  const normalized = platform.trim().toLowerCase();
  if (normalized === "zouti") return "Pedido Zouti";
  if (normalized === "hotmart") return "Transação Hotmart";
  return `Pedido ${platformLabel(platform)}`;
}

function finiteNumber(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Zouti mapping has invalid ${name}`);
  return parsed;
}

function money(inBrl: unknown, minorUnits: unknown, name: string): number {
  const explicit = Number(inBrl);
  if (Number.isFinite(explicit)) return Math.round(explicit * 100) / 100;
  return Math.round((finiteNumber(minorUnits, name) / 100) * 100) / 100;
}

function optionalMoney(inBrl: unknown, minorUnits: unknown, name: string): number | null {
  if (inBrl === null || inBrl === undefined) {
    if (minorUnits === null || minorUnits === undefined) return null;
  }
  return money(inBrl, minorUnits, name);
}

function isoDateTime(value: unknown, name: string): string {
  const raw = requiredString(value, name);
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) throw new Error(`Zouti mapping has invalid ${name}`);
  return new Date(timestamp).toISOString();
}

export function normalizePlatform(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
  if (!normalized) throw new Error("Zouti mapping requires a source platform");
  return normalized;
}

export function normalizeOrderStatus(value: unknown): NormalizedOrderStatus {
  const status = String(value ?? "").trim().toUpperCase();
  if (["PAID", "APPROVED", "COMPLETED", "SUCCESS", "SUCCEEDED"].includes(status)) return "paid";
  if (["REFUSED", "REJECTED", "DECLINED", "FAILED", "REPROVED", "DENIED"].includes(status)) return "rejected";
  if (["CANCELLED", "CANCELED", "VOIDED"].includes(status)) return "cancelled";
  if (["REFUNDED", "REFUND", "FULLY_REFUNDED"].includes(status)) return "refunded";
  if (["PARTIALLY_REFUNDED", "PARTIAL_REFUND"].includes(status)) return "partially_refunded";
  if (["CHARGEBACK", "CHARGED_BACK", "DISPUTED", "DISPUTE"].includes(status)) return "chargeback";
  if (["PENDING", "WAITING", "AWAITING_PAYMENT", "UNPAID", "CREATED", "PROCESSING", "AUTHORIZED"].includes(status)) return "pending";
  return "unknown";
}

export function classifyInboundCommerceEvent(
  body: unknown,
  sourcePlatform: string,
): InboundCommerceEvent {
  const root = object(body);
  const platform = normalizePlatform(sourcePlatform);
  if (!root) {
    return {
      disposition: "defer",
      entityKind: "invalid_body",
      externalEntityId: null,
      relatedOrderId: null,
      sourceStatus: null,
      reason: "body_is_not_an_object",
    };
  }

  const externalEntityId = optionalString(root.id);
  const sourceStatus = optionalString(root.status)?.toUpperCase() ?? null;
  const nestedOrder = object(root.order);
  const relatedOrderId = optionalString(root.order_id)
    ?? optionalString(nestedOrder?.id)
    ?? (externalEntityId?.startsWith("ord_") ? externalEntityId : null);

  if (platform !== "zouti") {
    return {
      disposition: "defer",
      entityKind: platform === "hotmart" ? "hotmart_event" : "unsupported_platform_event",
      externalEntityId,
      relatedOrderId,
      sourceStatus,
      reason: "platform_adapter_not_implemented",
    };
  }

  if (
    externalEntityId?.startsWith("ord_") &&
    object(root.customer) &&
    Array.isArray(root.items) &&
    root.items.length > 0 &&
    sourceStatus
  ) {
    return { disposition: "process_order", entityKind: "order" };
  }

  const entityKind = externalEntityId?.startsWith("pmt_")
    ? "payment"
    : externalEntityId?.startsWith("sub_")
    ? "subscription"
    : externalEntityId?.startsWith("smi_")
    ? "subscription_installment"
    : externalEntityId?.startsWith("rrq_")
    ? "refund_request"
    : externalEntityId?.startsWith("ord_")
    ? "incomplete_order"
    : "zouti_auxiliary_event";
  return {
    disposition: "defer",
    entityKind,
    externalEntityId,
    relatedOrderId,
    sourceStatus,
    reason: entityKind === "incomplete_order" ? "order_mapping_incomplete" : "auxiliary_event_requires_correlation",
  };
}

export function parseZoutiOrder(body: unknown, sourcePlatform: string): CommerceOrder {
  const root = object(body);
  if (!root) throw new Error("Webhook body is not a JSON object");
  const customer = object(root.customer);
  if (!customer) throw new Error("Zouti mapping is incomplete; missing: customer");
  if (!Array.isArray(root.items) || root.items.length === 0) {
    throw new Error("Zouti mapping requires at least one item");
  }

  const shipping = object(root.shipping_address);
  const payment = object(root.payment);
  const utm = object(root.utm_data);
  const tracking = object(root.tracking);
  const sourceStatus = requiredString(root.status, "status").toUpperCase();
  const totalAmount = money(root.amount_total_in_brl, root.amount_total, "amount_total");
  if (totalAmount < 0) throw new Error("Zouti mapping requires a non-negative total");

  const items = root.items.map((raw, index): CommerceItem => {
    const item = object(raw);
    if (!item) throw new Error(`Zouti mapping has invalid item ${index + 1}`);
    const quantity = finiteNumber(item.quantity, `items[${index}].quantity`);
    if (quantity <= 0) throw new Error(`Zouti mapping requires positive item quantity at ${index}`);
    const itemTotal = money(item.amount_in_brl, item.amount, `items[${index}].amount`);
    return {
      sourceId: requiredString(item.product_id, `items[${index}].product_id`),
      name: requiredString(item.name, `items[${index}].name`),
      description: optionalString(item.description),
      type: optionalString(item.type),
      quantity,
      unitAmount: Math.round((itemTotal / quantity) * 100) / 100,
    };
  });

  const splitPayments = Array.isArray(root.split_payments)
    ? root.split_payments.flatMap((raw) => {
      const split = object(raw);
      if (!split || !optionalString(split.method)) return [];
      return [{
        role: optionalString(split.role),
        method: requiredString(split.method, "split_payments.method").toUpperCase(),
        amount: money(undefined, split.amount, "split_payments.amount"),
      }];
    })
    : [];

  const document = optionalString(customer.document)?.replace(/\D/g, "") || null;
  const email = optionalString(customer.email)?.toLowerCase() ?? null;
  const createdAt = isoDateTime(root.created_at, "created_at");
  const updatedAt = isoDateTime(root.updated_at ?? root.created_at, "updated_at");
  const paymentAmount = payment ? optionalMoney(payment.amount_in_brl, payment.amount, "payment.amount") : null;
  const refundedAmount = payment
    ? optionalMoney(payment.amount_refunded_in_brl, payment.amount_refunded, "payment.amount_refunded")
    : null;
  // A Zouti pode manter `status: PAID` e informar a devolução só em
  // `payment.amount_refunded`. Devolução menor que o cobrado é reembolso
  // parcial; igual ou maior é reembolso total. O status declarado nunca é
  // rebaixado por este cálculo — só refinado.
  let normalizedStatus = normalizeOrderStatus(sourceStatus);
  const chargedAmount = paymentAmount ?? totalAmount;
  if (refundedAmount !== null && refundedAmount > 0 && chargedAmount > 0) {
    if (normalizedStatus === "paid") {
      normalizedStatus = refundedAmount < chargedAmount ? "partially_refunded" : "refunded";
    } else if (normalizedStatus === "refunded" && refundedAmount < chargedAmount) {
      normalizedStatus = "partially_refunded";
    }
  }

  const attribution = Object.fromEntries([
    ["utm_source", optionalString(utm?.utm_source) ?? optionalString(tracking?.source)],
    ["utm_medium", optionalString(utm?.utm_medium) ?? optionalString(tracking?.medium)],
    ["utm_campaign", optionalString(utm?.utm_campaign) ?? optionalString(tracking?.campaign)],
    ["utm_content", optionalString(utm?.utm_content)],
    ["utm_term", optionalString(utm?.utm_term)],
    ["src", optionalString(tracking?.src)],
    ["sck", optionalString(tracking?.sck)],
  ].filter((entry): entry is [string, string] => Boolean(entry[1])));

  return {
    sourcePlatform: normalizePlatform(optionalString(root.provider) ?? sourcePlatform),
    externalOrderId: requiredString(root.id, "id"),
    sourceStatus,
    normalizedStatus,
    sourceCreatedAt: createdAt,
    sourceUpdatedAt: updatedAt,
    sourcePaidAt: optionalString(payment?.paid_at) ? isoDateTime(payment?.paid_at, "payment.paid_at") : null,
    currency: requiredString(root.currency, "currency").toUpperCase(),
    subtotalAmount: optionalMoney(root.amount_subtotal_in_brl, root.amount_subtotal, "amount_subtotal"),
    totalAmount,
    paymentAmount,
    netAmount: payment ? optionalMoney(payment.net_amount_in_brl, payment.net_amount, "payment.net_amount") : null,
    feeAmount: payment ? optionalMoney(payment.fee_in_brl, payment.fee, "payment.fee") : null,
    refundedAmount,
    interestAmount: payment
      ? optionalMoney(payment.interest_amount_in_brl, payment.interest_amount, "payment.interest_amount")
      : null,
    interestTransferAmount: payment
      ? optionalMoney(
        payment.interest_transfer_amount_in_brl,
        payment.interest_transfer_amount,
        "payment.interest_transfer_amount",
      )
      : null,
    paymentMethod: optionalString(payment?.method)?.toUpperCase() ?? null,
    paymentType: optionalString(root.payment_type)?.toUpperCase() ?? null,
    installments: Math.max(1, Math.trunc(Number(payment?.installments) || 1)),
    isSplitPayment: root.is_split_payment === true || splitPayments.length > 1,
    splitPayments,
    orderSessionId: optionalString(root.order_session_id),
    attribution,
    customer: {
      sourceId: requiredString(root.customer_id, "customer_id"),
      name: requiredString(customer.name, "customer.name"),
      document,
      email,
      phone: brazilianPhone(customer.phone),
      address: shipping
        ? {
          postalCode: optionalString(shipping.postal_code)?.replace(/\D/g, "") || null,
          street: optionalString(shipping.line1),
          number: optionalString(shipping.line2),
          complement: optionalString(shipping.line3),
          neighborhood: optionalString(shipping.neighborhood),
          city: optionalString(shipping.city),
          state: optionalString(shipping.state),
          country: optionalString(shipping.country),
        }
        : null,
    },
    items,
  };
}

export function classifyOrderTransition(
  existing: ExistingOrderState | null,
  incoming: CommerceOrder,
  ingestSequence: number,
  payloadFingerprint: string,
): "apply" | "duplicate" | "stale" {
  if (!existing) return "apply";
  // The order row is persisted before any upstream write. If the function dies
  // before the append-only event is recorded, the same queue delivery must
  // resume instead of being mistaken for stale input.
  if (
    existing.lastIngestSequence === ingestSequence &&
    existing.payloadFingerprint === payloadFingerprint
  ) return "apply";
  if (
    existing.payloadFingerprint === payloadFingerprint &&
    !["received", "syncing"].includes(existing.lastAction ?? "")
  ) return "duplicate";
  if (ingestSequence <= existing.lastIngestSequence) return "stale";

  const previousTime = existing.lastSourceUpdatedAt ? Date.parse(existing.lastSourceUpdatedAt) : Number.NaN;
  const incomingTime = Date.parse(incoming.sourceUpdatedAt);
  if (Number.isFinite(previousTime) && incomingTime < previousTime) return "stale";

  const terminalPriority: Partial<Record<NormalizedOrderStatus, number>> = {
    cancelled: 1,
    refunded: 2,
    chargeback: 3,
  };
  const previousPriority = terminalPriority[existing.normalizedStatus] ?? 0;
  const incomingPriority = terminalPriority[incoming.normalizedStatus] ?? 0;
  if (previousPriority > 0 && incomingPriority <= previousPriority) return "stale";
  if (existing.normalizedStatus === "paid" && ["pending", "rejected", "unknown"].includes(incoming.normalizedStatus)) {
    return "stale";
  }
  // Um reembolso parcial já registrado não volta a "pago" nem a estados
  // anteriores; só avança para outro parcial (valor maior) ou para uma
  // reversão terminal.
  if (
    existing.normalizedStatus === "partially_refunded" &&
    ["paid", "pending", "rejected", "unknown"].includes(incoming.normalizedStatus)
  ) {
    return "stale";
  }
  return "apply";
}

/**
 * - `paid` cria ou atualiza a venda aprovada;
 * - `partially_refunded` mantém a venda aprovada e baixada e anota nela o
 *   valor devolvido e o valor retido (`annotate_sale`);
 * - reversões terminais cancelam a venda vinculada;
 * - sem venda vinculada, tudo que não é pagamento só é registrado.
 */
export function desiredOrderAction(
  status: NormalizedOrderStatus,
  hasSale: boolean,
): "upsert_sale" | "annotate_sale" | "cancel_sale" | "record_only" {
  if (status === "paid") return "upsert_sale";
  if (hasSale && status === "partially_refunded") return "annotate_sale";
  if (hasSale && ["cancelled", "refunded", "chargeback"].includes(status)) return "cancel_sale";
  return "record_only";
}

export function isCancelledSaleSituation(value: string | null | undefined): boolean {
  return value?.trim().toUpperCase() === "CANCELADO";
}

export function saleObservationsBelongToOrder(
  observations: string | null | undefined,
  externalOrderId: string,
): boolean {
  if (!observations) return false;
  return ["Pedido Zouti", "Transação Hotmart"].some((label) =>
    observations.includes(`${label}: ${externalOrderId}`)
  ) || observations.includes(`ordem ${externalOrderId}`);
}

export function reconcileCustomerMatchIds(matchGroups: string[][]): string | null {
  const uniqueIds = [...new Set(matchGroups.flat())];
  if (uniqueIds.length > 1) {
    throw new Error("Conta Azul customer identity conflict across document, email or phone");
  }
  return uniqueIds[0] ?? null;
}

export function contaAzulPaymentMethod(order: CommerceOrder): string {
  if (order.splitPayments.length > 1) return "OUTRO";
  const method = order.paymentMethod ?? order.splitPayments[0]?.method ?? "OUTRO";
  const mappings: Record<string, string> = {
    PIX: "PIX_PAGAMENTO_INSTANTANEO",
    CREDIT_CARD: "CARTAO_CREDITO",
    CARD: "CARTAO_CREDITO",
    DEBIT_CARD: "CARTAO_DEBITO",
    BOLETO: "BOLETO_BANCARIO",
    BANK_SLIP: "BOLETO_BANCARIO",
    BILLET: "BOLETO_BANCARIO",
    FINANCED_BILLET: "BOLETO_BANCARIO",
    BANK_TRANSFER: "TRANSFERENCIA_BANCARIA",
    DIRECT_BANK_TRANSFER: "TRANSFERENCIA_BANCARIA",
    DIRECT_DEBIT: "TRANSFERENCIA_BANCARIA",
    TRANSFER: "TRANSFERENCIA_BANCARIA",
    CASH: "DINHEIRO",
    WALLET: "CARTEIRA_DIGITAL",
    APPLE_PAY: "CARTEIRA_DIGITAL",
    GOOGLE_PAY: "CARTEIRA_DIGITAL",
    SAMSUNG_PAY: "CARTEIRA_DIGITAL",
    PICPAY: "CARTEIRA_DIGITAL",
  };
  return mappings[method] ?? "OUTRO";
}

export function contaAzulSku(sourceProductId: string, platform = "zouti"): string {
  const normalized = sourceProductId.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const normalizedPlatform = platform.trim().toLowerCase();
  const prefix = normalizedPlatform === "zouti"
    ? "ZO"
    : normalizedPlatform === "hotmart"
    ? "HM"
    : normalizedPlatform.toUpperCase().replace(/[^A-Z0-9]/g, "").padEnd(2, "X").slice(0, 2);
  return `${prefix}${normalized.slice(-18).padStart(18, "0")}`;
}

export function buildContaAzulPerson(order: CommerceOrder): JsonObject {
  const customer = order.customer;
  const type = customer.document?.length === 14
    ? "Jurídica"
    : customer.document?.length === 11
    ? "Física"
    : "Estrangeira";
  const mobilePhone = contaAzulMobilePhone(customer.phone);
  const observation = [
    `Sincronizado pelo HumanOS; origem ${order.sourcePlatform}; cliente ${customer.sourceId}`,
    customer.phone && !mobilePhone ? `telefone informado: ${customer.phone}` : null,
  ].filter(Boolean).join("; ");
  const result: JsonObject = {
    ativo: true,
    nome: customer.name.slice(0, 200),
    email: customer.email?.slice(0, 100),
    telefone_celular: mobilePhone,
    tipo_pessoa: type,
    perfis: [{ tipo_perfil: "Cliente" }],
    observacao: observation.slice(0, 2000),
  };
  if (type === "Física") result.cpf = customer.document;
  if (type === "Jurídica") result.cnpj = customer.document;
  if (customer.address && Object.values(customer.address).some(Boolean)) {
    result.enderecos = [{
      cep: customer.address.postalCode,
      logradouro: customer.address.street?.slice(0, 100),
      numero: customer.address.number?.slice(0, 10),
      complemento: customer.address.complement?.slice(0, 200),
      bairro: customer.address.neighborhood?.slice(0, 100),
      cidade: customer.address.city,
      estado: customer.address.state,
      pais: customer.address.country === "BR" ? "Brasil" : customer.address.country,
    }];
  }
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== null && value !== undefined));
}

export function buildContaAzulProduct(item: CommerceItem, platform = "zouti"): JsonObject {
  return {
    ativo: true,
    status: "ATIVO",
    formato: "SIMPLES",
    nome: item.name.slice(0, 100),
    codigo_sku: contaAzulSku(item.sourceId, platform),
    descricao: `${item.description ?? item.name} | Origem ${platformLabel(platform)}: ${item.sourceId}`.slice(0, 400),
    estoque: { valor_venda: item.unitAmount },
  };
}

function brl(value: number): string {
  return `R$ ${value.toFixed(2).replace(".", ",")}`;
}

function statusLabel(status: NormalizedOrderStatus): string {
  return {
    paid: "Aprovado/pago",
    pending: "Pendente",
    rejected: "Recusado/reprovado",
    cancelled: "Cancelado",
    refunded: "Reembolsado",
    partially_refunded: "Reembolsado parcialmente",
    chargeback: "Chargeback/contestação",
    unknown: "Não mapeado",
  }[status];
}

/**
 * Bloco de reembolso parcial. Ele vai para a mesma venda da Conta Azul: a venda
 * continua aprovada e baixada, e o registro passa a dizer quanto foi devolvido
 * e quanto ficou. Sem valor informado pela origem (Hotmart), o bloco marca a
 * pendência de conferência em vez de inventar um número.
 */
function refundLines(order: CommerceOrder): string[] {
  const refunded = order.refundedAmount;
  if (order.normalizedStatus !== "partially_refunded" && !(refunded !== null && refunded > 0)) return [];
  const charged = order.paymentAmount ?? order.totalAmount;
  if (refunded === null) {
    return [
      "REEMBOLSO PARCIAL",
      "Valor reembolsado: não informado pela plataforma — conferir no extrato",
      `Data do reembolso: ${order.sourceUpdatedAt}`,
    ];
  }
  return [
    "REEMBOLSO PARCIAL",
    `Valor reembolsado: ${brl(refunded)}`,
    `Valor mantido: ${brl(Math.max(0, Math.round((charged - refunded) * 100) / 100))} de ${brl(charged)}`,
    `Data do reembolso: ${order.sourceUpdatedAt}`,
  ];
}

function paymentDescription(order: CommerceOrder): string {
  const lines = [
    `PAGAMENTO ${platformLabel(order.sourcePlatform).toUpperCase()}`,
    `Situação: ${statusLabel(order.normalizedStatus)} (${order.sourceStatus})`,
    `Método: ${order.paymentMethod ?? "Não informado"}`,
    `Tipo: ${order.paymentType ?? "Não informado"}`,
    `Parcelamento: ${order.installments === 1 ? "À vista (1x)" : `${order.installments} parcelas`}`,
    `Moeda: ${order.currency}`,
    order.subtotalAmount === null ? null : `Subtotal: ${brl(order.subtotalAmount)}`,
    `Total cobrado: ${brl(order.paymentAmount ?? order.totalAmount)}`,
    order.interestAmount === null ? null : `Juros: ${brl(order.interestAmount)}`,
    order.interestTransferAmount === null ? null : `Juros repassados: ${brl(order.interestTransferAmount)}`,
    `Taxa da plataforma: ${brl(order.feeAmount ?? 0)}`,
    `Valor líquido: ${brl(order.netAmount ?? order.totalAmount)}`,
    ...refundLines(order),
  ].filter((line): line is string => Boolean(line));
  if (order.splitPayments.length) {
    lines.push("Divisão do pagamento:");
    order.splitPayments.forEach((split, index) => {
      lines.push(`- ${split.role ?? `Parte ${index + 1}`}: ${split.method} — ${brl(split.amount)}`);
    });
  } else {
    lines.push(`Pagamento dividido: ${order.isSplitPayment ? "Sim" : "Não"}`);
  }
  return lines.join("\n").slice(0, 4000);
}

function saleDescription(
  order: CommerceOrder,
  trace?: { webhookId: string; ingestSequence: number; receivedAt: string; eventType: string | null },
): string {
  const label = platformLabel(order.sourcePlatform);
  const lines = [
    `INTEGRAÇÃO HUMANOS • ${label.toUpperCase()}`,
    `Situação atual: ${statusLabel(order.normalizedStatus)} (${order.sourceStatus})`,
    `${orderReferenceLabel(order.sourcePlatform)}: ${order.externalOrderId}`,
    order.orderSessionId ? `Sessão do pedido: ${order.orderSessionId}` : null,
    `Criado na ${label}: ${order.sourceCreatedAt}`,
    `Atualizado na ${label}: ${order.sourceUpdatedAt}`,
    trace ? `Recebido pelo HumanOS: ${trace.receivedAt}` : null,
    trace?.eventType ? `Evento de entrada: ${trace.eventType}` : null,
    trace ? `Webhook: ${trace.webhookId}` : null,
    trace ? `Sequência de ingestão: ${trace.ingestSequence}` : null,
    ...(refundLines(order).length ? ["", ...refundLines(order)] : []),
    "",
    "ITENS",
    ...order.items.flatMap((item, index) => [
      `${index + 1}. ${item.name}`,
      `   Produto ${label}: ${item.sourceId}${item.type ? ` | Tipo: ${item.type}` : ""}`,
      `   Quantidade: ${item.quantity} | Unitário: ${brl(item.unitAmount)} | Total: ${brl(item.unitAmount * item.quantity)}`,
      item.description ? `   Descrição: ${item.description}` : null,
    ]),
  ].filter((line): line is string => line !== null);
  const attribution = Object.entries(order.attribution);
  if (attribution.length) {
    lines.push("", "ATRIBUIÇÃO / CAMPANHA");
    attribution.forEach(([key, value]) => lines.push(`${key}: ${value}`));
  }
  return lines.join("\n").slice(0, 4000);
}

export function buildContaAzulSale(
  order: CommerceOrder,
  input: {
    customerId: string;
    productIds: string[];
    saleNumber: number;
    financialAccountId: string;
    categoryId: string | null;
    situation: "APROVADO" | "CANCELADO";
    version?: number | null;
    trace?: { webhookId: string; ingestSequence: number; receivedAt: string; eventType: string | null };
  },
): JsonObject {
  if (input.productIds.length !== order.items.length) {
    throw new Error("Conta Azul product mapping is incomplete");
  }
  // O total cobrado manda. Desconto ou acréscimo no pedido é rateado
  // proporcionalmente entre os itens, para nenhum item ficar negativo quando o
  // desconto é maior que o primeiro item; o resíduo de arredondamento vai para o
  // item de maior valor. A Conta Azul recusa item com valor zero, então brindes
  // e bônus gratuitos ficam só na descrição da venda, fora da lista de itens.
  const round = (value: number) => Math.round(value * 100) / 100;
  const values = order.items.map((item) => item.unitAmount);
  const lineTotal = () => order.items.reduce((sum, item, index) => sum + item.quantity * values[index], 0);
  const mappedTotal = lineTotal();
  if (mappedTotal > 0 && Math.abs(order.totalAmount - mappedTotal) >= 0.005) {
    const scale = order.totalAmount / mappedTotal;
    for (let index = 0; index < values.length; index += 1) values[index] = round(values[index] * scale);
  }
  const residual = round(order.totalAmount - lineTotal());
  if (residual !== 0) {
    const anchor = values.reduce((best, value, index) => (value > values[best] ? index : best), 0);
    values[anchor] = round(values[anchor] + residual / order.items[anchor].quantity);
  }
  const billable = order.items
    .map((item, index) => ({ item, index, value: values[index] }))
    .filter(({ value }) => value > 0);
  if (billable.length === 0) {
    throw new Error("Conta Azul sale requires at least one item with a positive value");
  }

  const sale: JsonObject = {
    id_cliente: input.customerId,
    numero: input.saleNumber,
    situacao: input.situation,
    data_venda: order.sourceCreatedAt.slice(0, 10),
    observacoes: saleDescription(order, input.trace),
    observacoes_pagamento: paymentDescription(order),
    itens: billable.map(({ item, index, value }) => ({
      id: input.productIds[index],
      descricao: [
        item.name,
        item.description,
        `Produto ${platformLabel(order.sourcePlatform)}: ${item.sourceId}`,
        item.type ? `Tipo: ${item.type}` : null,
      ].filter(Boolean).join(" | ").slice(0, 400),
      quantidade: item.quantity,
      valor: value,
    })),
    condicao_pagamento: {
      tipo_pagamento: contaAzulPaymentMethod(order),
      id_conta_financeira: input.financialAccountId,
      opcao_condicao_pagamento: "À vista",
      nsu: order.externalOrderId,
      parcelas: [{
        data_vencimento: order.sourceCreatedAt.slice(0, 10),
        valor: order.totalAmount,
        descricao: `Ordem ${order.externalOrderId}`,
      }],
    },
  };
  if (input.categoryId) sale.id_categoria = input.categoryId;
  if (input.version !== null && input.version !== undefined) sale.versao = Math.max(1, input.version);
  return sale;
}
