/**
 * Grava em `conta_azul_external_postings` a saída da conciliação
 * (`external-postings.json` de scripts/reconcile-hotmart-conta-azul.ts).
 * Idempotente: reaplicar atualiza a mesma linha por (plataforma, transação).
 *
 *   node --env-file=.env scripts/load-external-postings.ts --file <json>
 */

import { readFileSync } from "node:fs";

const index = process.argv.indexOf("--file");
const file = index >= 0 ? process.argv[index + 1] : null;
if (!file) throw new Error("Missing --file");
const supabaseUrl = process.env.SUPABASE_URL ?? "";
const secret = process.env.SUPABASE_SECRET_KEY ?? "";
if (!supabaseUrl || !secret) throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY are required");

const rows = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
let written = 0;
for (let offset = 0; offset < rows.length; offset += 100) {
  const batch = rows.slice(offset, offset + 100);
  const response = await fetch(
    `${supabaseUrl}/rest/v1/conta_azul_external_postings?on_conflict=source_platform,external_order_id`,
    {
      method: "POST",
      headers: {
        apikey: secret,
        "content-type": "application/json",
        prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(batch),
    },
  );
  if (!response.ok) throw new Error(`Insert failed (${response.status}): ${await response.text()}`);
  written += batch.length;
}
console.log(JSON.stringify({ written }));
