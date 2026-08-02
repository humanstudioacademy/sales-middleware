export const ENVELOPE_SCHEMA_VERSION = 1 as const;
export const INGEST_VERSION = 2 as const;

export type HeaderPair = readonly [string, string];

export interface RequestEnvelope {
  schema_version: typeof ENVELOPE_SCHEMA_VERSION;
  captured_at: string;
  method: string;
  url: string;
  path: string;
  raw_query_string: string;
  query_params: Record<string, string[]>;
  path_params: {
    wildcard_segments: string[];
  };
  headers: HeaderPair[];
  body: {
    base64: string;
    text: string;
    json: unknown | null;
    is_json: boolean;
    size_bytes: number;
    sha256: string;
  };
}

export interface EncryptedEnvelope {
  ciphertextBase64: string;
  ivBase64: string;
  algorithm: "AES-256-GCM";
}

export interface AuthenticationResult {
  authenticated: boolean;
  scheme: "authorization-bearer" | "x-zolt-webhook-secret" | "x-webhook-secret" | "none";
}

const SENSITIVE_NAME = /(?:authorization|cookie|secret|signature|token|api[-_]?key|password)/i;

export function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.trim());
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function secretMatches(candidate: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [candidateDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(candidateDigest);
  const right = new Uint8Array(expectedDigest);
  let difference = 0;

  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }

  return difference === 0;
}

export async function authenticateBearerToken(
  headers: Headers,
  expectedSecret: string,
): Promise<boolean> {
  const authorization = headers.get("authorization") ?? "";
  const candidate = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  return Boolean(candidate) && await secretMatches(candidate, expectedSecret);
}

export async function authenticateWebhook(
  headers: Headers,
  expectedSecret: string,
): Promise<AuthenticationResult> {
  const authorization = headers.get("authorization") ?? "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const candidates = [
    ["authorization-bearer", bearer],
    ["x-zolt-webhook-secret", headers.get("x-zolt-webhook-secret") ?? ""],
    ["x-webhook-secret", headers.get("x-webhook-secret") ?? ""],
  ] as const;

  for (const [scheme, candidate] of candidates) {
    if (candidate && await secretMatches(candidate, expectedSecret)) {
      return { authenticated: true, scheme };
    }
  }

  return { authenticated: false, scheme: "none" };
}

function collectQueryParams(searchParams: URLSearchParams): Record<string, string[]> {
  const result: Record<string, string[]> = {};

  for (const [key, value] of searchParams.entries()) {
    (result[key] ??= []).push(value);
  }

  return result;
}

function parseJson(text: string): { isJson: boolean; value: unknown | null } {
  if (!text.trim()) {
    return { isJson: false, value: null };
  }

  try {
    return { isJson: true, value: JSON.parse(text) };
  } catch {
    return { isJson: false, value: null };
  }
}

function extractWildcardSegments(path: string, functionName: string): string[] {
  const markers = [`/${functionName}`, "/webhook"];
  const marker = markers.find((candidate) => {
    const index = path.indexOf(candidate);
    const suffixStart = index + candidate.length;
    return index >= 0 && (suffixStart === path.length || path[suffixStart] === "/");
  });

  if (!marker) {
    return [];
  }

  const markerIndex = path.indexOf(marker);
  const suffix = path.slice(markerIndex + marker.length).replace(/^\/+/, "");
  return suffix ? suffix.split("/").map(decodeURIComponent) : [];
}

export async function captureRequest(
  request: Request,
  capturedAt: string,
  functionName: string,
): Promise<RequestEnvelope> {
  const forwardedUrl = request.headers.get("x-webhook-original-url");
  let url = new URL(request.url);
  if (forwardedUrl) {
    try {
      const parsedForwardedUrl = new URL(forwardedUrl);
      if (parsedForwardedUrl.protocol === "https:" || parsedForwardedUrl.protocol === "http:") {
        url = parsedForwardedUrl;
      }
    } catch {
      // A malformed forwarding hint is preserved in headers but never trusted as the URL.
    }
  }
  const bodyBytes = new Uint8Array(await request.arrayBuffer());
  const bodyText = new TextDecoder().decode(bodyBytes);
  const parsedBody = parseJson(bodyText);

  return {
    schema_version: ENVELOPE_SCHEMA_VERSION,
    captured_at: capturedAt,
    method: request.method,
    url: url.toString(),
    path: url.pathname,
    raw_query_string: url.search.startsWith("?") ? url.search.slice(1) : url.search,
    query_params: collectQueryParams(url.searchParams),
    path_params: {
      wildcard_segments: extractWildcardSegments(url.pathname, functionName),
    },
    headers: Array.from(request.headers.entries()),
    body: {
      base64: bytesToBase64(bodyBytes),
      text: bodyText,
      json: parsedBody.value,
      is_json: parsedBody.isJson,
      size_bytes: bodyBytes.byteLength,
      sha256: await sha256Hex(bodyBytes),
    },
  };
}

export function sanitizeHeaders(headerPairs: HeaderPair[]): Record<string, string> {
  return Object.fromEntries(
    headerPairs.map(([name, value]) => [name, SENSITIVE_NAME.test(name) ? "[REDACTED]" : value]),
  );
}

export function sanitizeQueryParams(
  queryParams: Record<string, string[]>,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(queryParams).map(([name, values]) => [
      name,
      SENSITIVE_NAME.test(name) ? values.map(() => "[REDACTED]") : values,
    ]),
  );
}

export function findSourceEventId(envelope: RequestEnvelope): string | null {
  const headers = new Headers(envelope.headers as [string, string][]);
  const headerValue = headers.get("x-zolt-event-id") ??
    headers.get("x-webhook-id") ??
    headers.get("x-event-id");

  if (headerValue) {
    return headerValue;
  }

  if (envelope.body.json && typeof envelope.body.json === "object" && !Array.isArray(envelope.body.json)) {
    const body = envelope.body.json as Record<string, unknown>;
    const bodyValue = body.event_id ?? body.eventId ?? body.id;
    if (typeof bodyValue === "string" || typeof bodyValue === "number") {
      return String(bodyValue);
    }
  }

  return null;
}

function parseEncryptionKey(keyBase64: string): Uint8Array {
  let key: Uint8Array;

  try {
    key = base64ToBytes(keyBase64);
  } catch {
    throw new Error("WEBHOOK_ENCRYPTION_KEY_BASE64 must be valid base64");
  }

  if (key.byteLength !== 32) {
    throw new Error("WEBHOOK_ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes");
  }

  return key;
}

export async function encryptEnvelope(
  envelope: RequestEnvelope,
  keyBase64: string,
): Promise<EncryptedEnvelope> {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(parseEncryptionKey(keyBase64)),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(envelope));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));

  return {
    ciphertextBase64: bytesToBase64(ciphertext),
    ivBase64: bytesToBase64(iv),
    algorithm: "AES-256-GCM",
  };
}

export async function decryptEnvelope(
  encrypted: EncryptedEnvelope,
  keyBase64: string,
): Promise<RequestEnvelope> {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(parseEncryptionKey(keyBase64)),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: Uint8Array.from(base64ToBytes(encrypted.ivBase64)) },
    key,
    Uint8Array.from(base64ToBytes(encrypted.ciphertextBase64)),
  );

  return JSON.parse(new TextDecoder().decode(plaintext)) as RequestEnvelope;
}
