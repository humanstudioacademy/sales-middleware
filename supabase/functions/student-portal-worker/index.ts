import { databaseRequest, requiredEnvironment } from "../_shared/database.ts";
import {
  buildMatriculaRequest,
  desiredEnrollmentAction,
  type EnrollmentAccessState,
  resolveEnrollmentOffer,
  type ResolvedOffer,
  type StudentPortalOffer,
} from "../_shared/student-portal.ts";
import {
  classifyInboundCommerceEvent,
  classifyOrderTransition,
  type CommerceOrder,
  parseZoutiOrder,
} from "../_shared/zouti-order.ts";
import { authenticateBearerToken } from "../_shared/webhook.ts";

type JsonObject = Record<string, unknown>;

interface ClaimedJob {
  message_id: number;
  attempt_number: number;
  webhook_id: string;
  ingest_sequence: number;
  processing_started_at: string;
  source_platform: string;
  body_sha256: string;
  body_json: unknown;
}

interface EnrollmentRow {
  id: string;
  source_platform: string;
  external_order_id: string;
  edition_code: string;
  access_state: EnrollmentAccessState;
  normalized_status: string;
  last_ingest_sequence: number;
  last_source_updated_at: string | null;
  payload_fingerprint: string;
  last_action: string;
}

class StudentPortalHttpError extends Error {
  constructor(public status: number) {
    super(`Student portal delivery failed (${status})`);
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function databaseJson(path: string, init: RequestInit): Promise<unknown> {
  const response = await databaseRequest(path, init);
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    const detail = raw
      .replace(/[\w.+-]+@[\w.-]+/g, "[email]")
      .replace(/\b\d{6,}\b/g, "[number]")
      .slice(0, 500);
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

async function alreadyProcessed(webhookId: string): Promise<boolean> {
  const encoded = encodeURIComponent(webhookId);
  const [events, skipped] = await Promise.all([
    databaseJson(
      `/rest/v1/student_portal_enrollment_events?select=webhook_id&webhook_id=eq.${encoded}&limit=1`,
      { method: "GET" },
    ) as Promise<Array<{ webhook_id: string }>>,
    databaseJson(
      `/rest/v1/student_portal_skipped_events?select=webhook_id&webhook_id=eq.${encoded}&limit=1`,
      { method: "GET" },
    ) as Promise<Array<{ webhook_id: string }>>,
  ]);
  return Boolean(events[0] || skipped[0]);
}

async function listOffers(platform: string): Promise<StudentPortalOffer[]> {
  return await databaseJson(
    `/rest/v1/student_portal_offers?select=*&source_platform=eq.${encodeURIComponent(platform)}&enabled=is.true`,
    { method: "GET" },
  ) as StudentPortalOffer[];
}

async function skipEvent(job: ClaimedJob, event: {
  entityKind: string;
  externalEntityId: string | null;
  relatedOrderId: string | null;
  sourceStatus: string | null;
  reason: string;
}): Promise<void> {
  await databaseJson("/rest/v1/student_portal_skipped_events?on_conflict=webhook_id", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      prefer: "resolution=ignore-duplicates,return=minimal",
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
  });
}

async function getEnrollment(
  platform: string,
  externalOrderId: string,
  editionCode: string,
): Promise<EnrollmentRow | null> {
  const rows = await databaseJson(
    `/rest/v1/student_portal_enrollments?select=*&source_platform=eq.${encodeURIComponent(platform)}` +
      `&external_order_id=eq.${encodeURIComponent(externalOrderId)}` +
      `&edition_code=eq.${encodeURIComponent(editionCode)}&limit=1`,
    { method: "GET" },
  ) as EnrollmentRow[];
  return rows[0] ?? null;
}

async function insertEnrollment(
  job: ClaimedJob,
  order: CommerceOrder,
  offer: ResolvedOffer,
): Promise<EnrollmentRow> {
  const rows = await databaseJson("/rest/v1/student_portal_enrollments?select=*", {
    method: "POST",
    headers: { "content-type": "application/json", prefer: "return=representation" },
    body: JSON.stringify({
      source_platform: order.sourcePlatform,
      external_order_id: order.externalOrderId,
      edition_code: offer.editionCode,
      source_product_id: offer.item.sourceId,
      source_customer_id: order.customer.sourceId,
      student_name: order.customer.name,
      student_email: order.customer.email,
      student_phone: order.customer.phone,
      access_state: "pending",
      current_source_status: order.sourceStatus,
      normalized_status: order.normalizedStatus,
      last_webhook_id: job.webhook_id,
      last_ingest_sequence: job.ingest_sequence,
      last_source_updated_at: order.sourceUpdatedAt,
      payload_fingerprint: job.body_sha256,
      last_action: "received",
    }),
  }) as EnrollmentRow[];
  if (!rows[0]) throw new Error("Database did not return the inserted enrollment");
  return rows[0];
}

async function patchEnrollment(id: string, fields: JsonObject): Promise<EnrollmentRow> {
  const rows = await databaseJson(
    `/rest/v1/student_portal_enrollments?id=eq.${encodeURIComponent(id)}&select=*`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json", prefer: "return=representation" },
      body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
    },
  ) as EnrollmentRow[];
  if (!rows[0]) throw new Error("Database did not return the updated enrollment");
  return rows[0];
}

async function recordEnrollmentEvent(
  job: ClaimedJob,
  enrollment: EnrollmentRow,
  order: CommerceOrder,
  action: string,
  httpStatus: number | null,
): Promise<void> {
  await databaseJson("/rest/v1/student_portal_enrollment_events?on_conflict=webhook_id", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      prefer: "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify({
      webhook_id: job.webhook_id,
      enrollment_id: enrollment.id,
      ingest_sequence: job.ingest_sequence,
      source_status: order.sourceStatus,
      normalized_status: order.normalizedStatus,
      payload_fingerprint: job.body_sha256,
      action,
      portal_http_status: httpStatus,
    }),
  });
}

