const SUPABASE_FUNCTIONS = "https://hyvomeibqlfchxqaevkc.supabase.co/functions/v1";

export const config = { runtime: "edge" };

async function runWorker(name, batchSize, secret) {
  const response = await fetch(`${SUPABASE_FUNCTIONS}/${name}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ batch_size: batchSize }),
    signal: AbortSignal.timeout(50_000),
  });
  const result = await response.json().catch(() => ({ error: "invalid_worker_response" }));
  if (!response.ok || Number(result?.failed ?? 0) > 0) {
    throw new Error(`${name} did not complete its batch`);
  }
  return result;
}

export default async function handler(request) {
  if (request.method !== "GET") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "GET" } });
  }
  const cronSecret = process.env.CRON_SECRET;
  const statusSecret = process.env.STATUS_API_SECRET;
  if (!cronSecret || !statusSecret || request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const [contaAzul, humanOs] = await Promise.all([
      runWorker("conta-azul-worker", 20, statusSecret),
      runWorker("human-os-worker", 20, statusSecret),
    ]);
    return Response.json({ status: "ok", conta_azul: contaAzul, human_os: humanOs }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    console.error("integration_cron_failed", { message: error instanceof Error ? error.message : "unknown error" });
    return Response.json({ status: "degraded" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
