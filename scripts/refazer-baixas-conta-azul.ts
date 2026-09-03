/**
 * Refaz a baixa de vendas já lançadas na Conta Azul cuja `taxa` foi gravada
 * incompleta (só a tarifa do gateway, sem a retenção de juros da plataforma).
 *
 * Cada item chama a operação `refresh_sale` do worker com `resettle: true`:
 * a baixa existente é apagada e recriada com a composição atual, então o
 * valor recebido passa a bater com o líquido informado pela origem.
 *
 *   node --env-file=.env scripts/refazer-baixas-conta-azul.ts --sequences <arquivo>
 *
 * O arquivo tem uma sequência de ingestão por linha, do último evento pago de
 * cada ordem. Idempotente: rodar de novo apenas regrava a mesma composição.
 */

import { readFileSync } from "node:fs";

const indice = process.argv.indexOf("--sequences");
const arquivo = indice >= 0 ? process.argv[indice + 1] : null;
if (!arquivo) throw new Error("Informe --sequences com o arquivo de sequências");

const supabaseUrl = process.env.SUPABASE_URL ?? "";
const secret = process.env.STATUS_API_SECRET ?? "";
if (!supabaseUrl || !secret) throw new Error("SUPABASE_URL e STATUS_API_SECRET são obrigatórios");

const sequencias = readFileSync(arquivo, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
const resumo: Record<string, number> = {};
let feitos = 0;

for (const sequencia of sequencias) {
  let resultado: Record<string, unknown> = {};
  for (let tentativa = 0; tentativa < 40; tentativa += 1) {
    const resposta = await fetch(`${supabaseUrl}/functions/v1/conta-azul-worker`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ operation: "refresh_sale", ingest_sequence: Number(sequencia), resettle: true }),
      signal: AbortSignal.timeout(180_000),
    });
    resultado = await resposta.json().catch(() => ({ error: `http_${resposta.status}` })) as Record<string, unknown>;
    // O worker da fila pode estar com o lease global; espera e tenta de novo.
    if (resposta.status === 202 && resultado.status === "already_running") {
      await new Promise((r) => setTimeout(r, 4_000));
      continue;
    }
    break;
  }
  const chave = String(resultado.status ?? resultado.error ?? "desconhecido");
  resumo[chave] = (resumo[chave] ?? 0) + 1;
  feitos += 1;
  console.log(JSON.stringify({ sequencia: Number(sequencia), ...resultado }));
  if (feitos % 25 === 0) console.error(JSON.stringify({ progresso: `${feitos}/${sequencias.length}`, resumo }));
}

console.error(JSON.stringify({ total: feitos, resumo }, null, 2));
