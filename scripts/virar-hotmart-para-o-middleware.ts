/**
 * Vira agosto e setembro da Hotmart para o middleware, depois que os
 * lançamentos do SquadHub forem excluídos na Conta Azul.
 *
 *   node --env-file=.env scripts/virar-hotmart-para-o-middleware.ts            # confere e mostra o plano
 *   node --env-file=.env scripts/virar-hotmart-para-o-middleware.ts --execute  # executa
 *
 * O que faz, nesta ordem:
 *
 *  1. Confere pela API da Conta Azul que não restou nenhum lançamento do
 *     SquadHub com competência a partir de 01/08. Se restar, para e diz
 *     quantos — nada é alterado.
 *  2. Remove de `conta_azul_external_postings` as transações do período, que
 *     eram o que impedia o middleware de lançar o que o SquadHub já tinha
 *     lançado.
 *  3. Recua a data de corte da Hotmart para 01/08.
 *  4. Sincroniza, em ordem de ingestão, todos os eventos de compra dessas
 *     transações. O worker decide cada uma: aprovada vira venda, reembolso e
 *     chargeback cancelam a venda, o resto fica só registrado.
 *
 * É idempotente: rodar de novo não duplica nada, porque a identidade continua
 * sendo (plataforma, transação) e a venda vinculada nunca é recriada.
 */

import { readFileSync } from "node:fs";

const CONTA_HOTMART = "494bacd8-d9d4-45ce-907f-5977188cbb56";
const CORTE = "2026-08-01 00:00:00+00";

const executar = process.argv.includes("--execute");
const supabaseUrl = process.env.SUPABASE_URL ?? "";
const statusSecret = process.env.STATUS_API_SECRET ?? "";
const dbSecret = process.env.SUPABASE_SECRET_KEY ?? "";
if (!supabaseUrl || !statusSecret || !dbSecret) {
  throw new Error("SUPABASE_URL, STATUS_API_SECRET e SUPABASE_SECRET_KEY são obrigatórios");
}

function argumento(nome: string): string | null {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function contaAzul(query: Record<string, string>): Promise<Record<string, unknown>> {
  const resposta = await fetch(`${supabaseUrl}/functions/v1/conta-azul-api?${new URLSearchParams(query)}`, {
    headers: { authorization: `Bearer ${statusSecret}` },
  });
  if (!resposta.ok) throw new Error(`Conta Azul ${query.resource} falhou (${resposta.status})`);
  return await resposta.json() as Record<string, unknown>;
}

async function banco(caminho: string, init: RequestInit = {}): Promise<unknown> {
  const resposta = await fetch(`${supabaseUrl}/rest/v1/${caminho}`, {
    ...init,
    headers: { apikey: dbSecret, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!resposta.ok) throw new Error(`Banco falhou (${resposta.status}): ${(await resposta.text()).slice(0, 300)}`);
  const texto = await resposta.text();
  return texto ? JSON.parse(texto) : null;
}

// 1. A Conta Azul ainda tem lançamento do SquadHub no período?
const receb = await contaAzul({
  resource: "receivables",
  pagina: "1",
  tamanho_pagina: "1000",
  data_vencimento_de: "2025-01-01",
  data_vencimento_ate: "2029-12-31",
  data_competencia_de: "2026-08-01",
  data_competencia_ate: "2026-09-30",
  ids_contas_financeiras: CONTA_HOTMART,
});
const itens = (receb.itens ?? []) as Array<{ descricao: string }>;
const doSquadHub = itens.filter((i) => /Venda Hotmart/i.test(i.descricao ?? ""));
console.log(JSON.stringify({
  lancamentos_na_conta_hotmart: itens.length,
  ainda_do_squadhub: doSquadHub.length,
}));
if (doSquadHub.length > 0) {
  console.error(`Ainda há ${doSquadHub.length} lançamento(s) do SquadHub em agosto/setembro. Exclua-os antes de rodar com --execute.`);
  if (executar) process.exit(1);
}

const arquivo = argumento("sequences") ?? "";
const sequencias = arquivo
  ? readFileSync(arquivo, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)
  : [];
console.log(JSON.stringify({ eventos_a_sincronizar: sequencias.length, modo: executar ? "execute" : "simulacao" }));
if (!executar) {
  console.log("Simulação: nada foi alterado. Repita com --execute quando a exclusão estiver feita.");
  process.exit(0);
}

// 2. Libera as transações do período que estavam protegidas.
const removidas = await banco(
  `conta_azul_external_postings?source_platform=eq.hotmart&posted_by=eq.squadhub&select=external_order_id`,
  { method: "DELETE", headers: { prefer: "return=representation" } },
) as Array<{ external_order_id: string }>;
console.log(JSON.stringify({ protecoes_removidas: removidas.length }));

// 3. Recua a data de corte.
await banco(`conta_azul_platform_mappings?source_platform=eq.hotmart`, {
  method: "PATCH",
  headers: { prefer: "return=minimal" },
  body: JSON.stringify({ sync_orders_created_from: CORTE, updated_at: new Date().toISOString() }),
});
console.log(JSON.stringify({ corte: CORTE }));

// 4. Sincroniza cada evento, em ordem.
const resumo: Record<string, number> = {};
let feitos = 0;
for (const sequencia of sequencias) {
  let resultado: Record<string, unknown> = {};
  for (let tentativa = 0; tentativa < 40; tentativa += 1) {
    const resposta = await fetch(`${supabaseUrl}/functions/v1/conta-azul-worker`, {
      method: "POST",
      headers: { authorization: `Bearer ${statusSecret}`, "content-type": "application/json" },
      body: JSON.stringify({ operation: "sync_order", ingest_sequence: Number(sequencia) }),
      signal: AbortSignal.timeout(180_000),
    });
    resultado = await resposta.json().catch(() => ({ error: `http_${resposta.status}` })) as Record<string, unknown>;
    if (resposta.status === 202 && resultado.status === "already_running") {
      await new Promise((r) => setTimeout(r, 3_000));
      continue;
    }
    break;
  }
  const chave = [resultado.status, resultado.result, resultado.last_action].filter(Boolean).join("/") ||
    String(resultado.error ?? "desconhecido");
  resumo[chave] = (resumo[chave] ?? 0) + 1;
  feitos += 1;
  console.log(JSON.stringify({ sequencia: Number(sequencia), ...resultado }));
  if (feitos % 25 === 0) console.error(JSON.stringify({ progresso: `${feitos}/${sequencias.length}`, resumo }));
}
console.error(JSON.stringify({ total: feitos, resumo }, null, 2));
