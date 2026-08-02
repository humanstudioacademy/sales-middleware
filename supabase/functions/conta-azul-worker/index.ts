import { contaAzulRequest } from "../_shared/conta-azul.ts";
import { databaseRequest, requiredEnvironment } from "../_shared/database.ts";
import { authenticateBearerToken, sha256Hex } from "../_shared/webhook.ts";
import {
  buildContaAzulPerson,
  buildContaAzulSale,
  classifyInboundCommerceEvent,
  classifyOrderTransition,
  contaAzulPaymentMethod,
  contaAzulSku,
  type CommerceItem,
  type CommerceOrder,
  desiredOrderAction,
  isCancelledSaleSituation,
  parseZoutiOrder,
} from "../_shared/zouti-order.ts";

type JsonObject = Record<string, unknown>;

interface ClaimedJob {
  message_id: number;
  attempt_number: number;
  webhook_id: string;
  ingest_sequence: number;
  received_at: string;
  processing_started_at: string;
  source_platform: string;
  source_event_type: string | null;
  body_sha256: string;
  body_json: unknown;
}

interface OrderRow {
  id: string;
  source_platform: string;
  external_order_id: string;
  current_source_status: string;
  normalized_status: CommerceOrder["normalizedStatus"];
  last_ingest_sequence: number;
  last_source_updated_at: string | null;
  payload_fingerprint: string;
  conta_azul_customer_id: string | null;
  conta_azul_sale_id: string | null;
  conta_azul_sale_number: number | null;
  conta_azul_sale_version: number | null;
  financial_account_id: string | null;
  category_id: string | null;
  last_action: string;
  last_synced_at: string | null;
}

interface PlatformMapping {
  source_platform: string;
  financial_account_id: string | null;
  financial_account_name: string | null;
  category_id: string | null;
  category_name: string | null;
  enabled: boolean;
}

interface CustomerLink {
  source_platform: string;
  source_customer_id: string;
  conta_azul_customer_id: string;
  request_fingerprint: string;
}

interface ProductLink {
  source_platform: string;
  source_product_id: string;
  conta_azul_product_id: string;
  conta_azul_sku: string;
  conta_azul_item_kind: "product" | "service";
  request_fingerprint: string;
}

interface SaleDetails {
  id: string;
  version: number | null;
  situation: string | null;
  financialEventId: string | null;
  observations: string | null;
}

class ContaAzulHttpError extends Error {
  constructor(public status: number, operation: string, detail: string | null = null) {
    super(`Conta Azul ${operation} failed (${status})${detail ? `: ${detail}` : ""}`);
  }
}

class SaleNumberCollisionError extends Error {}

let lastUpstreamCallAt = 0;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function arrayFrom(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = object(value);
  const candidate = record?.items ?? record?.itens ?? record?.content;
  return Array.isArray(candidate) ? candidate : [];
}

function stringId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  const record = object(value);
  const candidate = record?.id ?? record?.uuid ?? record?.id_venda;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

