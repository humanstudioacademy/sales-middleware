import { contaAzulRequest } from "../_shared/conta-azul.ts";
import { databaseRequest, requiredEnvironment } from "../_shared/database.ts";
import { mapWebhookToContaAzulSale } from "../_shared/sale-mapper.ts";
import { authenticateBearerToken, sha256Hex } from "../_shared/webhook.ts";

interface ClaimedJob {
  message_id: number;
  attempt_number: number;
  webhook_id: string;
  ingest_sequence: number;
  processing_started_at: string;
  body_sha256: string;
  body_json: unknown;
}

let lastUpstreamCallAt = 0;

async function rateLimitedContaAzulRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const waitMilliseconds = Math.max(0, 125 - (Date.now() - lastUpstreamCallAt));
  if (waitMilliseconds > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMilliseconds));
  }
  lastUpstreamCallAt = Date.now();
  return await contaAzulRequest(path, init);
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await databaseRequest(`/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${name} failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  }
  return await response.json();
}

async function existingSaleId(webhookId: string): Promise<string | null> {
  const response = await databaseRequest(
    `/rest/v1/conta_azul_sale_links?select=conta_azul_sale_id&webhook_id=eq.${encodeURIComponent(webhookId)}&limit=1`,
    { method: "GET" },
  );
  if (!response.ok) throw new Error(`Unable to inspect sale link (${response.status})`);
  const rows = await response.json() as Array<{ conta_azul_sale_id: string }>;
  return rows[0]?.conta_azul_sale_id ?? null;
}

function saleIdFromResponse(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const candidate = record.id ?? record.id_venda ?? record.uuid;
  return typeof candidate === "string" && candidate ? candidate : null;
}

async function findSaleByNumber(saleNumber: unknown): Promise<string | null> {
  const parsed = Number(saleNumber);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Conta Azul sale number must be a non-negative integer");
  }
  const query = new URLSearchParams({
    pagina: "1",
    tamanho_pagina: "10",
    numeros: String(parsed),
  });
  const response = await rateLimitedContaAzulRequest(`/v1/venda/busca?${query}`);
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Conta Azul sale lookup failed (${response.status}): ${raw.slice(0, 1000)}`);
  }
  const decoded = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  const items = Array.isArray(decoded.itens) ? decoded.itens : [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (Number(record.numero) !== parsed) continue;
    const id = saleIdFromResponse(record) ?? saleIdFromResponse(record.venda);
    if (id) return id;
  }
  return null;
}

async function createSaleLink(
  webhookId: string,
  saleId: string,
  fingerprint: string,
  saleNumber: unknown,
): Promise<void> {
  const response = await databaseRequest("/rest/v1/conta_azul_sale_links", {
    method: "POST",
    headers: { "content-type": "application/json", prefer: "return=minimal" },
    body: JSON.stringify({
      webhook_id: webhookId,
      conta_azul_sale_id: saleId,
      request_fingerprint: fingerprint,
      sale_number: saleNumber === undefined || saleNumber === null ? null : String(saleNumber),
    }),
  });
  if (!response.ok && response.status !== 409) {
    throw new Error(`Unable to persist Conta Azul sale link (${response.status})`);
  }
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
  const statusMatch = message.match(/Conta Azul sale creation failed \((\d{3})\)/);
  await rpc("fail_integration_job", {
    p_destination: "conta_azul",
    p_message_id: job.message_id,
    p_webhook_id: job.webhook_id,
    p_attempt_number: job.attempt_number,
    p_started_at: job.processing_started_at,
    p_http_status: statusMatch ? Number(statusMatch[1]) : null,
    p_error_code: message.startsWith("Conta Azul mapping") || message.startsWith("Webhook body")
      ? "mapping_incomplete"
      : "delivery_failed",
    p_error_message: message,
  });
}

async function processJob(job: ClaimedJob): Promise<"created" | "already_created"> {
  if (await existingSaleId(job.webhook_id)) {
    await complete(job, 200);
    return "already_created";
  }

  const sale = mapWebhookToContaAzulSale(job.body_json);
  const serialized = JSON.stringify(sale);
  const fingerprint = await sha256Hex(new TextEncoder().encode(serialized));
  const recoveredSaleId = await findSaleByNumber(sale.numero);
  if (recoveredSaleId) {
    await createSaleLink(job.webhook_id, recoveredSaleId, fingerprint, sale.numero);
    await complete(job, 200);
    return "already_created";
  }
  const response = await rateLimitedContaAzulRequest("/v1/venda", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: serialized,
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Conta Azul sale creation failed (${response.status}): ${raw.slice(0, 1000)}`);
  }
  let decoded: unknown = raw;
  try {
    decoded = raw ? JSON.parse(raw) : null;
  } catch {
    // Some successful API responses may return a plain identifier.
  }
  const saleId = saleIdFromResponse(decoded)
    ?? response.headers.get("location")?.split("/").filter(Boolean).at(-1)
    ?? null;
  if (!saleId) throw new Error("Conta Azul created a sale but did not return its identifier");

  await createSaleLink(job.webhook_id, saleId, fingerprint, sale.numero);
  await complete(job, response.status);
  return "created";
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

    const leaseToken = crypto.randomUUID();
    const acquired = await rpc("acquire_integration_worker_lease", {
      p_destination: "conta_azul",
      p_lease_token: leaseToken,
      p_lease_seconds: 180,
    });
    if (acquired !== true) return json({ status: "already_running" }, 202);

    try {
      const input = await request.json().catch(() => ({})) as { batch_size?: unknown };
      const requested = Number(input.batch_size ?? 100);
      const batchSize = Number.isSafeInteger(requested) ? Math.min(Math.max(requested, 1), 300) : 100;
      const result = { claimed: 0, created: 0, already_created: 0, failed: 0 };

      // Claim one item at a time. A failed purchase blocks any newer refund
      // until the purchase succeeds or reaches dead-letter.
      for (let index = 0; index < batchSize; index += 1) {
        const jobs = await rpc("claim_integration_jobs", {
          p_destination: "conta_azul",
          p_batch_size: 1,
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
