import { decryptSecret, encryptSecret } from "./crypto.ts";
import { databaseRequest, requiredEnvironment } from "./database.ts";

export const CONTA_AZUL_API_BASE = "https://api-v2.contaazul.com";
export const CONTA_AZUL_AUTHORIZATION_URL = "https://auth.contaazul.com/login";
export const CONTA_AZUL_TOKEN_URL = "https://auth.contaazul.com/oauth2/token";
export const CONTA_AZUL_SCOPE = "openid profile aws.cognito.signin.user.admin";

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
}

export interface ContaAzulConnection {
  id: string;
  status: string;
  encrypted_access_token_base64: string;
  access_token_iv_base64: string;
  encrypted_refresh_token_base64: string;
  refresh_token_iv_base64: string;
  access_token_expires_at: string;
  granted_scope: string | null;
}

function tokenEncryptionKey(): string {
  return Deno.env.get("CONTA_AZUL_TOKEN_ENCRYPTION_KEY_BASE64")?.trim()
    || requiredEnvironment("WEBHOOK_ENCRYPTION_KEY_BASE64");
}

async function responseDiagnostic(response: Response): Promise<string> {
  return (await response.text()).slice(0, 1000);
}

export async function exchangeContaAzulToken(
  parameters: URLSearchParams,
): Promise<TokenResponse> {
  const clientId = requiredEnvironment("CONTA_AZUL_CLIENT_ID");
  const clientSecret = requiredEnvironment("CONTA_AZUL_CLIENT_SECRET");
  const basic = btoa(`${clientId}:${clientSecret}`);
  const response = await fetch(CONTA_AZUL_TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: parameters,
  });

  if (!response.ok) {
    throw new Error(`Conta Azul token exchange failed (${response.status}): ${await responseDiagnostic(response)}`);
  }

  const token = await response.json() as Partial<TokenResponse>;
  if (!token.access_token || !token.refresh_token || !Number.isFinite(token.expires_in)) {
    throw new Error("Conta Azul returned an incomplete token response");
  }
  return token as TokenResponse;
}

export async function encryptTokenPair(token: TokenResponse) {
  const key = tokenEncryptionKey();
  const [access, refresh] = await Promise.all([
    encryptSecret(token.access_token, key),
    encryptSecret(token.refresh_token, key),
  ]);
  return {
    encrypted_access_token_base64: access.ciphertextBase64,
    access_token_iv_base64: access.ivBase64,
    encrypted_refresh_token_base64: refresh.ciphertextBase64,
    refresh_token_iv_base64: refresh.ivBase64,
    access_token_expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    granted_scope: token.scope ?? null,
  };
}

export async function activeContaAzulConnection(): Promise<ContaAzulConnection> {
  const response = await databaseRequest(
    "/rest/v1/conta_azul_connections?select=id,status,encrypted_access_token_base64,access_token_iv_base64,encrypted_refresh_token_base64,refresh_token_iv_base64,access_token_expires_at,granted_scope&status=in.(active,refreshing)&order=updated_at.desc&limit=1",
    { method: "GET" },
  );
  if (!response.ok) {
    throw new Error(`Unable to read Conta Azul connection (${response.status})`);
  }
  const rows = await response.json() as ContaAzulConnection[];
  if (!rows[0]) {
    throw new Error("Conta Azul is not connected");
  }
  return rows[0];
}

async function rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await databaseRequest(`/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${name} failed (${response.status}): ${await responseDiagnostic(response)}`);
  }
  return await response.json();
}

async function refreshAccessToken(connection: ContaAzulConnection): Promise<string> {
  const leaseToken = crypto.randomUUID();
  const acquired = await rpc("acquire_conta_azul_refresh_lease", {
    p_connection_id: connection.id,
    p_lease_token: leaseToken,
    p_lease_seconds: 30,
  });

  if (acquired !== true) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const current = await activeContaAzulConnection();
    if (new Date(current.access_token_expires_at).getTime() <= Date.now() + 30_000) {
      throw new Error("Conta Azul token refresh is already in progress");
    }
    return await decryptSecret(
      current.encrypted_access_token_base64,
      current.access_token_iv_base64,
      tokenEncryptionKey(),
    );
  }

  try {
    const refreshToken = await decryptSecret(
      connection.encrypted_refresh_token_base64,
      connection.refresh_token_iv_base64,
      tokenEncryptionKey(),
    );
    const token = await exchangeContaAzulToken(new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }));
    const encrypted = await encryptTokenPair(token);
    const finished = await rpc("finish_conta_azul_token_refresh", {
      p_connection_id: connection.id,
      p_lease_token: leaseToken,
      p_encrypted_access_token_base64: encrypted.encrypted_access_token_base64,
      p_access_token_iv_base64: encrypted.access_token_iv_base64,
      p_encrypted_refresh_token_base64: encrypted.encrypted_refresh_token_base64,
      p_refresh_token_iv_base64: encrypted.refresh_token_iv_base64,
      p_access_token_expires_at: encrypted.access_token_expires_at,
      p_granted_scope: encrypted.granted_scope,
    });
    if (finished !== true) {
      throw new Error("Conta Azul refreshed token could not be committed atomically");
    }
    return token.access_token;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    const terminal = /invalid_grant|invalid_client|unauthorized_client/i.test(message);
    await rpc("fail_conta_azul_token_refresh", {
      p_connection_id: connection.id,
      p_lease_token: leaseToken,
      p_error_code: terminal ? "token_refresh_terminal" : "token_refresh_transient",
      p_error_message: message,
    }).catch(() => undefined);
    throw error;
  }
}

export async function contaAzulAccessToken(): Promise<string> {
  const connection = await activeContaAzulConnection();
  if (new Date(connection.access_token_expires_at).getTime() <= Date.now() + 120_000) {
    return await refreshAccessToken(connection);
  }
  return await decryptSecret(
    connection.encrypted_access_token_base64,
    connection.access_token_iv_base64,
    tokenEncryptionKey(),
  );
}

export async function contaAzulRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await contaAzulAccessToken();
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("accept", "application/json");
  return await fetch(`${CONTA_AZUL_API_BASE}${path}`, { ...init, headers });
}
