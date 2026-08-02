import {
  CONTA_AZUL_AUTHORIZATION_URL,
  CONTA_AZUL_SCOPE,
  encryptTokenPair,
  exchangeContaAzulToken,
} from "../_shared/conta-azul.ts";
import { databaseRequest, requiredEnvironment } from "../_shared/database.ts";
import {
  authenticateBearerToken,
  bytesToBase64,
  sha256Hex,
} from "../_shared/webhook.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function route(request: Request): string {
  const url = new URL(request.url);
  const suffix = url.pathname.split("/conta-azul-auth")[1]?.replace(/^\/+/, "");
  return suffix || url.searchParams.get("action") || "status";
}

function oauthRedirectUri(): string {
  return Deno.env.get("CONTA_AZUL_REDIRECT_URI")?.trim()
    || `${requiredEnvironment("SUPABASE_URL")}/functions/v1/conta-azul-auth/callback`;
}

async function stateSha256(state: string): Promise<string> {
  return await sha256Hex(new TextEncoder().encode(state));
}

async function requireAdmin(request: Request): Promise<Response | null> {
  const secret = Deno.env.get("INTEGRATION_ADMIN_SECRET")?.trim()
    || requiredEnvironment("STATUS_API_SECRET");
  if (!await authenticateBearerToken(request.headers, secret)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  return null;
}

async function startAuthorization(request: Request): Promise<Response> {
  const denied = await requireAdmin(request);
  if (denied) return denied;

  const random = crypto.getRandomValues(new Uint8Array(32));
  const state = bytesToBase64(random)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  const redirectUri = oauthRedirectUri();
  const insert = await databaseRequest("/rest/v1/oauth_authorization_states", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    body: JSON.stringify({
      state_sha256: await stateSha256(state),
      provider: "conta_azul",
      redirect_uri: redirectUri,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    }),
  });
  if (!insert.ok) {
    throw new Error(`Unable to persist OAuth state (${insert.status})`);
  }

  const authorization = new URL(CONTA_AZUL_AUTHORIZATION_URL);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("client_id", requiredEnvironment("CONTA_AZUL_CLIENT_ID"));
  authorization.searchParams.set("redirect_uri", redirectUri);
  authorization.searchParams.set("state", state);
  authorization.searchParams.set("scope", CONTA_AZUL_SCOPE);

  return jsonResponse({
    authorization_url: authorization.toString(),
    expires_in_seconds: 600,
  });
}

async function consumeState(state: string): Promise<string | null> {
  const response = await databaseRequest("/rest/v1/rpc/consume_conta_azul_oauth_state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ p_state_sha256: await stateSha256(state) }),
  });
  if (!response.ok) {
    throw new Error(`Unable to consume OAuth state (${response.status})`);
  }
  return await response.json() as string | null;
}

async function saveConnection(encrypted: Awaited<ReturnType<typeof encryptTokenPair>>): Promise<void> {
  const list = await databaseRequest(
    "/rest/v1/conta_azul_connections?select=id&order=updated_at.desc&limit=1",
    { method: "GET" },
  );
  if (!list.ok) throw new Error(`Unable to inspect OAuth connection (${list.status})`);
  const current = (await list.json() as Array<{ id: string }>)[0];
  const payload = {
    status: "active",
    ...encrypted,
    refresh_lease_token: null,
    refresh_lease_until: null,
    last_error_code: null,
    last_error_message: null,
    updated_at: new Date().toISOString(),
  };
  const response = current
    ? await databaseRequest(`/rest/v1/conta_azul_connections?id=eq.${encodeURIComponent(current.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", prefer: "return=minimal" },
      body: JSON.stringify(payload),
    })
    : await databaseRequest("/rest/v1/conta_azul_connections", {
      method: "POST",
      headers: { "content-type": "application/json", prefer: "return=minimal" },
      body: JSON.stringify(payload),
    });
  if (!response.ok) {
    throw new Error(`Unable to save OAuth connection (${response.status})`);
  }
}

async function callback(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return jsonResponse({ error: "oauth_denied", description: url.searchParams.get("error_description") }, 400);
  }
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!code || !state) return jsonResponse({ error: "missing_oauth_parameters" }, 400);

  const redirectUri = await consumeState(state);
  if (!redirectUri) return jsonResponse({ error: "invalid_or_expired_state" }, 400);

  const token = await exchangeContaAzulToken(new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  }));
  await saveConnection(await encryptTokenPair(token));

  return new Response(
    "<!doctype html><html lang=\"pt-BR\"><meta charset=\"utf-8\"><title>Conta Azul conectada</title><body><h1>Conta Azul conectada com sucesso</h1><p>Esta janela pode ser fechada.</p></body></html>",
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

async function status(request: Request): Promise<Response> {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  const response = await databaseRequest(
    "/rest/v1/conta_azul_connections?select=id,status,external_account_id,access_token_expires_at,last_refreshed_at,last_verified_at,last_error_code,created_at,updated_at&order=updated_at.desc&limit=1",
    { method: "GET" },
  );
  if (!response.ok) throw new Error(`Unable to read connection status (${response.status})`);
  const rows = await response.json() as unknown[];
  return jsonResponse({ connected: rows.length === 1, connection: rows[0] ?? null });
}

Deno.serve(async (request: Request): Promise<Response> => {
  try {
    const selectedRoute = route(request);
    if (selectedRoute === "start" && request.method === "POST") return await startAuthorization(request);
    if (selectedRoute === "callback" && request.method === "GET") return await callback(request);
    if (selectedRoute === "status" && request.method === "GET") return await status(request);
    return jsonResponse({ error: "not_found" }, 404);
  } catch (error) {
    console.error("conta_azul_auth_failed", {
      message: error instanceof Error ? error.message : "unknown error",
    });
    return jsonResponse({ error: "temporarily_unavailable" }, 503);
  }
});
