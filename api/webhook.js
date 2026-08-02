const STORAGE_ENDPOINT =
  "https://hyvomeibqlfchxqaevkc.supabase.co/functions/v1/zolt-webhook";

export const config = {
  runtime: "edge",
};

export default async function handler(request) {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: {
        "Allow": "POST",
        "Content-Type": "application/json",
      },
    });
  }

  const secret = process.env.ZOLT_WEBHOOK_SECRET;
  if (!secret) {
    return new Response(JSON.stringify({ error: "ingress_not_configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const incomingUrl = new URL(request.url);
  const storageUrl = new URL(STORAGE_ENDPOINT);
  storageUrl.search = incomingUrl.search;

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.set("authorization", `Bearer ${secret}`);
  headers.set("x-forwarded-webhook-host", incomingUrl.host);

  return fetch(storageUrl, {
    method: "POST",
    headers,
    body: request.body,
    redirect: "manual",
  });
}
