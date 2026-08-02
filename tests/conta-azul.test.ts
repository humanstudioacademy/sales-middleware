import assert from "node:assert/strict";
import test from "node:test";

import { decryptSecret, encryptSecret } from "../supabase/functions/_shared/crypto.ts";
import { mapWebhookToContaAzulSale } from "../supabase/functions/_shared/sale-mapper.ts";

const validSale = {
  id_cliente: "550e8400-e29b-41d4-a716-446655440000",
  numero: 1001,
  situacao: "EM_ANDAMENTO",
  data_venda: "2026-08-02",
  itens: [{ id: "550e8400-e29b-41d4-a716-446655440001", quantidade: 1, valor: 10 }],
};

test("maps an explicit Conta Azul sale envelope", () => {
  assert.deepEqual(mapWebhookToContaAzulSale({ conta_azul_sale: validSale }), validSale);
  assert.deepEqual(mapWebhookToContaAzulSale({ data: { conta_azul_sale: validSale } }), validSale);
});

test("accepts an already canonical sale payload", () => {
  assert.deepEqual(mapWebhookToContaAzulSale(validSale), validSale);
});

test("rejects an incomplete payload before any external call", () => {
  assert.throws(
    () => mapWebhookToContaAzulSale({ numero: 1001 }),
    /mapping is incomplete/,
  );
});

test("encrypts OAuth tokens with authenticated encryption", async () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const encrypted = await encryptSecret("refresh-token-value", key);
  assert.notEqual(encrypted.ciphertextBase64, "refresh-token-value");
  assert.equal(await decryptSecret(encrypted.ciphertextBase64, encrypted.ivBase64, key), "refresh-token-value");
  await assert.rejects(
    decryptSecret(encrypted.ciphertextBase64, encrypted.ivBase64, Buffer.alloc(32, 8).toString("base64")),
  );
});
