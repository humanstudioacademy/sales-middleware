import type { CommerceItem, CommerceOrder, NormalizedOrderStatus } from "./zouti-order.ts";

export type EnrollmentAction = "grant" | "revoke" | "record_only";

export type EnrollmentAccessState = "pending" | "granted" | "revoked";

export interface StudentPortalOffer {
  source_platform: string;
  source_product_id: string;
  edition_code: string;
  product_label: string | null;
  enabled: boolean;
}

export interface ResolvedOffer {
  editionCode: string;
  item: CommerceItem;
}

/**
 * Contratos exatos aceitos por `POST /functions/v1/matricula`. O mesmo endpoint
 * atende os dois casos e distingue pelo campo `acao`: ausente cadastra,
 * `revogar` remove o acesso.
 */
export interface MatriculaPayload {
  email: string;
  edicao: string;
  nome: string;
  origem: string;
}

export interface RevogacaoPayload {
  acao: "revogar";
  email: string;
  edicao: string;
  motivo: string;
}

export interface EnrollmentRequest {
  url: string;
  headers: Headers;
  body: string;
}

/**
 * A venda pertence ao portal quando um item da ordem está mapeado para uma
 * edição ativa. O produto é a fonte de verdade: a query `?event=` da Zouti não
 * participa da decisão, então uma URL cadastrada errada não cria nem impede
 * matrícula. Ofertas que apontam para edições diferentes na mesma ordem são um
 * erro de cadastro e param o item em vez de escolher uma edição no escuro.
 */
export function resolveEnrollmentOffer(
  order: CommerceOrder,
  offers: StudentPortalOffer[],
): ResolvedOffer | null {
  const active = new Map<string, StudentPortalOffer>();
  for (const offer of offers) {
    if (!offer.enabled) continue;
    if (offer.source_platform.trim().toLowerCase() !== order.sourcePlatform) continue;
    active.set(offer.source_product_id.trim(), offer);
  }

  const matches: ResolvedOffer[] = [];
  for (const item of order.items) {
    const offer = active.get(item.sourceId.trim());
    if (offer) matches.push({ editionCode: offer.edition_code, item });
  }
  if (matches.length === 0) return null;

  const editions = new Set(matches.map((match) => match.editionCode));
  if (editions.size > 1) {
    throw new Error(
      `Student portal mapping conflict; order ${order.externalOrderId} matches editions ${
        [...editions].sort().join(", ")
      }`,
    );
  }
  return matches[0];
}

/**
 * `paid` libera o acesso; uma reversão terminal só revoga quando o acesso
 * chegou a ser concedido, para o portal nunca receber revogação de aluno que
 * não existe. Os demais estados ficam apenas auditados.
 */
export function desiredEnrollmentAction(
  status: NormalizedOrderStatus,
  accessState: EnrollmentAccessState,
): EnrollmentAction {
  if (status === "paid") return "grant";
  if (accessState === "granted" && ["cancelled", "refunded", "chargeback"].includes(status)) {
    return "revoke";
  }
  return "record_only";
}

/**
 * O portal identifica o aluno pelo e-mail. Uma ordem sem e-mail não pode virar
 * matrícula silenciosamente: ela para com erro de mapeamento e fica visível.
 */
function requiredEmail(order: CommerceOrder): string {
  const email = order.customer.email?.trim();
  if (!email) {
    throw new Error(
      `Student portal mapping is incomplete; order ${order.externalOrderId} has no customer e-mail`,
    );
  }
  return email;
}

/** Motivo legível da revogação, derivado do status normalizado da ordem. */
export function revocationReason(status: NormalizedOrderStatus): string {
  return {
    refunded: "reembolso",
    chargeback: "chargeback",
    cancelled: "cancelamento",
  }[status as "refunded" | "chargeback" | "cancelled"] ?? status;
}

export function buildMatriculaPayload(
  order: CommerceOrder,
  editionCode: string,
): MatriculaPayload {
  return {
    email: requiredEmail(order),
    edicao: editionCode,
    nome: order.customer.name,
    origem: order.sourcePlatform,
  };
}

export function buildRevogacaoPayload(
  order: CommerceOrder,
  editionCode: string,
): RevogacaoPayload {
  return {
    acao: "revogar",
    email: requiredEmail(order),
    edicao: editionCode,
    motivo: revocationReason(order.normalizedStatus),
  };
}

export function buildEnrollmentRequest(input: {
  action: "grant" | "revoke";
  editionCode: string;
  order: CommerceOrder;
  item: CommerceItem;
  destinationUrl: string;
  token: string;
  trace: { webhookId: string; ingestSequence: number; bodySha256: string };
}): EnrollmentRequest {
  const payload = input.action === "grant"
    ? buildMatriculaPayload(input.order, input.editionCode)
    : buildRevogacaoPayload(input.order, input.editionCode);
  const headers = new Headers({
    "content-type": "application/json",
    "x-matricula-token": input.token,
    // A ordem pode ser reenviada pela Zouti e o worker pode reentregar após um
    // ACK perdido. O corpo é idêntico nos dois casos, então a chave viaja no
    // header para o portal poder deduplicar quando quiser.
    "idempotency-key": `student-portal-${input.trace.webhookId}`,
    "x-humanos-source": input.order.sourcePlatform,
    "x-humanos-webhook-id": input.trace.webhookId,
    "x-humanos-ingest-sequence": String(input.trace.ingestSequence),
    "x-humanos-order-id": input.order.externalOrderId,
    "x-humanos-product-id": input.item.sourceId,
    "x-zouti-original-body-sha256": input.trace.bodySha256,
  });

  return {
    url: new URL(input.destinationUrl).toString(),
    headers,
    body: JSON.stringify(payload),
  };
}
