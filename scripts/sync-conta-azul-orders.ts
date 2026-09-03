/**
 * Sincroniza explicitamente ordens já ingeridas com a Conta Azul, uma a uma,
 * pela operação `sync_order` do worker (mesmo caminho idempotente da fila, sem
 * ACK de fila). Recebe sequências de ingestão, uma por linha.
 *
 *   node --env-file=.env scripts/sync-conta-azul-orders.ts --sequences <arquivo>
 *
 * O worker recusa um webhook mais antigo que o último estado conhecido da
 * ordem (`newer_event_exists`), então passar a sequência do último evento pago
 * de cada ordem é seguro: uma ordem reembolsada depois não vira venda.
 */

import { readFileSync } from "node:fs";

const index = process.argv.indexOf("--sequences");
const file = index >= 0 ? process.argv[index + 1] : null;
if (!file) throw new Error("Missing --sequences");
const supabaseUrl = process.env.SUPABASE_URL ?? "";
const secret = process.env.STATUS_API_SECRET ?? "";
if (!supabaseUrl || !secret) throw new Error("SUPABASE_URL and STATUS_API_SECRET are required");

const sequences = readFileSync(file, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
const summary: Record<string, number> = {};
for (const sequence of sequences) {
  let result: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch(`${supabaseUrl}/functions/v1/conta-azul-worker`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ operation: "sync_order", ingest_sequence: Number(sequence) }),
      signal: AbortSignal.timeout(120_000),
    });
    result = await response.json().catch(() => ({ error: `http_${response.status}` })) as Record<string, unknown>;
    // O worker da fila pode estar com o lease; espera e tenta de novo.
    if (response.status === 202 && result.status === "already_running") {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      continue;
    }
    break;
  }
  const key = String(result.status ?? result.error ?? "unknown") + (result.result ? `/${result.result}` : "") +
    (result.last_action ? `/${result.last_action}` : "");
  summary[key] = (summary[key] ?? 0) + 1;
  console.log(JSON.stringify({ sequence: Number(sequence), ...result }));
}
console.error(JSON.stringify(summary, null, 2));