function numberValue(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function databaseJson(path: string, init: RequestInit): Promise<unknown> {
  const response = await databaseRequest(path, init);
  if (!response.ok) {
    const raw = await response.text();
    let detail = "";
    try {
      const value = object(JSON.parse(raw));
      detail = [value?.code, value?.message, value?.details, value?.hint]
        .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
        .join(" | ");
    } catch {
      detail = raw;
    }
    detail = detail.replace(/[\w.+-]+@[\w.-]+/g, "[email]").replace(/\b\d{6,}\b/g, "[number]").slice(0, 500);
    throw new Error(`Database operation failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  if (response.status === 204) return null;
  const raw = await response.text();
  return raw ? JSON.parse(raw) : null;
}

async function rpc(name: string, body: JsonObject): Promise<unknown> {
  return await databaseJson(`/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function rateLimitedContaAzulRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const waitMilliseconds = Math.max(0, 125 - (Date.now() - lastUpstreamCallAt));
  if (waitMilliseconds > 0) await new Promise((resolve) => setTimeout(resolve, waitMilliseconds));
  lastUpstreamCallAt = Date.now();
  return await contaAzulRequest(path, init);
}

async function contaAzulJson(
  path: string,
  init: RequestInit,
  operation: string,
  acceptedStatuses: number[] = [],
): Promise<{ status: number; value: unknown }> {
  const response = await rateLimitedContaAzulRequest(path, init);
  const raw = await response.text();
  let value: unknown = null;
  if (raw) {
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
  }
  if (!response.ok && !acceptedStatuses.includes(response.status)) {
    const error = object(value);
    const errors = Array.isArray(error?.errors) ? error.errors : [];
    const detail = [error?.message, error?.error, error?.code, ...errors.flatMap((item) => {
      const entry = object(item);
      return [entry?.field, entry?.message, entry?.code];
    })]
      .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      .join(" | ")
      .replace(/[\w.+-]+@[\w.-]+/g, "[email]")
      .replace(/\b\d{6,}\b/g, "[number]")
      .slice(0, 800) || null;
    throw new ContaAzulHttpError(response.status, operation, detail);
  }
  return { status: response.status, value };
}

async function getOrderEvent(webhookId: string): Promise<boolean> {
  const rows = await databaseJson(
    `/rest/v1/conta_azul_order_events?select=webhook_id&webhook_id=eq.${encodeURIComponent(webhookId)}&limit=1`,
    { method: "GET" },
  ) as Array<{ webhook_id: string }>;
  return Boolean(rows[0]);
}

async function getDeferredEvent(webhookId: string): Promise<boolean> {
  const rows = await databaseJson(
    `/rest/v1/conta_azul_deferred_events?select=webhook_id&webhook_id=eq.${encodeURIComponent(webhookId)}&limit=1`,
    { method: "GET" },
  ) as Array<{ webhook_id: string }>;
  return Boolean(rows[0]);
}

async function deferEvent(
  job: ClaimedJob,
  event: Exclude<ReturnType<typeof classifyInboundCommerceEvent>, { disposition: "process_order" }>,
): Promise<void> {
  await databaseJson(
    "/rest/v1/conta_azul_deferred_events?on_conflict=webhook_id",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        webhook_id: job.webhook_id,
        ingest_sequence: job.ingest_sequence,
        source_platform: job.source_platform,
        entity_kind: event.entityKind,
        external_entity_id: event.externalEntityId,
        related_order_id: event.relatedOrderId,
        source_status: event.sourceStatus,
        reason: event.reason,
        payload_fingerprint: job.body_sha256,
      }),
    },
  );
}

async function getOrder(platform: string, externalOrderId: string): Promise<OrderRow | null> {
  const rows = await databaseJson(
    `/rest/v1/conta_azul_orders?select=*&source_platform=eq.${encodeURIComponent(platform)}&external_order_id=eq.${encodeURIComponent(externalOrderId)}&limit=1`,
    { method: "GET" },
  ) as OrderRow[];
  return rows[0] ?? null;
}

async function insertOrder(job: ClaimedJob, order: CommerceOrder): Promise<OrderRow> {
  const rows = await databaseJson("/rest/v1/conta_azul_orders?select=*", {
    method: "POST",
    headers: { "content-type": "application/json", prefer: "return=representation" },
    body: JSON.stringify({
      source_platform: order.sourcePlatform,
      external_order_id: order.externalOrderId,
      source_customer_id: order.customer.sourceId,
      current_source_status: order.sourceStatus,
      normalized_status: order.normalizedStatus,
      last_webhook_id: job.webhook_id,
      last_ingest_sequence: job.ingest_sequence,
      last_source_updated_at: order.sourceUpdatedAt,
      payload_fingerprint: job.body_sha256,
      last_action: "received",
    }),
  }) as OrderRow[];
  if (!rows[0]) throw new Error("Database did not return the inserted order");
  return rows[0];
}

async function patchOrder(id: string, fields: JsonObject): Promise<OrderRow> {
  const rows = await databaseJson(
    `/rest/v1/conta_azul_orders?id=eq.${encodeURIComponent(id)}&select=*`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json", prefer: "return=representation" },
      body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
    },
  ) as OrderRow[];
  if (!rows[0]) throw new Error("Database did not return the updated order");
  return rows[0];
}

async function recordOrderEvent(
  job: ClaimedJob,
  orderRow: OrderRow,
  order: CommerceOrder,
  action: string,
  httpStatus: number | null,
): Promise<void> {
  await databaseJson("/rest/v1/conta_azul_order_events?on_conflict=webhook_id", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      prefer: "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify({
      webhook_id: job.webhook_id,
      order_id: orderRow.id,
      ingest_sequence: job.ingest_sequence,
      source_status: order.sourceStatus,
      normalized_status: order.normalizedStatus,
      payload_fingerprint: job.body_sha256,
      action,
      conta_azul_http_status: httpStatus,
    }),
  });
}

