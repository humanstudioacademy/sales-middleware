import assert from "node:assert/strict";
import test from "node:test";

import handler, { checkDependencies } from "../api/index.js";

test("health dependency check accepts a valid queue response", async () => {
  const dependencies = await checkDependencies({
    statusSecret: "test-secret",
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.authorization, "Bearer test-secret");
      return new Response(JSON.stringify({
        generated_at: "2026-08-02T13:00:00.000Z",
        queues: [{
          destination: "conta_azul",
          enqueue_enabled: true,
          dispatch_enabled: false,
        }],
      }));
    },
  });

  assert.deepEqual(dependencies, {
    supabase: "healthy",
    queue_state: "healthy",
    checked_at: "2026-08-02T13:00:00.000Z",
    destinations: [{
      name: "conta_azul",
      enqueue_enabled: true,
      dispatch_enabled: false,
    }],
  });
});

test("health dependency check rejects an invalid queue response", async () => {
  await assert.rejects(
    checkDependencies({
      statusSecret: "test-secret",
      fetchImpl: async () => new Response("{}"),
    }),
    /invalid response/,
  );
});

test("health handler returns degraded without leaking an upstream error", async () => {
  const previousSecret = process.env.STATUS_API_SECRET;
  delete process.env.STATUS_API_SECRET;

  let statusCode = 0;
  let body;
  const response = {
    setHeader() {},
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      body = value;
    },
  };

  try {
    await handler({}, response);
  } finally {
    if (previousSecret === undefined) {
      delete process.env.STATUS_API_SECRET;
    } else {
      process.env.STATUS_API_SECRET = previousSecret;
    }
  }

  assert.equal(statusCode, 503);
  assert.deepEqual(body.dependencies, {
    supabase: "unavailable",
    queue_state: "unknown",
  });
  assert.equal(JSON.stringify(body).includes("STATUS_API_SECRET"), false);
});
