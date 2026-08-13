import assert from "node:assert/strict";
import test from "node:test";

import { contaAzulReadPath } from "../supabase/functions/_shared/conta-azul-admin.ts";

test("allows only explicit Conta Azul read resources", () => {
  assert.equal(
    contaAzulReadPath(new URL("https://example.test?resource=financial_accounts&pagina=1")),
    "/v1/conta-financeira?pagina=1",
  );
  assert.equal(
    contaAzulReadPath(new URL("https://example.test?resource=next_sale_number")),
    "/v1/venda/proximo-numero",
  );
  assert.throws(
    () => contaAzulReadPath(new URL("https://example.test?resource=arbitrary")),
    /Unsupported/,
  );
});

test("aceita recurso por identificador somente com UUID válido", () => {
  assert.equal(
    contaAzulReadPath(new URL(
      "https://example.test?resource=financial_installments&id=247553d5-7bcf-46c9-9128-90acb1ba7bc1",
    )),
    "/v1/financeiro/eventos-financeiros/247553d5-7bcf-46c9-9128-90acb1ba7bc1/parcelas",
  );
  assert.throws(
    () => contaAzulReadPath(new URL("https://example.test?resource=sale_detail&id=../../admin")),
    /valid identifier/,
  );
  assert.throws(
    () => contaAzulReadPath(new URL("https://example.test?resource=sale_detail")),
    /valid identifier/,
  );
});