async function getPlatformMapping(platform: string): Promise<PlatformMapping | null> {
  const rows = await databaseJson(
    `/rest/v1/conta_azul_platform_mappings?select=*&source_platform=eq.${encodeURIComponent(platform)}&limit=1`,
    { method: "GET" },
  ) as PlatformMapping[];
  return rows[0] ?? null;
}

function normalizedLabel(value: unknown): string {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function resolvePlatformMapping(order: CommerceOrder): Promise<PlatformMapping> {
  const configured = await getPlatformMapping(order.sourcePlatform);
  if (configured) {
    if (!configured.enabled || !configured.financial_account_id) {
      throw new Error(`Conta Azul platform mapping is disabled or incomplete: ${order.sourcePlatform}`);
    }
    return configured;
  }

  const accountsResult = await contaAzulJson(
    "/v1/conta-financeira?pagina=1&tamanho_pagina=100",
    { method: "GET" },
    "financial account lookup",
  );
  const platformLabel = normalizedLabel(order.sourcePlatform);
  const candidates = arrayFrom(accountsResult.value).map(object).filter((account): account is JsonObject => {
    if (!account) return false;
    const name = normalizedLabel(account.nome);
    return name.includes(platformLabel) && String(account.tipo ?? "") === "CONTA_CORRENTE";
  });
  if (candidates.length !== 1) {
    throw new Error(`Conta Azul financial account is not uniquely mapped for platform: ${order.sourcePlatform}`);
  }
  const accountId = stringId(candidates[0]);
  const accountName = typeof candidates[0].nome === "string" ? candidates[0].nome : null;
  if (!accountId || !accountName) throw new Error("Conta Azul financial account returned no identifier");

  const categoriesResult = await contaAzulJson(
    "/v1/categorias?pagina=1&tamanho_pagina=100&tipo=RECEITA&apenas_filhos=true&permite_apenas_filhos=true",
    { method: "GET" },
    "category lookup",
  );
  const searchable = normalizedLabel(order.items.map((item) => `${item.name} ${item.description ?? ""}`).join(" "));
  const preferred = searchable.includes("workshop")
    ? "workshop corporativa online"
    : searchable.includes("saas")
    ? "saas b2c"
    : "cursos online b2c";
  const category = arrayFrom(categoriesResult.value).map(object).find((candidate) =>
    candidate && normalizedLabel(candidate.nome).includes(preferred)
  ) ?? null;
  const categoryId = stringId(category);
  const categoryName = typeof category?.nome === "string" ? category.nome : null;

  const rows = await databaseJson(
    "/rest/v1/conta_azul_platform_mappings?on_conflict=source_platform&select=*",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify({
        source_platform: order.sourcePlatform,
        financial_account_id: accountId,
        financial_account_name: accountName,
        category_id: categoryId,
        category_name: categoryName,
        resolved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    },
  ) as PlatformMapping[];
  if (!rows[0]) throw new Error("Conta Azul platform mapping could not be persisted");
  return rows[0];
}

async function fingerprint(value: unknown): Promise<string> {
  return await sha256Hex(new TextEncoder().encode(JSON.stringify(value)));
}

async function getCustomerLink(order: CommerceOrder): Promise<CustomerLink | null> {
  const rows = await databaseJson(
    `/rest/v1/conta_azul_customer_links?select=*&source_platform=eq.${encodeURIComponent(order.sourcePlatform)}&source_customer_id=eq.${encodeURIComponent(order.customer.sourceId)}&limit=1`,
    { method: "GET" },
  ) as CustomerLink[];
  return rows[0] ?? null;
}

async function saveCustomerLink(
  order: CommerceOrder,
  customerId: string,
  requestFingerprint: string,
): Promise<void> {
  await databaseJson(
    "/rest/v1/conta_azul_customer_links?on_conflict=source_platform,source_customer_id",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        source_platform: order.sourcePlatform,
        source_customer_id: order.customer.sourceId,
        normalized_document: order.customer.document,
        normalized_email: order.customer.email,
        conta_azul_customer_id: customerId,
        request_fingerprint: requestFingerprint,
        updated_at: new Date().toISOString(),
      }),
    },
  );
}

