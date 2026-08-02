const WEBHOOK_ENDPOINT = "https://mid.humanacademy.ai/webhook";
const DIRECT_WEBHOOK_ENDPOINT =
  "https://hyvomeibqlfchxqaevkc.supabase.co/functions/v1/zolt-webhook";
const QUEUE_STATUS_ENDPOINT =
  "https://hyvomeibqlfchxqaevkc.supabase.co/functions/v1/queue-status";
const HEALTH_TIMEOUT_MS = 5_000;

export async function checkDependencies({
  fetchImpl = fetch,
  statusSecret = process.env.STATUS_API_SECRET,
} = {}) {
  if (!statusSecret) {
    throw new Error("STATUS_API_SECRET is not configured");
  }

  const response = await fetchImpl(`${QUEUE_STATUS_ENDPOINT}?recent_limit=0`, {
    headers: {
      authorization: `Bearer ${statusSecret}`,
    },
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`queue status returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (
    typeof payload?.generated_at !== "string" ||
    !Array.isArray(payload?.queues) ||
    payload.queues.length === 0
  ) {
    throw new Error("queue status returned an invalid response");
  }

  return {
    supabase: "healthy",
    queue_state: "healthy",
    checked_at: payload.generated_at,
    destinations: payload.queues.map((queue) => ({
      name: queue.destination,
      enqueue_enabled: queue.enqueue_enabled === true,
      dispatch_enabled: queue.dispatch_enabled === true,
    })),
  };
}

export default async function handler(_request, response) {
  response.setHeader("Cache-Control", "no-store");

  try {
    const dependencies = await checkDependencies();
    response.status(200).json({
      service: "sales-middleware",
      status: "operational",
      checked_at: new Date().toISOString(),
      dependencies,
      ingress: {
        method: "POST",
        url: WEBHOOK_ENDPOINT,
        query_parameters: {
          platform: "optional",
          event: "optional",
        },
        direct_storage_url: DIRECT_WEBHOOK_ENDPOINT,
        authentication: "none at public ingress; secret injected internally",
      },
      queue_status: {
        method: "GET",
        url: QUEUE_STATUS_ENDPOINT,
        authentication: "Authorization: Bearer <STATUS_API_SECRET>",
      },
    });
  } catch {
    response.status(503).json({
      service: "sales-middleware",
      status: "degraded",
      checked_at: new Date().toISOString(),
      dependencies: {
        supabase: "unavailable",
        queue_state: "unknown",
      },
    });
  }
}
