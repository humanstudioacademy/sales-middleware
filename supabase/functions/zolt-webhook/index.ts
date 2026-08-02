import {
  authenticateWebhook,
  captureRequest,
  encryptEnvelope,
  findSourceEventId,
  INGEST_VERSION,
  sanitizeHeaders,
  sanitizeQueryParams,
} from "../_shared/webhook.ts";
import { databaseRequest, requiredEnvironment } from "../_shared/database.ts";

const FUNCTION_NAME = "zolt-webhook";
const SOURCE = "zolt";

interface StoredReceipt {
  id: string;
  received_at: string;
  received_at_epoch_ms: number;
  ingest_sequence: number;
  source_platform: string | null;
  source_event_type: string | null;
}

function jsonResponse(body: unknown, status: number, extraHeaders: HeadersInit = {}): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      ...Object.fromEntries(new Headers(extraHeaders).entries()),
    },
  });
}

async function storeEnvelope(row: Record<string, unknown>): Promise<StoredReceipt> {
  const response = await databaseRequest(
    "/rest/v1/webhook_inbox?select=id,received_at,received_at_epoch_ms,ingest_sequence,source_platform,source_event_type",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        prefer: "return=representation",
      },
      body: JSON.stringify(row),
    },
  );

  if (!response.ok) {
    const diagnostic = (await response.text()).slice(0, 500);
    throw new Error(`Database insert failed (${response.status}): ${diagnostic}`);
  }

  const records = await response.json() as StoredReceipt[];
  if (!records[0]?.id) {
    throw new Error("Database insert returned no receipt");
  }

  return records[0];
}

Deno.serve(async (request: Request): Promise<Response> => {
  const requestId = crypto.randomUUID();
  const forwardedReceivedAt = request.headers.get("x-webhook-ingress-received-at");
  const forwardedTimestamp = forwardedReceivedAt ? Date.parse(forwardedReceivedAt) : Number.NaN;
  const capturedAt = Number.isFinite(forwardedTimestamp)
    ? new Date(forwardedTimestamp).toISOString()
    : new Date().toISOString();

  try {
    const webhookSecret = requiredEnvironment("ZOLT_WEBHOOK_SECRET");
    const encryptionKey = requiredEnvironment("WEBHOOK_ENCRYPTION_KEY_BASE64");
    const encryptionKeyVersion = Number(Deno.env.get("WEBHOOK_ENCRYPTION_KEY_VERSION") ?? "1");

    if (!Number.isSafeInteger(encryptionKeyVersion) || encryptionKeyVersion < 1) {
      throw new Error("WEBHOOK_ENCRYPTION_KEY_VERSION must be a positive integer");
    }

    const authentication = await authenticateWebhook(request.headers, webhookSecret);
    if (!authentication.authenticated) {
      return jsonResponse(
        { accepted: false, error: "unauthorized", request_id: requestId },
        401,
        { "www-authenticate": "Bearer" },
      );
    }

    const envelope = await captureRequest(request, capturedAt, FUNCTION_NAME);
    const encrypted = await encryptEnvelope(envelope, encryptionKey);
    const headers = new Headers(envelope.headers as [string, string][]);
    const receipt = await storeEnvelope({
      source: SOURCE,
      received_at: capturedAt,
      received_at_epoch_ms: Date.parse(capturedAt),
      source_platform: envelope.query_params.platform?.[0] ?? SOURCE,
      source_event_type: envelope.query_params.event?.[0] ?? null,
      request_method: envelope.method,
      request_path: envelope.path,
      body_size_bytes: envelope.body.size_bytes,
      body_sha256: envelope.body.sha256,
      content_type: headers.get("content-type"),
      source_event_id: findSourceEventId(envelope),
      gateway_request_id: headers.get("x-request-id") ?? headers.get("sb-request-id") ?? headers.get("cf-ray"),
      edge_execution_id: Deno.env.get("SB_EXECUTION_ID") ?? null,
      auth_scheme: authentication.scheme,
      sanitized_headers: sanitizeHeaders(envelope.headers),
      sanitized_query_params: sanitizeQueryParams(envelope.query_params),
      body_is_json: envelope.body.is_json,
      body_json: envelope.body.json,
      encrypted_envelope_base64: encrypted.ciphertextBase64,
      encryption_iv_base64: encrypted.ivBase64,
      encryption_algorithm: encrypted.algorithm,
      encryption_key_version: encryptionKeyVersion,
      ingest_version: INGEST_VERSION,
    });

    return jsonResponse({
      accepted: true,
      receipt_id: receipt.id,
      received_at: receipt.received_at,
      received_at_epoch_ms: receipt.received_at_epoch_ms,
      ingest_sequence: receipt.ingest_sequence,
      platform: receipt.source_platform,
      event: receipt.source_event_type,
    }, 200);
  } catch (error) {
    // Nunca registrar headers ou body: o payload integral pertence somente ao banco.
    console.error("webhook_ingest_failed", {
      request_id: requestId,
      message: error instanceof Error ? error.message : "unknown error",
    });

    return jsonResponse(
      { accepted: false, error: "temporarily_unavailable", request_id: requestId },
      503,
      { "retry-after": "10" },
    );
  }
});
