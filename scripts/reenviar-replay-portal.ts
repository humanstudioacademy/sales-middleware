/**
 * Reenvia ao portal do aluno as matrículas que saíram com `temReplay: false`
 * por causa da oferta sem `grants_replay` (coluna criada em
 * 20260827230000 e aplicada só em 03/09/2026).
 *
 * O endpoint `POST /functions/v1/matricula` é idempotente e não dispara
 * e-mail: reenviar um aluno que já existe apenas atualiza o acesso e responde
 * `novo: false`. Por isso é seguro rodar mais de uma vez.
 *
 *   node --env-file=.env scripts/reenviar-replay-portal.ts --file alunos.json
 *   node --env-file=.env scripts/reenviar-replay-portal.ts --file alunos.json --execute
 *
 * Sem `--execute` nada é enviado. O arquivo é um JSON com
 * `[{ email, nome, edicao, origem }]`, gerado a partir das matrículas cuja
 * ordem contém um produto de replay.
 */

import { readFileSync, writeFileSync } from "node:fs";

function argumento(nome: string): string | null {
  const indice = process.argv.indexOf(`--${nome}`);
  return indice >= 0 && process.argv[indice + 1] ? process.argv[indice + 1] : null;
}

const arquivo = argumento("file");
if (!arquivo) throw new Error("Informe --file com o JSON dos alunos");
const executar = process.argv.includes("--execute");

const url = process.env.STUDENT_PORTAL_WEBHOOK_URL?.trim();
const token = process.env.STUDENT_PORTAL_MATRICULA_TOKEN?.trim();
if (!url || !token) throw new Error("STUDENT_PORTAL_WEBHOOK_URL e STUDENT_PORTAL_MATRICULA_TOKEN são obrigatórios");

interface Aluno {
  email: string;
  nome: string;
  edicao: string;
  origem: string;
}

const alunos = JSON.parse(readFileSync(arquivo, "utf8")) as Aluno[];
// O portal identifica pelo e-mail; um aluno com duas ordens vira um envio só.
const porEmail = new Map<string, Aluno>();
for (const aluno of alunos) {
  const email = aluno.email?.trim().toLowerCase();
  if (!email) continue;
  porEmail.set(email, { ...aluno, email });
}
const lote = [...porEmail.values()].map((aluno) => ({
  email: aluno.email,
  edicao: aluno.edicao,
  nome: aluno.nome,
  temReplay: true,
  origem: aluno.origem || "zouti",
}));

console.log(JSON.stringify({ recebidos: alunos.length, unicos: lote.length, modo: executar ? "execute" : "simulacao" }));
if (!executar) {
  console.log(JSON.stringify(lote.slice(0, 3), null, 2));
  console.log("Simulação: nada enviado. Repita com --execute.");
} else {
  const TAMANHO = 200;
  const resultados: unknown[] = [];
  for (let inicio = 0; inicio < lote.length; inicio += TAMANHO) {
    const parte = lote.slice(inicio, inicio + TAMANHO);
    const resposta = await fetch(new URL(url).toString(), {
      method: "POST",
      headers: { "content-type": "application/json", "x-matricula-token": token },
      body: JSON.stringify({ acao: "matricular", alunos: parte }),
      signal: AbortSignal.timeout(60_000),
    });
    const corpo = await resposta.json().catch(() => ({ erro: `http_${resposta.status}` }));
    if (!resposta.ok) throw new Error(`Portal recusou o lote (${resposta.status}): ${JSON.stringify(corpo).slice(0, 400)}`);
    const linhas = (corpo as { resultados?: unknown[] }).resultados ?? [];
    resultados.push(...linhas);
    console.log(JSON.stringify({ enviados: parte.length, acumulado: resultados.length }));
  }
  writeFileSync(`${arquivo}.resposta.json`, JSON.stringify(resultados, null, 2));
  const matriculados = resultados.filter((r) => (r as { matriculado?: boolean }).matriculado).length;
  const novos = resultados.filter((r) => (r as { novo?: boolean }).novo).length;
  console.log(JSON.stringify({ total: resultados.length, matriculados, novos, ja_existiam: resultados.length - novos }));
}
