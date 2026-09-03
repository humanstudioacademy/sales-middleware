import { databaseRequest, requiredEnvironment } from "../_shared/database.ts";
import { buildHumanOsReplay } from "../_shared/human-os.ts";
import {
  authenticateBearerToken,
  decryptEnvelope,
  type RequestEnvelope,
} from "../_shared/webhook.ts";

type JsonObject = Record<string, unknown>;

interface ClaimedJob {
  message_id: number;
  attempt_number: number;
  webhook_id: string;
  ingest_sequence: number;
  processing_started_at: string;
  source_platform: string;
  body_sha256: string;
  encrypted_envelope_base64: string;
  encryption_iv_base64: string;
  encryption_algorithm: string;
}

class HumanOsHttpError extends Error {
  constructor(public status: number) {
    super(`HumanOS delivery failed (${status})`);
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function databaseJson(path: string, init: RequestInit): Promise<unknown> {
  const response = await databaseRequest(path, init);
  if (!response.ok) throw new Error(`Database operation failed (${response.status})`);
  if (response.status === 204) return null;
  const raw = await response.text();
  return raw ? JSON.parse(raw) : null;
}

/**
 * Plataformas cujo FIFO este worker consome. A entrega é o replay byte a byte
 * do webhook original, então o humanOS recebe o contrato de cada plataforma
 * como ele veio da origem.
 */
const SUPPORTED_PLATFORMS = ["zouti", "hotmart"];

async function rpc(name: string, body: JsonObject): Promise<unknown> {
  return await databaseJson(`/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function deliver(job: ClaimedJob): Promise<number> {
  if (!SUPPORTED_PLATFORMS.includes(job.source_platform.trim().toLowerCase())) {
    throw new Error("HumanOS worker claimed an unsupported platform");
  }
  if (job.encryption_algorithm !== "AES-256-GCM") {
    throw new Error("Unsupported webhook encryption algorithm");
  }
  const envelope: RequestEnvelope = await decryptEnvelope({
    ciphertextBase64: job.encrypted_envelope_base64,
    ivBase64: job.encryption_iv_base64,
    algorithm: "AES-256-GCM",
  }, requiredEnvironment("WEBHOOK_ENCRYPTION_KEY_BASE64"));
  const replay = buildHumanOsReplay(envelope, requiredEnvironment("HUMAN_OS_WEBHOOK_URL"), {
    webhookId: job.webhook_id,
    ingestSequence: job.ingest_sequence,
    bodySha256: job.body_sha256,
    sourcePlatform: job.source_platform,
  });
  const response = await fetch(replay.url, {
    method: "POST",
    headers: replay.headers,
    // O corpo é o envelope original em bytes; o tipo de `fetch` no Deno atual
    // não aceita `Uint8Array` genérico, mas o runtime envia sem alteração.
    body: replay.body as unknown as BodyInit,
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  await response.arrayBuffer().catch(() => undefined);
  if (!response.ok) throw new HumanOsHttpError(response.status);
  return response.status;
}

async function complete(job: ClaimedJob, status: number): Promise<void> {
  await rpc("complete_integration_job", {
    p_destination: "human_os",
    p_message_id: job.message_id,
    p_webhook_id: job.webhook_id,
    p_attempt_number: job.attempt_number,
    p_started_at: job.processing_started_at,
    p_http_status: status,
  });
}

async function fail(job: ClaimedJob, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : "unknown error";
  await rpc("fail_integration_job", {
    p_destination: "human_os",
    p_message_id: job.message_id,
    p_webhook_id: job.webhook_id,
    p_attempt_number: job.attempt_number,
    p_started_at: job.processing_started_at,
    p_http_status: error instanceof HumanOsHttpError ? error.status : null,
    p_error_code: "delivery_failed",
    p_error_message: message,
  });
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
      p_destination: "human_os",
      p_lease_token: leaseToken,
      p_lease_seconds: 180,
    });
    if (acquired !== true) return json({ status: "already_running" }, 202);

    try {
      const result = { claimed: 0, delivered: 0, failed: 0 };
      // Uma plataforma que falha bloqueia só o próprio FIFO; as demais seguem.
      const platforms = new Set<string>(SUPPORTED_PLATFORMS);
      const startedAt = Date.now();

      while (result.claimed < batchSize && platforms.size > 0 && Date.now() - startedAt < 100_000) {
        let progressed = false;
        for (const platform of [...platforms]) {
          if (result.claimed >= batchSize || Date.now() - startedAt >= 100_000) break;
          const jobs = await rpc("claim_integration_jobs", {
            p_destination: "human_os",
            p_batch_size: 1,
            p_source_platform: platform,
          }) as ClaimedJob[];
          const job = jobs[0];
          if (!job) {
            platforms.delete(platform);
            continue;
          }
          progressed = true;
          result.claimed += 1;
          try {
            await complete(job, await deliver(job));
            result.delivered += 1;
          } catch (error) {
            await fail(job, error);
            result.failed += 1;
            platforms.delete(platform);
          }
        }
        if (!progressed) break;
      }
      return json(result);
    } finally {
      await rpc("release_integration_worker_lease", {
        p_destination: "human_os",
        p_lease_token: leaseToken,
      }).catch(() => undefined);
    }
  } catch (error) {
    console.error("human_os_worker_failed", { message: error instanceof Error ? error.message : "unknown error" });
    return json({ error: "temporarily_unavailable" }, 503);
  }
});
