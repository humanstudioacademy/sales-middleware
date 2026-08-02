export function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function databaseApiKey(): string {
  const explicitSecretKey = Deno.env.get("SUPABASE_SECRET_KEY")?.trim();
  if (explicitSecretKey) {
    return explicitSecretKey;
  }

  const secretKeysJson = Deno.env.get("SUPABASE_SECRET_KEYS")?.trim();
  if (secretKeysJson) {
    try {
      const secretKeys = JSON.parse(secretKeysJson) as Record<string, unknown>;
      if (typeof secretKeys.default === "string" && secretKeys.default) {
        return secretKeys.default;
      }
    } catch {
      throw new Error("SUPABASE_SECRET_KEYS must be a valid JSON dictionary");
    }
  }

  return requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY");
}

export async function databaseRequest(path: string, init: RequestInit): Promise<Response> {
  const supabaseUrl = requiredEnvironment("SUPABASE_URL");
  const apiKey = databaseApiKey();
  const headers = new Headers(init.headers);
  headers.set("apikey", apiKey);

  // Chaves service_role legadas sao JWTs. As novas sb_secret_ nao sao JWTs e
  // devem ser enviadas apenas no header apikey.
  if (!apiKey.startsWith("sb_secret_")) {
    headers.set("authorization", `Bearer ${apiKey}`);
  }

  return await fetch(`${supabaseUrl}${path}`, { ...init, headers });
}

