import { contaAzulRequest } from "../_shared/conta-azul.ts";
import { contaAzulReadPath } from "../_shared/conta-azul-admin.ts";
import { requiredEnvironment } from "../_shared/database.ts";
import { authenticateBearerToken } from "../_shared/webhook.ts";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

Deno.serve(async (request: Request): Promise<Response> => {
  try {
    if (!await authenticateBearerToken(
      request.headers,
      Deno.env.get("INTEGRATION_ADMIN_SECRET")?.trim()
        || requiredEnvironment("STATUS_API_SECRET"),
    )) return json({ error: "unauthorized" }, 401);

    if (request.method === "GET") {
      const input = new URL(request.url);
      const response = await contaAzulRequest(contaAzulReadPath(input));
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: { "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "no-store" },
      });
    }

    if (request.method === "POST") {
      if (Deno.env.get("CONTA_AZUL_ALLOW_TEST_WRITES") !== "true"
        || request.headers.get("x-confirm-create") !== "CONTA_AZUL_DEVELOPMENT") {
        return json({ error: "test_writes_disabled" }, 403);
      }
      const body = await request.text();
      const response = await contaAzulRequest("/v1/venda", {
        method: "POST",
        headers: { "content-type": request.headers.get("content-type") ?? "application/json" },
        body,
      });
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: { "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "no-store" },
      });
    }

    return json({ error: "method_not_allowed" }, 405);
  } catch (error) {
    console.error("conta_azul_api_failed", {
      message: error instanceof Error ? error.message : "unknown error",
    });
    return json({ error: "temporarily_unavailable" }, 503);
  }
});