async function deliver(
  job: ClaimedJob,
  order: CommerceOrder,
  offer: ResolvedOffer,
): Promise<number> {
  const request = buildMatriculaRequest({
    editionCode: offer.editionCode,
    order,
    item: offer.item,
    destinationUrl: requiredEnvironment("STUDENT_PORTAL_WEBHOOK_URL"),
    token: requiredEnvironment("STUDENT_PORTAL_MATRICULA_TOKEN"),
    trace: {
      webhookId: job.webhook_id,
      ingestSequence: job.ingest_sequence,
      bodySha256: job.body_sha256,
    },
  });
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  await response.arrayBuffer().catch(() => undefined);
  if (!response.ok) throw new StudentPortalHttpError(response.status);
  return response.status;
}

async function complete(job: ClaimedJob, status: number | null): Promise<void> {
  await rpc("complete_integration_job", {
    p_destination: "student_portal",
    p_message_id: job.message_id,
    p_webhook_id: job.webhook_id,
    p_attempt_number: job.attempt_number,
    p_started_at: job.processing_started_at,
    p_http_status: status,
  });
}

async function fail(job: ClaimedJob, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : "unknown error";
  const mappingError = /mapping|Webhook body|requires at least one item/i.test(message);
  await rpc("fail_integration_job", {
    p_destination: "student_portal",
    p_message_id: job.message_id,
    p_webhook_id: job.webhook_id,
    p_attempt_number: job.attempt_number,
    p_started_at: job.processing_started_at,
    p_http_status: error instanceof StudentPortalHttpError ? error.status : null,
    p_error_code: mappingError ? "mapping_incomplete" : "delivery_failed",
    p_error_message: message,
  });
}

