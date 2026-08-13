// Recursos por identificador, usados na conferência de venda e recebível. O id
// é validado como UUID para o parâmetro não virar caminho arbitrário na API.
const IDENTIFIED_PATHS: Record<string, (id: string) => string> = {
  sale_detail: (id) => `/v1/venda/${id}`,
  financial_installments: (id) => `/v1/financeiro/eventos-financeiros/${id}/parcelas`,
  installment_settlements: (id) => `/v1/financeiro/eventos-financeiros/parcelas/${id}/baixa`,
};

export function contaAzulReadPath(input: URL): string {
  const resource = input.searchParams.get("resource") ?? "sales";
  const forwarded = new URLSearchParams(input.searchParams);
  forwarded.delete("resource");

  const identified = IDENTIFIED_PATHS[resource];
  if (identified) {
    const id = forwarded.get("id")?.trim() ?? "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error("Conta Azul read resource requires a valid identifier");
    }
    forwarded.delete("id");
    const query = forwarded.toString();
    return query ? `${identified(id)}?${query}` : identified(id);
  }

  const paths: Record<string, string> = {
    sales: "/v1/venda/busca",
    financial_accounts: "/v1/conta-financeira",
    categories: "/v1/categorias",
    people: "/v1/pessoas",
    products: "/v1/produtos",
    next_sale_number: "/v1/venda/proximo-numero",
  };
  const path = paths[resource];
  if (!path) throw new Error("Unsupported Conta Azul read resource");
  const query = forwarded.toString();
  return query ? `${path}?${query}` : path;
}
