import assert from "node:assert/strict";
import test from "node:test";

import { buildHumanOsReplay } from "../supabase/functions/_shared/human-os.ts";
import { bytesToBase64, type RequestEnvelope, sha256Hex } from "../supabase/functions/_shared/webhook.ts";

test("replays the exact Zouti body and routing query without forwarding credentials", async () => {
  const body = new TextEncoder().encode('{"id":"ord_1", "status":"PAID"}\n');
  const envelope: RequestEnvelope = {
    schema_version: 1,
    captured_at: "2026-08-02T10:00:00.000Z",
    method: "POST",
    url: "https://mid.humanacademy.ai/webhook?platform=zouti&event=paid",
    path: "/webhook",
    raw_query_string: "platform=zouti&event=paid",
    query_params: { platform: ["zouti"], event: ["paid"] },
    path_params: { wildcard_segments: [] },
    headers: [
      ["content-type", "application/json"],
      ["authorization", "Bearer must-not-leak"],
      ["cookie", "must-not-leak"],
      ["x-zouti-event-id", "evt_1"],
    ],
    body: {
      base64: bytesToBase64(body),
      text: new TextDecoder().decode(body),
      json: { id: "ord_1", status: "PAID" },
      is_json: true,
      size_bytes: body.byteLength,
      sha256: await sha256Hex(body),
    },
  };

  const replay = buildHumanOsReplay(
    envelope,
    "https://example.supabase.co/functions/v1/hook",
    { webhookId: "00000000-0000-4000-8000-000000000001", ingestSequence: 42, bodySha256: envelope.body.sha256 },
  );
  assert.deepEqual(replay.body, body);
  assert.equal(new URL(replay.url).search, "?platform=zouti&event=paid");
  assert.equal(replay.headers.get("authorization"), null);
  assert.equal(replay.headers.get("cookie"), null);
  assert.equal(replay.headers.get("x-zouti-event-id"), "evt_1");
  assert.equal(replay.headers.get("x-humanos-ingest-sequence"), "42");
});
