export type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

export function mapWebhookToContaAzulSale(body: unknown): JsonObject {
  const root = object(body);
  const data = object(root?.data);
  const candidate = object(root?.conta_azul_sale)
    ?? object(data?.conta_azul_sale)
    ?? root;

  if (!candidate) throw new Error("Webhook body is not a JSON object");
  const required = ["id_cliente", "numero", "situacao", "data_venda", "itens"];
  const missing = required.filter((field) => candidate[field] === undefined || candidate[field] === null);
  if (missing.length) {
    throw new Error(`Conta Azul mapping is incomplete; missing: ${missing.join(", ")}`);
  }
  if (!Array.isArray(candidate.itens) || candidate.itens.length === 0) {
    throw new Error("Conta Azul mapping requires at least one sale item");
  }
  return candidate;
}
