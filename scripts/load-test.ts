import { performance } from "node:perf_hooks";

const endpoint = process.env.LOAD_TEST_URL ??
  "http://127.0.0.1:54321/functions/v1/zolt-webhook";
const secret = process.env.ZOLT_WEBHOOK_SECRET;
const eventsPerSecond = Number(process.env.EVENTS_PER_SECOND ?? "200");
const durationSeconds = Number(process.env.DURATION_SECONDS ?? "5");
const batchesPerSecond = 20;

if (!secret) {
  throw new Error("ZOLT_WEBHOOK_SECRET is required");
}
if (!Number.isSafeInteger(eventsPerSecond) || eventsPerSecond < 1 || eventsPerSecond > 5_000) {
  throw new Error("EVENTS_PER_SECOND must be an integer between 1 and 5000");
}
if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 600) {
  throw new Error("DURATION_SECONDS must be an integer between 1 and 600");
}

const totalEvents = eventsPerSecond * durationSeconds;
const latencies: number[] = [];
const failures: Array<{ status: number; body: string }> = [];
let sent = 0;
const startedAt = performance.now();

async function sendEvent(sequence: number): Promise<void> {
  const requestStartedAt = performance.now();
  const eventId = `load-${Date.now()}-${sequence}-${crypto.randomUUID()}`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        "x-zolt-event-id": eventId,
      },
      body: JSON.stringify({
        id: eventId,
        type: "load-test.event",
        sequence,
        occurred_at: new Date().toISOString(),
      }),
    });
    const body = await response.text();
    if (response.status !== 200) {
      failures.push({ status: response.status, body: body.slice(0, 200) });
    }
  } catch (error) {
    failures.push({ status: 0, body: error instanceof Error ? error.message : "network error" });
  } finally {
    latencies.push(performance.now() - requestStartedAt);
  }
}

for (let batch = 0; sent < totalEvents; batch += 1) {
  const targetSent = Math.min(
    totalEvents,
    Math.round(((batch + 1) * eventsPerSecond) / batchesPerSecond),
  );
  const requests: Promise<void>[] = [];

  while (sent < targetSent) {
    requests.push(sendEvent(sent));
    sent += 1;
  }

  await Promise.all(requests);
  const targetElapsed = ((batch + 1) * 1_000) / batchesPerSecond;
  const waitMilliseconds = targetElapsed - (performance.now() - startedAt);
  if (waitMilliseconds > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMilliseconds));
  }
}

latencies.sort((left, right) => left - right);
const percentile = (value: number): number => {
  const index = Math.min(latencies.length - 1, Math.ceil(latencies.length * value) - 1);
  return Number(latencies[index].toFixed(1));
};
const elapsedSeconds = (performance.now() - startedAt) / 1_000;

console.log(JSON.stringify({
  requested_events_per_second: eventsPerSecond,
  duration_seconds: durationSeconds,
  sent,
  succeeded: sent - failures.length,
  failed: failures.length,
  achieved_events_per_second: Number((sent / elapsedSeconds).toFixed(1)),
  latency_ms: {
    p50: percentile(0.50),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: Number(latencies.at(-1)?.toFixed(1) ?? 0),
  },
}, null, 2));

if (failures.length > 0) {
  console.error(JSON.stringify({ sample_failures: failures.slice(0, 5) }, null, 2));
  process.exitCode = 1;
}

