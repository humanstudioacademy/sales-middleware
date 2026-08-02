import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticateBearerToken,
  authenticateWebhook,
  bytesToBase64,
  captureRequest,
  decryptEnvelope,
  encryptEnvelope,
  sanitizeHeaders,
  sanitizeQueryParams,
} from "../supabase/functions/_shared/webhook.ts";

const SECRET = "a-secret-with-at-least-thirty-two-random-bytes";
const ENCRYPTION_KEY = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));

test("accepts the supported secret headers and rejects an invalid secret", async () => {
  for (const headers of [
    new Headers({ authorization: `Bearer ${SECRET}` }),
    new Headers({ "x-zolt-webhook-secret": SECRET }),
    new Headers({ "x-webhook-secret": SECRET }),
  ]) {
    assert.equal((await authenticateWebhook(headers, SECRET)).authenticated, true);
  }

  assert.deepEqual(await authenticateWebhook(new Headers({ authorization: "Bearer wrong" }), SECRET), {
    authenticated: false,
    scheme: "none",
  });
});

test("status authentication only accepts the bearer token", async () => {
  assert.equal(
    await authenticateBearerToken(new Headers({ authorization: `Bearer ${SECRET}` }), SECRET),
    true,
  );
  assert.equal(
    await authenticateBearerToken(new Headers({ "x-webhook-secret": SECRET }), SECRET),
    false,
  );
});

test("captures query repetitions, wildcard path, headers, and the exact body", async () => {
  const rawBody = "{\"value\":9007199254740993,\"name\":\"João\"}";
  const request = new Request(
    "https://example.supabase.co/functions/v1/zolt-webhook/orders/42?tag=a&tag=b&token=sensitive",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zolt-event-id": "event-123",
      },
      body: rawBody,
    },
  );

  const envelope = await captureRequest(request, "2026-08-02T00:00:00.000Z", "zolt-webhook");

  assert.equal(envelope.body.text, rawBody);
  assert.equal(envelope.body.base64, bytesToBase64(new TextEncoder().encode(rawBody)));
  assert.equal(envelope.body.is_json, true);
  assert.deepEqual(envelope.query_params.tag, ["a", "b"]);
  assert.deepEqual(envelope.path_params.wildcard_segments, ["orders", "42"]);
  assert.equal(envelope.headers.some(([name]) => name === "x-zolt-event-id"), true);
});

test("encrypts and decrypts the complete envelope without information loss", async () => {
  const request = new Request("https://example.com/functions/v1/zolt-webhook?signature=abc", {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}` },
    body: "payload not json \u0000 with exact bytes",
  });
  const envelope = await captureRequest(request, "2026-08-02T00:00:00.000Z", "zolt-webhook");
  const encrypted = await encryptEnvelope(envelope, ENCRYPTION_KEY);
  const decrypted = await decryptEnvelope(encrypted, ENCRYPTION_KEY);

  assert.deepEqual(decrypted, envelope);
  assert.notEqual(encrypted.ciphertextBase64.includes(SECRET), true);
});

test("redacts reusable credentials from query and observable headers", () => {
  assert.deepEqual(
    sanitizeHeaders([
      ["authorization", `Bearer ${SECRET}`],
      ["content-type", "application/json"],
    ]),
    { authorization: "[REDACTED]", "content-type": "application/json" },
  );
  assert.deepEqual(sanitizeQueryParams({ token: ["secret"], page: ["1"] }), {
    token: ["[REDACTED]"],
    page: ["1"],
  });
});