async function ensureCustomer(order: CommerceOrder): Promise<string> {
  const person = buildContaAzulPerson(order);
  const requestFingerprint = await fingerprint(person);
  const linked = await getCustomerLink(order);
  if (linked) {
    if (linked.request_fingerprint !== requestFingerprint) {
      await contaAzulJson(`/v1/pessoas/${encodeURIComponent(linked.conta_azul_customer_id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(person),
      }, "customer update");
      await saveCustomerLink(order, linked.conta_azul_customer_id, requestFingerprint);
    }
    return linked.conta_azul_customer_id;
  }

  const query = new URLSearchParams({ pagina: "1", tamanho_pagina: "10", tipo_perfil: "Cliente" });
  if (order.customer.document) query.set("documentos", order.customer.document);
  else if (order.customer.email) query.set("emails", order.customer.email);
  else throw new Error("Conta Azul customer mapping requires a document or email");
  const search = await contaAzulJson(`/v1/pessoas?${query}`, { method: "GET" }, "customer lookup");
  const matches = arrayFrom(search.value).map(stringId).filter((id): id is string => Boolean(id));
  if (matches.length > 1) throw new Error("Conta Azul customer lookup returned multiple matches");

  let customerId: string | null = matches[0] ?? null;
  if (!customerId) {
    const created = await contaAzulJson("/v1/pessoas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(person),
    }, "customer creation");
    customerId = stringId(created.value);
  } else {
    await contaAzulJson(`/v1/pessoas/${encodeURIComponent(customerId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(person),
    }, "customer update");
  }
  if (!customerId) throw new Error("Conta Azul customer operation returned no identifier");
  await saveCustomerLink(order, customerId, requestFingerprint);
  return customerId;
}

async function getProductLink(order: CommerceOrder, item: CommerceItem): Promise<ProductLink | null> {
  const rows = await databaseJson(
    `/rest/v1/conta_azul_product_links?select=*&source_platform=eq.${encodeURIComponent(order.sourcePlatform)}&source_product_id=eq.${encodeURIComponent(item.sourceId)}&limit=1`,
    { method: "GET" },
  ) as ProductLink[];
  return rows[0] ?? null;
}

async function saveServiceLink(
  order: CommerceOrder,
  item: CommerceItem,
  serviceId: string,
  sku: string,
  requestFingerprint: string,
): Promise<void> {
  await databaseJson(
    "/rest/v1/conta_azul_product_links?on_conflict=source_platform,source_product_id",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        source_platform: order.sourcePlatform,
        source_product_id: item.sourceId,
        conta_azul_product_id: serviceId,
        conta_azul_sku: sku,
        conta_azul_item_kind: "service",
        request_fingerprint: requestFingerprint,
        updated_at: new Date().toISOString(),
      }),
    },
  );
}

async function ensureService(order: CommerceOrder, item: CommerceItem): Promise<string> {
  const serviceName = Deno.env.get("CONTA_AZUL_DEFAULT_SERVICE_NAME")?.trim() || "Academy Pass";
  const linked = await getProductLink(order, item);
  if (linked?.conta_azul_item_kind === "service") {
    return linked.conta_azul_product_id;
  }

  const sku = contaAzulSku(item.sourceId);
  const search = await contaAzulJson(
    `/v1/servicos?pagina=1&tamanho_pagina=100&busca_textual=${encodeURIComponent(serviceName)}`,
    { method: "GET" },
    "service lookup",
  );
  const matches = arrayFrom(search.value).map(object).filter((service): service is JsonObject =>
    Boolean(service) && normalizedLabel(service?.descricao) === normalizedLabel(serviceName) && service?.status === "ATIVO"
  );
  if (matches.length !== 1) {
    throw new Error(`Conta Azul service is not uniquely mapped: ${serviceName}`);
  }
  const serviceId = stringId(matches[0]);
  if (!serviceId) throw new Error("Conta Azul service operation returned no identifier");
  const requestFingerprint = await fingerprint({ kind: "service", serviceId, serviceName });
  await saveServiceLink(order, item, serviceId, sku, requestFingerprint);
  return serviceId;
}

function saleDetails(value: unknown): SaleDetails | null {
  const wrapper = object(value);
  const sale = object(wrapper?.venda) ?? wrapper;
  const id = stringId(sale) ?? stringId(wrapper);
  if (!id) return null;
  const situationValue = sale?.situacao;
  const situation = typeof situationValue === "string"
    ? situationValue
    : typeof object(situationValue)?.nome === "string"
    ? String(object(situationValue)?.nome)
    : null;
  const financialEvent = object(wrapper?.evento_financeiro) ?? object(sale?.evento_financeiro);
  return {
    id,
    version: numberValue(sale?.versao),
    situation,
    financialEventId: stringId(financialEvent),
    observations: typeof sale?.observacoes === "string" ? sale.observacoes : null,
  };
}

async function getSaleDetails(id: string): Promise<SaleDetails> {
  const response = await contaAzulJson(`/v1/venda/${encodeURIComponent(id)}`, { method: "GET" }, "sale lookup");
  const details = saleDetails(response.value);
  if (!details) throw new Error("Conta Azul sale lookup returned no identifier");
  return details;
}