async function processJob(
  job: ClaimedJob,
): Promise<"granted" | "revoke_pending" | "recorded" | "skipped"> {
  // Um ACK perdido depois da entrega reentrega o mesmo item. O registro
  // append-only do webhook encerra o item sem chamar o portal outra vez.
  if (await alreadyProcessed(job.webhook_id)) {
    await complete(job, 200);
    return "recorded";
  }

  const inbound = classifyInboundCommerceEvent(job.body_json, job.source_platform);
  if (inbound.disposition === "defer") {
    await skipEvent(job, inbound);
    await complete(job, 200);
    return "skipped";
  }

  const order = parseZoutiOrder(job.body_json, job.source_platform);
  const offer = resolveEnrollmentOffer(order, await listOffers(order.sourcePlatform));
  if (!offer) {
    await skipEvent(job, {
      entityKind: "order",
      externalEntityId: order.externalOrderId,
      relatedOrderId: order.externalOrderId,
      sourceStatus: order.sourceStatus,
      reason: "no_student_portal_offer_mapped",
    });
    await complete(job, 200);
    return "skipped";
  }

  let enrollment = await getEnrollment(order.sourcePlatform, order.externalOrderId, offer.editionCode);
  if (!enrollment) enrollment = await insertEnrollment(job, order, offer);

  const transition = classifyOrderTransition({
    lastIngestSequence: enrollment.last_ingest_sequence,
    lastSourceUpdatedAt: enrollment.last_source_updated_at,
    payloadFingerprint: enrollment.payload_fingerprint,
    normalizedStatus: enrollment.normalized_status as CommerceOrder["normalizedStatus"],
    lastAction: enrollment.last_action,
  }, order, job.ingest_sequence, job.body_sha256);
  if (transition !== "apply") {
    await recordEnrollmentEvent(job, enrollment, order, transition, 200);
    await complete(job, 200);
    return "recorded";
  }

  // O endpoint `/matricula` do portal só cria matrícula. Enquanto não existir
  // um endpoint de revogação, uma reversão terminal fica registrada como
  // `revoke_pending` e o acesso continua marcado como concedido: dizer que
  // revogamos sem ter revogado seria mentir na auditoria.
  const action = desiredEnrollmentAction(order.normalizedStatus, enrollment.access_state);
  const httpStatus = action === "grant" ? await deliver(job, order, offer) : null;
  const recordedAction = action === "grant"
    ? "grant"
    : action === "revoke"
    ? "revoke_pending"
    : `recorded_${order.normalizedStatus}`;
  const now = new Date().toISOString();
  const updated = await patchEnrollment(enrollment.id, {
    source_customer_id: order.customer.sourceId,
    student_name: order.customer.name,
    student_email: order.customer.email,
    student_phone: order.customer.phone,
    current_source_status: order.sourceStatus,
    normalized_status: order.normalizedStatus,
    last_webhook_id: job.webhook_id,
    last_ingest_sequence: job.ingest_sequence,
    last_source_updated_at: order.sourceUpdatedAt,
    payload_fingerprint: job.body_sha256,
    last_action: recordedAction,
    last_http_status: httpStatus,
    last_synced_at: now,
    ...(action === "grant" ? { access_state: "granted", granted_at: now } : {}),
  });

  await recordEnrollmentEvent(job, updated, order, recordedAction, httpStatus);
  await complete(job, httpStatus ?? 200);
  return action === "grant" ? "granted" : action === "revoke" ? "revoke_pending" : "recorded";
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const cronSecret = Deno.env.get("CRON_SECRET")?.trim()
      || Deno.env.get("INTEGRATION_ADMIN_SECRET")?.trim()
      || requiredEnvironment("STATUS_API_SECRET");
    if (!await authenticateBearerToken(request.headers, cronSecret)) return json({ error: "unauthorized" }, 401);

    const input = await request.json().catch(() => ({})) as { batch_size?: unknown };
    const requested = Number(input.batch_size ?? 100);
    const batchSize = Number.isSafeInteger(requested) ? Math.min(Math.max(requested, 1), 300) : 100;
    const leaseToken = crypto.randomUUID();
    const acquired = await rpc("acquire_integration_worker_lease", {
      p_destination: "student_portal",
      p_lease_token: leaseToken,
      p_lease_seconds: 180,
    });
    if (acquired !== true) return json({ status: "already_running" }, 202);

    try {
      const result = { claimed: 0, granted: 0, revoke_pending: 0, recorded: 0, skipped: 0, failed: 0 };
      for (let index = 0; index < batchSize; index += 1) {
        const jobs = await rpc("claim_integration_jobs", {
          p_destination: "student_portal",
          p_batch_size: 1,
          p_source_platform: "zouti",
        }) as ClaimedJob[];
        const job = jobs[0];
        if (!job) break;
        result.claimed += 1;
        try {
          result[await processJob(job)] += 1;
        } catch (error) {
          await fail(job, error);
          result.failed += 1;
          break;
        }
      }
      return json(result);
    } finally {
      await rpc("release_integration_worker_lease", {
        p_destination: "student_portal",
        p_lease_token: leaseToken,
      }).catch(() => undefined);
    }
  } catch (error) {
    console.error("student_portal_worker_failed", {
      message: error instanceof Error ? error.message : "unknown error",
    });
    return json({ error: "temporarily_unavailable" }, 503);
  }
});
