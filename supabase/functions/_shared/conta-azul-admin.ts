export function contaAzulReadPath(input: URL): string {
  const resource = input.searchParams.get("resource") ?? "sales";
  const forwarded = new URLSearchParams(input.searchParams);
  forwarded.delete("resource");

  const paths: Record<string, string> = {
    sales: "/v1/venda/busca",
    sale: "/v1/venda",
    financial_accounts: "/v1/conta-financeira",
    categories: "/v1/categorias",
    people: "/v1/pessoas",
    products: "/v1/produtos",
    next_sale_number: "/v1/venda/proximo-numero",
    receivables: "/v1/financeiro/eventos-financeiros/contas-a-receber/buscar",
    installment: "/v1/financeiro/eventos-financeiros/parcelas",
    event_installments: "/v1/financeiro/eventos-financeiros",
  };
  let path = paths[resource];
  if (!path) throw new Error("Unsupported Conta Azul read resource");
  // Recursos endereçados por id: `?resource=installment&id=<uuid>`.
  const id = forwarded.get("id");
  if (id) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new Error("Invalid Conta Azul resource id");
    forwarded.delete("id");
    path = resource === "event_installments"
      ? `${path}/${encodeURIComponent(id)}/parcelas`
      : `${path}/${encodeURIComponent(id)}`;
  }
  const query = forwarded.toString();
  return query ? `${path}?${query}` : path;
}