async function findSaleByNumber(saleNumber: number, externalOrderId: string): Promise<SaleDetails | null> {
  const query = new URLSearchParams({ pagina: "1", tamanho_pagina: "10", numeros: String(saleNumber) });
  const response = await contaAzulJson(`/v1/venda/busca?${query}`, { method: "GET" }, "sale number lookup");
  for (const item of arrayFrom(response.value)) {
    const wrapper = object(item);
    const sale = object(wrapper?.venda) ?? wrapper;
    if (Number(sale?.numero) !== saleNumber) continue;
    const summary = saleDetails(item);
    if (!summary) continue;
    const details = summary.observations ? summary : await getSaleDetails(summary.id);
    if (details.observations?.includes(`ordem ${externalOrderId}`)) return details;
    throw new SaleNumberCollisionError(`Conta Azul sale number ${saleNumber} belongs to another sale`);
  }
  return null;
}

async function nextSaleNumber(): Promise<number> {
  const response = await contaAzulJson("/v1/venda/proximo-numero", { method: "GET" }, "next sale number lookup");
  const saleNumber = numberValue(response.value);
  if (!saleNumber || !Number.isSafeInteger(saleNumber) || saleNumber < 1) {
    throw new Error("Conta Azul returned an invalid next sale number");
  }
  return saleNumber;
}

async function allocateSaleNumber(orderRow: OrderRow): Promise<{ row: OrderRow; number: number }> {
  if (orderRow.conta_azul_sale_number) return { row: orderRow, number: orderRow.conta_azul_sale_number };
  const saleNumber = await nextSaleNumber();
  return { row: await patchOrder(orderRow.id, { conta_azul_sale_number: saleNumber, last_action: "syncing" }), number: saleNumber };
}

async function listFinancialInstallments(financialEventId: string): Promise<JsonObject[]> {
  const response = await contaAzulJson(
    `/v1/financeiro/eventos-financeiros/${encodeURIComponent(financialEventId)}/parcelas`,
    { method: "GET" },
    "financial installments lookup",
  );
  return arrayFrom(response.value).map(object).filter((item): item is JsonObject => Boolean(item));
}

async function existingSettlements(installmentId: string): Promise<JsonObject[]> {
  const response = await contaAzulJson(
    `/v1/financeiro/eventos-financeiros/parcelas/${encodeURIComponent(installmentId)}/baixa`,
    { method: "GET" },
    "settlement lookup",
    [404],
  );
  return response.status === 404
    ? []
    : arrayFrom(response.value).map(object).filter((item): item is JsonObject => Boolean(item));
}

async function ensureSaleSettled(
  details: SaleDetails,
  order: CommerceOrder,
  financialAccountId: string,
): Promise<number | null> {
  const refreshed = details.financialEventId ? details : await getSaleDetails(details.id);
  if (!refreshed.financialEventId) {
    throw new Error("Conta Azul sale returned no financial event for settlement");
  }
  const installments = await listFinancialInstallments(refreshed.financialEventId);
  if (installments.length === 0) throw new Error("Conta Azul sale returned no financial installments");
  let latestStatus: number | null = null;
  for (const installment of installments) {
    const installmentId = stringId(installment);
    if (!installmentId) throw new Error("Conta Azul installment returned no identifier");
    if ((await existingSettlements(installmentId)).length > 0) continue;
    const gross = numberValue(installment.valor)
      ?? numberValue(object(installment.detalhe_valor)?.valor_bruto)
      ?? order.totalAmount / installments.length;
    const response = await contaAzulJson(
      `/v1/financeiro/eventos-financeiros/parcelas/${encodeURIComponent(installmentId)}/baixa`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          data_pagamento: order.sourceUpdatedAt.slice(0, 10),
          composicao_valor: {
            multa: 0,
            juros: 0,
            valor_bruto: gross,
            desconto: 0,
            taxa: order.feeAmount ?? 0,
            valor_liquido: order.netAmount ?? gross,
          },
          conta_financeira: financialAccountId,
          metodo_pagamento: contaAzulPaymentMethod(order),
          observacao: `HumanOS | ordem ${order.externalOrderId}`,
          nsu: order.externalOrderId,
        }),
      },
      "settlement creation",
    );
    latestStatus = response.status;
  }
  return latestStatus;
}

