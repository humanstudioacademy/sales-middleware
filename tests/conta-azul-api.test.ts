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
