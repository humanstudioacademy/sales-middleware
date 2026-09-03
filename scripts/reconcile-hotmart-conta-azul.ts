/**
 * Concilia as transações Hotmart do middleware com os lançamentos que já
 * existem na Conta Azul (criados pelo SquadHub como "Lançamento Financeiro"
 * parcelado, com o código HP… em `evento.codigo_referencia`).
 *
 * Lê a Conta Azul pelo proxy de leitura `conta-azul-api` (somente GET) e o
 * nosso lado por um CSV exportado do banco. Produz:
 *
 *   - <out>/conta-azul-hotmart-lancamentos.json  — todos os eventos por HP
 *   - <out>/reconciliacao-hotmart.csv            — uma linha por transação nossa
 *   - <out>/external-postings.json               — o que gravar em
 *                                                  conta_azul_external_postings
 *
 *   node scripts/reconcile-hotmart-conta-azul.ts \
 *     --ours <csv exportado> --out <dir> --since 2026-07-01
 *
 * Nada é gravado na Conta Azul nem no banco por aqui.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOTMART_ACCOUNT = "494bacd8-d9d4-45ce-907f-5977188cbb56";

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing --${name}`);
}

const supabaseUrl = process.env.SUPABASE_URL ?? "";
const secret = process.env.STATUS_API_SECRET ?? "";
if (!supabaseUrl || !secret) throw new Error("SUPABASE_URL and STATUS_API_SECRET are required");

const oursPath = arg("ours");
const outDir = arg("out");
const since = arg("since", "2026-07-01");
mkdirSync(outDir, { recursive: true });

let lastCall = 0;
async function contaAzul(query: Record<string, string>): Promise<unknown> {
  const wait = Math.max(0, 130 - (Date.now() - lastCall));
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCall = Date.now();
  const url = `${supabaseUrl}/functions/v1/conta-azul-api?${new URLSearchParams(query)}`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, { headers: { authorization: `Bearer ${secret}` } });
    if (response.status === 429 || response.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
      continue;
    }
    if (!response.ok) throw new Error(`Conta Azul ${query.resource} failed (${response.status}): ${await response.text()}`);
    return await response.json();
  }
  throw new Error(`Conta Azul ${query.resource} kept failing`);
}

interface Installment {
  id: string;
  descricao: string;
  total: number;
  data_criacao: string;
  data_competencia: string;
  status_traduzido: string;
  cliente: { id: string; nome: string } | null;
}

async function listReceivables(): Promise<Installment[]> {
  const items: Installment[] = [];
  for (let page = 1;; page += 1) {
    const result = await contaAzul({
      resource: "receivables",
      pagina: String(page),
      tamanho_pagina: "1000",
      data_vencimento_de: "2026-01-01",
      data_vencimento_ate: "2029-12-31",
      data_competencia_de: since,
      data_competencia_ate: "2029-12-31",
      ids_contas_financeiras: HOTMART_ACCOUNT,
    }) as { itens_totais: number; itens: Installment[] };
    items.push(...result.itens);
    process.stderr.write(`receivables page ${page}: ${items.length}/${result.itens_totais}\n`);
    if (items.length >= result.itens_totais || result.itens.length === 0) break;
  }
  return items;
}

interface EventSummary {
  eventId: string;
  reference: string | null;
  origin: string | null;
  customer: string | null;
  customerId: string | null;
  description: string;
  competence: string | null;
  createdAt: string;
  installments: number;
  total: number;
  firstInstallmentId: string;
}

async function describeEvent(installment: Installment): Promise<EventSummary | null> {
  const detail = await contaAzul({ resource: "installment", id: installment.id }) as Record<string, unknown>;
  const event = (detail.evento ?? {}) as Record<string, unknown>;
  const eventId = typeof event.id === "string" ? event.id : null;
  if (!eventId) return null;
  const parts = await contaAzul({ resource: "event_installments", id: eventId }) as unknown;
  const list = Array.isArray(parts) ? parts : Array.isArray((parts as { itens?: unknown[] })?.itens) ? (parts as { itens: unknown[] }).itens : [];
  const total = list.reduce((sum: number, item) => sum + Number((item as { valor?: unknown }).valor ?? 0), 0);
  return {
    eventId,
    reference: typeof event.codigo_referencia === "string" ? event.codigo_referencia.trim() : null,
    origin: typeof event.origem === "string" ? event.origem : null,
    customer: installment.cliente?.nome ?? null,
    customerId: installment.cliente?.id ?? null,
    description: installment.descricao,
    competence: typeof event.data_competencia === "string" ? event.data_competencia : installment.data_competencia,
    createdAt: installment.data_criacao,
    installments: list.length || 1,
    total: Math.round((total || installment.total) * 100) / 100,
    firstInstallmentId: installment.id,
  };
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split("\n");
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells: string[] = [];
    let current = "";
    let quoted = false;
    for (const char of line) {
      if (char === '"') quoted = !quoted;
      else if (char === "," && !quoted) {
        cells.push(current);
        current = "";
      } else current += char;
    }
    cells.push(current);
    return Object.fromEntries(header.map((key, index) => [key, cells[index] ?? ""]));
  });
}

const receivables = await listReceivables();
// Um evento tem várias parcelas; basta detalhar a primeira de cada um.
const firsts = receivables.filter((item) => !/\((\d+)\/\d+\)\s*$/.test(item.descricao) || /\(1\/\d+\)\s*$/.test(item.descricao));
process.stderr.write(`first installments to describe: ${firsts.length}\n`);

const events = new Map<string, EventSummary>();
let done = 0;
for (const installment of firsts) {
  const summary = await describeEvent(installment);
  done += 1;
  if (done % 25 === 0) process.stderr.write(`described ${done}/${firsts.length}\n`);
  if (summary && !events.has(summary.eventId)) events.set(summary.eventId, summary);
}

const byReference = new Map<string, EventSummary[]>();
for (const event of events.values()) {
  if (!event.reference) continue;
  const key = event.reference.toUpperCase();
  byReference.set(key, [...(byReference.get(key) ?? []), event]);
}
writeFileSync(join(outDir, "conta-azul-hotmart-lancamentos.json"), JSON.stringify([...events.values()], null, 2));

const ours = parseCsv(readFileSync(oursPath, "utf8"));
const rows: string[] = ["transaction,approved_at,buyer,product,price_ours,status_ours,situation,postings,total_conta_azul,event_ids,duplicate_event_ids"];
const postings: Array<Record<string, unknown>> = [];
let missing = 0, single = 0, duplicated = 0;
for (const order of ours) {
  const found = (byReference.get(order.transaction.toUpperCase()) ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const situation = found.length === 0 ? "faltando" : found.length === 1 ? "lancado" : "duplicado";
  if (situation === "faltando") missing += 1;
  else if (situation === "lancado") single += 1;
  else duplicated += 1;
  const keep = found[0];
  const duplicates = found.slice(1).map((event) => event.eventId);
  rows.push([
    order.transaction,
    order.approved_at,
    JSON.stringify(order.buyer),
    JSON.stringify(order.product),
    order.price,
    order.last_status,
    situation,
    String(found.length),
    keep ? String(keep.total) : "",
    found.map((event) => event.eventId).join(" "),
    duplicates.join(" "),
  ].join(","));
  if (keep) {
    postings.push({
      source_platform: "hotmart",
      external_order_id: order.transaction,
      posted_by: "squadhub",
      conta_azul_event_id: keep.eventId,
      conta_azul_reference: keep.reference,
      amount: keep.total,
      competence_date: keep.competence,
      duplicate_event_ids: duplicates,
      note: `${keep.description} | ${keep.installments} parcela(s) | cliente ${keep.customer ?? "?"}`,
    });
  }
}
writeFileSync(join(outDir, "reconciliacao-hotmart.csv"), rows.join("\n") + "\n");
writeFileSync(join(outDir, "external-postings.json"), JSON.stringify(postings, null, 2));

// Lançamentos do SquadHub sem transação nossa correspondente (compras anteriores
// à inbox, ou referência que não bate) ficam listados para o financeiro.
const oursSet = new Set(ours.map((order) => order.transaction.toUpperCase()));
const orphans = [...byReference.entries()].filter(([reference]) => !oursSet.has(reference));
writeFileSync(
  join(outDir, "conta-azul-sem-transacao-nossa.csv"),
  ["reference,events,customer,competence,total,created_at", ...orphans.map(([reference, list]) =>
    [reference, list.length, JSON.stringify(list[0].customer ?? ""), list[0].competence ?? "", list[0].total, list[0].createdAt].join(",")
  )].join("\n") + "\n",
);

console.log(JSON.stringify({
  receivables: receivables.length,
  events: events.size,
  references: byReference.size,
  ours: ours.length,
  lancado: single,
  duplicado: duplicated,
  faltando: missing,
  squadhub_sem_transacao_nossa: orphans.length,
  duplicated_references_in_conta_azul: [...byReference.values()].filter((list) => list.length > 1).length,
}, null, 2));