async function reverseSaleSettlements(details: SaleDetails): Promise<number | null> {
  const refreshed = details.financialEventId ? details : await getSaleDetails(details.id);
  if (!refreshed.financialEventId) return null;
  const installments = await listFinancialInstallments(refreshed.financialEventId);
  let latestStatus: number | null = null;
  for (const installment of installments) {
    const installmentId = stringId(installment);
    if (!installmentId) continue;
    for (const settlement of await existingSettlements(installmentId)) {
      const settlementId = stringId(settlement);
      if (!settlementId) continue;
      const response = await contaAzulJson(
        `/v1/financeiro/eventos-financeiros/parcelas/baixa/${encodeURIComponent(settlementId)}`,
        { method: "DELETE" },
        "settlement reversal",
        [404],
      );
      latestStatus = response.status;
    }
  }
  return latestStatus;
}

async function complete(job: ClaimedJob, status: number | null): Promise<void> {
  await rpc("complete_integration_job", {
    p_destination: "conta_azul",
    p_message_id: job.message_id,
    p_webhook_id: job.webhook_id,
    p_attempt_number: job.attempt_number,
    p_started_at: job.processing_started_at,
    p_http_status: status,
  });
}

async function fail(job: ClaimedJob, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : "unknown error";
  const httpStatus = error instanceof ContaAzulHttpError ? error.status : null;
  const mappingError = /mapping|Webhook body|requires at least one item|invalid amount/i.test(message);
  const platformError = /platform|financial account/i.test(message);
  await rpc("fail_integration_job", {
    p_destination: "conta_azul",
    p_message_id: job.message_id,
    p_webhook_id: job.webhook_id,
    p_attempt_number: job.attempt_number,
    p_started_at: job.processing_started_at,
    p_http_status: httpStatus,
    p_error_code: mappingError
      ? "mapping_incomplete"
      : platformError
      ? "platform_account_unmapped"
      : "delivery_failed",
    p_error_message: message,
  });
}

async function finalizeOrder(
  job: ClaimedJob,
  orderRow: OrderRow,
  order: CommerceOrder,
  action: string,
  httpStatus: number | null,
  extra: JsonObject = {},
): Promise<OrderRow> {
  const updated = await patchOrder(orderRow.id, {
    source_customer_id: order.customer.sourceId,
    current_source_status: order.sourceStatus,
    normalized_status: order.normalizedStatus,
    last_webhook_id: job.webhook_id,
    last_ingest_sequence: job.ingest_sequence,
    last_source_updated_at: order.sourceUpdatedAt,
    payload_fingerprint: job.body_sha256,
    last_action: action,
    last_synced_at: new Date().toISOString(),
    ...extra,
  });
  await recordOrderEvent(job, updated, order, action, httpStatus);
  await complete(job, httpStatus);
  return updated;
}

