import { databaseRequest, requiredEnvironment } from "../_shared/database.ts";
import { authenticateBearerToken } from "../_shared/webhook.ts";

function jsonResponse(body: unknown, status: number, extraHeaders: HeadersInit = {}): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      ...Object.fromEntries(new Headers(extraHeaders).entries()),
    },
  });
}

Deno.serve(async (request: Request): Promise<Response> => {
  const requestId = crypto.randomUUID();

  if (request.method !== "GET") {
    return jsonResponse(
      { error: "method_not_allowed", request_id: requestId },
      405,
      { allow: "GET" },
    );
  }

  try {
    const statusSecret = requiredEnvironment("STATUS_API_SECRET");
    if (!await authenticateBearerToken(request.headers, statusSecret)) {
      return jsonResponse(
        { error: "unauthorized", request_id: requestId },
        401,
        { "www-authenticate": "Bearer" },
      );
    }

    const url = new URL(request.url);
    const requestedLimit = Number(url.searchParams.get("recent_limit") ?? "20");
    const recentLimit = Number.isSafeInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 0), 100)
      : 20;
    const response = await databaseRequest("/rest/v1/rpc/middleware_queue_status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ p_recent_limit: recentLimit }),
    });

    if (!response.ok) {
      const diagnostic = (await response.text()).slice(0, 500);
      throw new Error(`Queue status query failed (${response.status}): ${diagnostic}`);
    }

    return jsonResponse(await response.json(), 200);
  } catch (error) {
    console.error("queue_status_failed", {
      request_id: requestId,
      message: error instanceof Error ? error.message : "unknown error",
    });
    return jsonResponse(
      { error: "temporarily_unavailable", request_id: requestId },
      503,
      { "retry-after": "10" },
    );
  }
});

