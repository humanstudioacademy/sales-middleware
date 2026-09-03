import { base64ToBytes, type RequestEnvelope } from "./webhook.ts";

const BLOCKED_HEADER = /^(?:authorization|cookie|host|content-length|connection|transfer-encoding|forwarded|user-agent|cdn-loop|cf-|sb-|x-forwarded-|x-real-ip|x-webhook-original-|x-webhook-ingress-|x-zolt-webhook-secret|x-webhook-secret)/i;

export interface HumanOsReplay {
  url: string;
  headers: Headers;
  body: Uint8Array;
}

export function buildHumanOsReplay(
  envelope: RequestEnvelope,
  destinationUrl: string,
  trace: { webhookId: string; ingestSequence: number; bodySha256: string; sourcePlatform?: string },
): HumanOsReplay {
  // O corpo é o webhook original da plataforma, então o humanOS precisa saber
  // de qual contrato ele veio. Zouti continua sendo o padrão para não mudar o
  // que já está em produção.
  const platform = trace.sourcePlatform?.trim().toLowerCase() || "zouti";
  const target = new URL(destinationUrl);
  if (envelope.raw_query_string) {
    const original = new URLSearchParams(envelope.raw_query_string);
    for (const [name, value] of original) target.searchParams.append(name, value);
  }

  const headers = new Headers();
  for (const [name, value] of envelope.headers) {
    if (!BLOCKED_HEADER.test(name)) headers.append(name, value);
  }
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  headers.set("idempotency-key", `${platform}-${trace.webhookId}`);
  headers.set("x-humanos-source", platform);
  headers.set("x-humanos-webhook-id", trace.webhookId);
  headers.set("x-humanos-ingest-sequence", String(trace.ingestSequence));
  headers.set("x-zouti-original-body-sha256", trace.bodySha256);
  headers.set("x-zouti-original-path", envelope.path);

  return {
    url: target.toString(),
    headers,
    body: base64ToBytes(envelope.body.base64),
  };
}