async function processJob(
  job: ClaimedJob,
): Promise<"created" | "updated" | "recorded" | "no_change"> {
  if (await getOrderEvent(job.webhook_id) || await getDeferredEvent(job.webhook_id)) {
    await complete(job, 200);
    return "no_change";
  }

  const inbound = classifyInboundCommerceEvent(job.body_json, job.source_platform);
  if (inbound.disposition === "defer") {
    await deferEvent(job, inbound);
    await complete(job, 200);
    return "recorded";
  }

  const order = parseZoutiOrder(job.body_json, job.source_platform);
  let orderRow = await getOrder(order.sourcePlatform, order.externalOrderId);
  if (!orderRow) orderRow = await insertOrder(job, order);
  const transition = classifyOrderTransition({
    lastIngestSequence: orderRow.last_ingest_sequence,
    lastSourceUpdatedAt: orderRow.last_source_updated_at,
    payloadFingerprint: orderRow.payload_fingerprint,
    normalizedStatus: orderRow.normalized_status,
    lastAction: orderRow.last_action,
  }, order, job.ingest_sequence, job.body_sha256);
  if (transition !== "apply") {
    await recordOrderEvent(job, orderRow, order, transition, 200);
    await complete(job, 200);
    return "no_change";
  }

  const action = desiredOrderAction(order.normalizedStatus, Boolean(orderRow.conta_azul_sale_id));
  if (action === "record_only") {
    await finalizeOrder(job, orderRow, order, `recorded_${order.normalizedStatus}`, 200);
    return "recorded";
  }

  const mapping = await resolvePlatformMapping(order);
  let allocated = await allocateSaleNumber(orderRow);
  orderRow = allocated.row;
  let details: SaleDetails | null;
  if (orderRow.conta_azul_sale_id) {
    details = await getSaleDetails(orderRow.conta_azul_sale_id);
  } else {
    try {
      details = await findSaleByNumber(allocated.number, order.externalOrderId);
    } catch (error) {
      if (!(error instanceof SaleNumberCollisionError)) throw error;
      const replacement = await nextSaleNumber();
      if (replacement === allocated.number) throw error;
      orderRow = await patchOrder(orderRow.id, {
        conta_azul_sale_number: replacement,
        last_action: "sale_number_reallocated",
      });
      allocated = { row: orderRow, number: replacement };
      details = await findSaleByNumber(allocated.number, order.externalOrderId);
    }
  }

  if (action === "cancel_sale" && !details) {
    await finalizeOrder(job, orderRow, order, "cancel_without_sale", 200);
    return "recorded";
  }

  // Conta Azul rejects every PUT against an already cancelled sale. Treat a
  // repeated cancellation/refund/chargeback as an idempotent success while
  // still recording the newer source event and its strict ingest position.
  if (action === "cancel_sale" && details && isCancelledSaleSituation(details.situation)) {
    await finalizeOrder(job, orderRow, order, "sale_already_cancelled", 200, {
      conta_azul_sale_id: details.id,
      conta_azul_sale_version: details.version,
      financial_account_id: mapping.financial_account_id,
      category_id: mapping.category_id,
    });
    return "no_change";
  }

  const customerId = await ensureCustomer(order);
  const productIds: string[] = [];
  for (const item of order.items) productIds.push(await ensureService(order, item));
  const salePayload = buildContaAzulSale(order, {
    customerId,
    productIds,
    saleNumber: allocated.number,
    financialAccountId: mapping.financial_account_id!,
    categoryId: mapping.category_id,
    situation: action === "cancel_sale" ? "CANCELADO" : "APROVADO",
    version: details?.version,
    trace: {
      webhookId: job.webhook_id,
      ingestSequence: job.ingest_sequence,
      receivedAt: job.received_at,
      eventType: job.source_event_type,
    },
  });

  let httpStatus: number | null = null;
  let result: "created" | "updated" = details ? "updated" : "created";
  if (!details) {
    const response = await contaAzulJson("/v1/venda", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(salePayload),
    }, "sale creation");
    details = saleDetails(response.value);
    if (!details) throw new Error("Conta Azul sale creation returned no identifier");
    httpStatus = response.status;
    orderRow = await patchOrder(orderRow.id, {
      conta_azul_customer_id: customerId,
      conta_azul_sale_id: details.id,
      conta_azul_sale_version: details.version,
      financial_account_id: mapping.financial_account_id,
      category_id: mapping.category_id,
      last_action: "sale_created_settlement_pending",
    });
    details = await getSaleDetails(details.id);
  } else {
    if (action === "cancel_sale") await reverseSaleSettlements(details);
    const refreshed = await getSaleDetails(details.id);
    const updatePayload = buildContaAzulSale(order, {
      customerId,
      productIds,
      saleNumber: allocated.number,
      financialAccountId: mapping.financial_account_id!,
      categoryId: mapping.category_id,
      situation: action === "cancel_sale" ? "CANCELADO" : "APROVADO",
      version: refreshed.version,
      trace: {
        webhookId: job.webhook_id,
        ingestSequence: job.ingest_sequence,
        receivedAt: job.received_at,
        eventType: job.source_event_type,
      },
    });
    const response = await contaAzulJson(`/v1/venda/${encodeURIComponent(details.id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(updatePayload),
    }, "sale update");
    httpStatus = response.status;
    details = await getSaleDetails(details.id);
  }

  if (action === "upsert_sale") {
    httpStatus = (await ensureSaleSettled(details, order, mapping.financial_account_id!)) ?? httpStatus;
  }
  await finalizeOrder(job, orderRow, order, action === "cancel_sale" ? "sale_cancelled" : `sale_${result}`, httpStatus, {
    conta_azul_customer_id: customerId,
    conta_azul_sale_id: details.id,
    conta_azul_sale_version: details.version,
    financial_account_id: mapping.financial_account_id,
    category_id: mapping.category_id,
  });
  return result;
}

async function refreshExistingSaleBySequence(ingestSequence: number): Promise<JsonObject> {
  const rows = await databaseJson(
    `/rest/v1/webhook_inbox?select=id,ingest_sequence,received_at,source_platform,source_event_type,body_json&ingest_sequence=eq.${ingestSequence}&limit=1`,
    { method: "GET" },
  ) as Array<{
    id: string;
    ingest_sequence: number;
    received_at: string;
    source_platform: string;
    source_event_type: string | null;
    body_json: unknown;
  }>;
  const inbox = rows[0];
  if (!inbox) throw new Error("Webhook not found for Conta Azul refresh");

  const order = parseZoutiOrder(inbox.body_json, inbox.source_platform);
  const orderRow = await getOrder(order.sourcePlatform, order.externalOrderId);
  if (!orderRow?.conta_azul_sale_id || !orderRow.conta_azul_sale_number) {
    throw new Error("Conta Azul sale is not linked for refresh");
  }

  const mapping = await resolvePlatformMapping(order);
  const customerId = await ensureCustomer(order);
  const productIds: string[] = [];
  for (const item of order.items) productIds.push(await ensureService(order, item));
  let details = await getSaleDetails(orderRow.conta_azul_sale_id);
  const action = desiredOrderAction(order.normalizedStatus, true);
  if (action === "cancel_sale") await reverseSaleSettlements(details);
  const payload = buildContaAzulSale(order, {
    customerId,
    productIds,
    saleNumber: orderRow.conta_azul_sale_number,
    financialAccountId: mapping.financial_account_id!,
    categoryId: mapping.category_id,
    situation: action === "cancel_sale" ? "CANCELADO" : "APROVADO",
    version: details.version,
    trace: {
      webhookId: inbox.id,
      ingestSequence: inbox.ingest_sequence,
      receivedAt: inbox.received_at,
      eventType: inbox.source_event_type,
    },
  });
  const response = await contaAzulJson(`/v1/venda/${encodeURIComponent(details.id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }, "sale refresh");
  details = await getSaleDetails(details.id);
  if (action === "upsert_sale") await ensureSaleSettled(details, order, mapping.financial_account_id!);
  await patchOrder(orderRow.id, {
    current_source_status: order.sourceStatus,
    normalized_status: order.normalizedStatus,
    last_action: action === "cancel_sale" ? "sale_cancelled_refreshed" : "sale_refreshed",
    last_synced_at: new Date().toISOString(),
    conta_azul_customer_id: customerId,
    conta_azul_sale_version: details.version,
  });
  return {
    status: "refreshed",
    sale_id: details.id,
    sale_number: orderRow.conta_azul_sale_number,
    upstream_status: response.status,
  };
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const cronSecret = Deno.env.get("CRON_SECRET")?.trim()
      || Deno.env.get("INTEGRATION_ADMIN_SECRET")?.trim()
      || requiredEnvironment("STATUS_API_SECRET");
    if (!await authenticateBearerToken(request.headers, cronSecret)) {
      return json({ error: "unauthorized" }, 401);
    }

    const input = await request.json().catch(() => ({})) as {
      batch_size?: unknown;
      operation?: unknown;
      ingest_sequence?: unknown;
    };
    if (input.operation === "refresh_sale") {
      const ingestSequence = Number(input.ingest_sequence);
      if (!Number.isSafeInteger(ingestSequence) || ingestSequence < 1) {
        return json({ error: "invalid_ingest_sequence" }, 400);
      }
      return json(await refreshExistingSaleBySequence(ingestSequence));
    }

    const leaseToken = crypto.randomUUID();
    const acquired = await rpc("acquire_integration_worker_lease", {
      p_destination: "conta_azul",
      p_lease_token: leaseToken,
      p_lease_seconds: 180,
    });
    if (acquired !== true) return json({ status: "already_running" }, 202);

    try {
      const requested = Number(input.batch_size ?? 100);
      const batchSize = Number.isSafeInteger(requested) ? Math.min(Math.max(requested, 1), 300) : 100;
      const result = { claimed: 0, created: 0, updated: 0, recorded: 0, no_change: 0, failed: 0 };

      for (let index = 0; index < batchSize; index += 1) {
        const jobs = await rpc("claim_integration_jobs", {
          p_destination: "conta_azul",
          p_batch_size: 1,
          p_source_platform: "zouti",
        }) as ClaimedJob[];
        const job = jobs[0];
        if (!job) break;
        result.claimed += 1;
        try {
          result[await processJob(job)] += 1;
        } catch (error) {
          result.failed += 1;
          await fail(job, error);
          break;
        }
      }
      return json(result);
    } finally {
      await rpc("release_integration_worker_lease", {
        p_destination: "conta_azul",
        p_lease_token: leaseToken,
      }).catch(() => undefined);
    }
  } catch (error) {
    console.error("conta_azul_worker_failed", {
      message: error instanceof Error ? error.message : "unknown error",
    });
    return json({ error: "temporarily_unavailable" }, 503);
  }
});
